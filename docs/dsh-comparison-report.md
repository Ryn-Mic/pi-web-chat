# pi-web-chat × DeepSeek Harness(DSH)对比分析报告

> 主题:流式渲染与会话加载的依赖可替换性、优缺点、缺失项
>
> 分析日期:2025-08
> 分析对象:
> - `/Users/ryn/Documents/tmp/pi-web-chat`(pi-web-chat,版本 0.1.80,OpenWebUI 风格 pi coding agent Web UI)
> - `/Users/ryn/Documents/tmp/deepseek-harness`(DeepSeek Harness,DSH,monorepo)
>
> 性质:纯只读分析,分析过程中未修改任何项目文件。
>
> **复核状态(第二轮)**:已对全部可验证断言逐条回源核对。DSH 侧 18 项断言 16 项完全成立(含行号),2 项行号漂移;pi-web-chat 侧发现 **3 处核心性能判断需要修正**,优先级已重排。修正点在 §4.1 / §4.2 / §6 / §10 标注。
>
> **实施状态(pi-web-chat 0.1.84)**:§6 的 P0-P2 已落地。包括工具卡 memo/派生值缓存、流式期间停用 Shiki、序列化引用缓存、增量 snapshot、微任务/RAF 两级通知、JSONL 活动分支尾读与向前分页、append-aware 会话摘要索引、外部追加增量注入 runtime，以及 seq 重连补帧。0.1.84 进一步补齐完整快照的 active tool 恢复、runtime 分支/文件切换后的历史基线重置、跨 append UTF-8 解码和大型 JSONL 单行低复制反向读取。为保持 pi CLI 的完整上下文语义，冷会话会先发送尾页供浏览器首屏绘制，再在后台完成 SDK 全历史 runtime 恢复；没有改用 SQLite。

---

## 1. 执行摘要(三句话结论)

1. **DSH 没有能 `npm install` 过来直接用的替换包。** 它的流式渲染与会话加载优势来自 monorepo 内部实现(增量 markdown 解析器、事件溯源投影、SQLite 事件表),不是第三方库;`@deepseek-ai/dsh-*` 系列虽然 `publishConfig: public`,但全部依赖 cordis 插件框架 + dsh host 协议,脱离 DSH 运行时无法独立工作。**可移植的是实现模式与代码,不是依赖。**
2. **有一类"同款依赖不同用法"可以直接抄:** shiki 的"流式期间不高亮、settle 后一次性高亮"策略;以及 ws 的"单向 downlink + HTTP 上行"协议拆分(可选)。
3. **pi-web-chat 流式渲染慢的真实根因(经复核修正):** ① 每个 snapshot 事件都全量 `serializeMessages()`,服务端付 O(会话总字节) 的 CPU;客户端 `Message` memo 失效后,未 memo 的 `ToolCallCard` 对**全会话每个工具卡**重跑 `JSON.stringify(args)` + diff 构建;② 流式期间代码块每 delta 全块重新 tokenize(缓存 key 含全文,必 miss)。**注意:markdown 并不会被全量重解析**——`Markdown`/`Streamdown` 的 memo 以字符串按值命中,详见 §4.1。**会话加载慢的根因:** 全量读 JSONL(同步阻塞事件循环)+ 全量扫描会话目录 + 全量快照下发、无分页。

---

## 2. 两个项目的架构总览

### 2.1 pi-web-chat(现状)

```
浏览器 (React 19 + Vite + Tailwind 4)
  ├─ ChatClient (useSyncExternalStore 类实现)
  │    ├─ WebSocket 双向:上行 ClientCommand / 下行 ServerEvent
  │    ├─ delta 事件 100ms 合并 → streamText / streamThinking
  │    └─ snapshot 事件 → 全量替换 snapshot.messages
  ├─ MessageList → Message (memo) → Markdown (Streamdown 流式/静态)
  └─ @tanstack/react-query: /api/sessions、/api/tree、/api/git/* 等 REST

服务端 (Node HTTP + ws)
  ├─ @earendil-works/pi-coding-agent SDK (AgentSessionRuntime)
  ├─ session.subscribe → text_delta/thinking_delta → delta 事件
  ├─ message_end / tool_execution_end / agent_end → 全量 broadcastSnapshot
  ├─ serializeMessages(): AgentMessage[] → UIMessage[] (每次全量重建对象)
  └─ /api/sessions → SessionManager.listAll()(并发读所有会话文件全文)
```

### 2.2 DSH(对照)

```
浏览器 (React 18 + 自研 selector store)
  ├─ connection 层:HTTP POST 上行 RPC + 两条 downlink-only WebSocket 事件流
  │    (mux 流:所有会话的 session/event 帧;host 流:会话创建/删除/运行状态)
  ├─ runtime 层:SessionManager(实例集群)+ Session(每会话连续 seq 事件窗口)
  │    ├─ open = 拉尾页(50 条)+ installWindow + liveBuffer 缝合
  │    ├─ loadOlder = beforeSeq 向前翻页 + 连续性断言 + prepend
  │    └─ acceptLiveEvent = seq 去重/补洞 + ConversationNodeAssembler 增量投影
  ├─ Notifier:微任务批量 / RAF 每帧至多一次 / 无订阅者惰性重建
  ├─ ui 层:ChatNodeSeat 节点级 selector 订阅,只重渲染变化的节点
  └─ MarkdownText:IncrementalMarkdownParser 块冻结 + 尾部增量解析

服务端 (host / api-proxy)
  ├─ 每个 session/event 一帧推送(自带 seq,无差量编码)
  ├─ session/subscribed { lastSeq } 作为每代连接的 seq 基线
  ├─ history RPC:按消息数向前分页(chunk 经 sourceEventSeqs 归组不切断)
  └─ SQLite 持久化:events 表 + seq 主键 + revision + torn-tail 容错
```

---

## 3. 依赖逐项对比(含优缺点)

### 3.1 流式渲染相关

| pi-web-chat | DSH 对应 | 能否替换 | 优缺点 |
|---|---|---|---|
| `streamdown@2.5`(Vercel,Apache-2.0;块级切分 + `memo(Block)` + streaming 态 `useTransition` + remend 未闭合语法容错) | 自研 `IncrementalMarkdownParser`(`packages/client/ui-primitives/src/markdown/incremental.ts`)+ `render.tsx`,底层 micromark/mdast | ❌ **不建议移植**(复核修正) | ⚠️ 原报告高估了此项收益。反编译 `streamdown/dist/chunk-BO2N2NFS.js` 可见 Streamdown **已经在做 DSH 的块冻结**:`Block` 是带自定义比较器的 `memo`(`Tn=memo(..., (e,t)=>{if(e.content!==t.c...`),块列表走 `useMemo`,streaming 模式另套 `useTransition` 延迟提交。每次 flush 的实际开销 = remend 归一化 + 全文块切分(一道 lexer)+ **仅尾块重解析**,不是“完整 unified 管线跑全文”。移植 `incremental.ts` 与现有能力高度重叠,还会丢掉 remend 容错与社区维护 |
| `shiki@3.23` 流式期间就高亮(`src/lib/streamdownCode.ts` 按“全文”缓存,每 delta 都 miss → 整块反复 tokenize) | 同为 shiki,但:`shiki/core` + JS regex engine(无 oniguruma WASM)+ css-variables 主题;流式期间 `lang={undefined}` 渲染纯文本,settle 后一次性高亮(`highlight.ts` + `render.tsx:325`);boot 3 个语法 + 其余懒加载 | ⚠️ 可借鉴策略,但**实现位置不在插件内** | ✅ 消除流式期间最贵的高亮成本。❌ 流式过程中代码块无高亮,视觉略降级。**契约限制(复核发现)**:`HighlightOptions = { code, language, themes }`(`streamdown/dist/index.d.ts:104-108`)不携带任何 streaming 信号,插件内部拿不到流式态;靠模块级全局 flag 会误伤同屏渲染的已完成消息。正确做法是在调用点分流(见 §6 P0-2) |
| `react-markdown` / `remark-gfm` / `rehype-highlight`(devDependencies) | 不使用 | ✅ 可删除 | `src/` 中零引用,是遗留死依赖 |
| 状态管理:自写 useSyncExternalStore 类 + `@tanstack/react-query` | 自研 selector store(`bindSnapshotSelector`,`useSyncExternalStoreWithSelector`)+ Notifier | 不换(不是痛点) | pi 的 store 没有 selector 级订阅 → 流式/快照事件导致全列表重渲染;DSH 的 store 是"节点级订阅"的结构基础 |
| `ws`(双向) | 同为 `ws`,但单向 downlink(仅下行帧)+ HTTP RPC 上行;客户端向事件 socket 发消息会被 `close(1008, 'downlink only')` 拒绝(`websocket-downlink.ts:109-111`) | 协议层可选借鉴 | ✅ 下行管道更简单、无上行语义、背压可控。❌ 需额外维护 HTTP RPC 层;pi-web-chat 上行命令少,收益有限,建议不做 |

### 3.2 会话加载相关

| pi-web-chat | DSH 对应 | 能否替换 | 优缺点 |
|---|---|---|---|
| pi SDK JSONL 全量读(`SessionManager.open` → `loadEntriesFromFile` 用 `readSync` 循环,同步阻塞事件循环) | `node:sqlite`(Node 内置)events 表 + seq 主键 + revision 令牌 + torn-tail 容错(`packages/session/session-persistence-sqlite`) | ❌ 不建议换 | ✅ SQLite 支持 `seq >= fromSeq` 后缀 seek 读(复杂度随后缀长度而非全量日志)、元数据查询不扫文件、WAL 模式。❌ **会破坏与 pi CLI/终端的 JSONL 互操作**(会话文件 pi 终端仍在用),这是 pi-web-chat 不可承受的代价 |
| `/api/sessions` → `SessionManager.listAll()` 并发读所有会话文件全文 | SQLite sessions 元数据表 + 内存摘要 + `host/session-added/removed/status` 增量帧(`api-proxy.ts:3548-3564`,初版误写 1725-1785);冷会话按 `COLD_SUMMARY_BATCH_SIZE=16` 分批,小文件才探测 blank 位 | ⚠️ 模式可借鉴(服务端摘要索引),依赖不能换 | ✅ 列表查询 O(元数据)而非 O(所有会话字节数)。❌ JSONL 下需要自己维护摘要缓存(按 mtime 失效) |
| `session-query`(DSH) | FTS5 全文搜索索引 | 不需要 | 它是搜索索引不是列表查询,pi-web-chat 无此需求 |

### 3.3 值得移植的整段代码(优先级排序，已按复核修正)

1. `packages/client/runtime/src/client/sessions/notifier.ts`(103 行)——微任务/RAF 两级批量通知原语
2. `packages/client/runtime/src/client/ordered-baseline.ts`(43 行)——基线合并保序(重连/列表刷新用)
3. ~~`packages/client/ui-primitives/src/markdown/incremental.ts`(130 行)~~——**复核后下调/不建议**:Streamdown 2.5 已内置块冻结 + `memo(Block)` + `useTransition`,重叠度高

---

## 4. 流式渲染:根因定位(已到代码行)

### 4.1 根因一:快照风暴 → 全列表 React 重渲染 + 工具卡重算(已修正)

> **修正说明**:初版把本项定为“整条会话 markdown 全量重解析(最致命)”。回源核对后这条传导链**不成立**。

成立的部分:

- 服务端 `serializeMessages()`(`server/serialize.ts:36`)每次调用都**新建所有消息对象**,并对全会话做 ANSI 剥离/文本拼接 → 每个事件付一次 O(会话总字节) 的服务端 CPU + 网络载荷;
- `broadcastSnapshot()` 在 `server/index.ts` 共 **16 处**调用点(非初版列的 3 处):321、564、588、597、611、639(`message_end`)、651(`tool_execution_end`)、759、770、775、782、936、990、1228 等;`agent_end`(:656-661)走的是 `buildSnapshot` + 手写 `broadcast`,**并不调用 `broadcastSnapshot`**(初版写的 “:661” 对不上);
- 客户端 `Message`(`MessageList.tsx:385`,默认浅比较 memo)确实因对象身份变化而 miss → 全列表重渲染。

**不成立的部分(关键修正)**:重渲染并不会传到 markdown 解析层。

- `Message` 的子级是 `<Markdown key={i} text={b.text} />`(`MessageList.tsx:284`),`Markdown` 是 `memo`(`Markdown.tsx:35`),props 为 `{ text: string, streaming: boolean }` ——**全部是原语,字符串按值相等 → memo 命中,不重解析**;
- `components` / `plugins` 是模块级常量,引用稳定;`Streamdown` 自身也是 `memo`(`chunk-BO2N2NFS.js` 中 `Qs=memo(...)`),同样命中;
- `Thinking`(`MessageList.tsx:237`)虽未 memo,但它裸用的 `<Streamdown mode plugins>{text}</Streamdown>` props 同样稳定 → memo 命中。

**真正的客户端热点在工具卡**:`ToolCallCard`(`MessageList.tsx:128`)**没有 memo**,且每次重渲染无条件执行

- `JSON.stringify(block.args)`(:134)
- `buildEditDiffFromArgs(block.args)`(:136)
- `isUnifiedDiff(block.result.text)`(:159)

工具多的长会话里,每个 `tool_execution_end` 都把**全会话所有工具卡**的 args 重新 stringify、diff 重新构建一遍。这比“markdown 重解析”更具体、成本更低也更好修——给 `ToolCallCard` 加 memo + `useMemo` 包住 stringify/diff 即可。

### 4.2 根因二(已降级):流式文本每 100ms 的重解析成本被高估

> **修正说明**:初版称“每次 flush 把累积全文再跑一遍完整 unified 管线 → O(n²)”。实测 Streamdown 2.5 已自带块冻结。

- `src/lib/chat.ts` 的 100ms 合并节流本身是好的(`DELTA_FLUSH_MS = 100`,:148);
- 但 Streamdown 内部已经做了 DSH 那套块级冻结(反编译 `streamdown/dist/chunk-BO2N2NFS.js`):
  - `Block` 是带自定义比较器的 `memo`,比较 `content` 字符串 → **未变块直接 skip**;
  - 块列表由 `useMemo(()=>h(Se))` 计算;
  - streaming 模式另套 `useTransition` 延迟提交块列表更新;
- 所以每次 flush 的实际开销 = remend 归一化 + 全文块切分(一道 lexer,小常数)+ **仅尾块重解析**。仍然是每次 O(n),但不是“全文跑完整 unified 管线”;
- 结论:移植 DSH `incremental.ts` 的预期收益远低于初版判断,降为 P3 / 不做。同理,“P1-5 改用 React 19 `startTransition`”也部分冗余——Streamdown 流式态已内置 `useTransition`。

### 4.3 根因三(成立,流式期间最贵的一项):流式期间高亮代码块

- `src/lib/streamdownCode.ts` 的缓存 key 是 `` `${language}\u0000${code}` ``(:56),含全文 → 流式过程中每 delta 必 miss → 整块重新 tokenize;`MAX_CACHED_RESULTS = 48` 还会把旧结果挤出去;
- Streamdown 侧无任何门控:`highlighted-body-OFNGDK62.js` 里 `useEffect(..., [code, language, themes, ...])` 以 code 为依赖直接调 `highlighter.highlight(...)`,`isIncomplete` 只用于 `data-incomplete` 属性,**不参与是否高亮的判断**;
- DSH 的做法:流式期间 `lang={undefined}` 渲染纯文本,消息 settle 后一次性高亮(`render.tsx:325`,已逐字核对);
- ⚠️ **但不能按初版写的“在 `highlight` 里判 streaming 返回 null”实现**——详见 §6 P0-2。

### 4.4 根因四:无节点级订阅

- DSH 的 `ChatNodeSeat` 用 selector(`snapshot.chat.nodes.get(nodeKey)`)**只重渲染正在流的那个节点**(`ChatNodeSeat.tsx` + `bind.ts` 的 `useSyncExternalStoreWithSelector`);
- pi-web-chat 是整棵 `MessageList` 重渲染,靠 memo 兜底;
- **前提**:快照顶层换引用、子结构引用稳定(`chat-snapshot-builder.ts` 的 `MutableChatNodeStore`)——这正是 pi-web-chat 缺失的先决条件。

### 4.5 DSH 的对照设计(全部有源码依据)

| 机制 | 文件 | 说明 |
|---|---|---|
| 块级不可变累加 | `packages/client/runtime/src/client/sessions/partial.ts` | `block-start/text-delta/reasoning-delta/tool-call-delta/block-end` 折叠为 AssistantBlock[],只换变化的块引用 |
| 两级批量通知 | `packages/client/runtime/src/client/sessions/notifier.ts` | 微任务合并(markDirty)/ 每帧至多一次(markFrameDirty)/ 无订阅者惰性重建 / notifyNow 同步冲刷 |
| 发布节奏分级 | `packages/client/ui-trajectory/src/client/trajectory-assistant-definition.ts:336-340` | `step/start → 'none'`;非 chunk 事件(含 `assistant/message`、`step/end`)→ `'immediate'`;其余可见 chunk → `'animation-frame'`,但 `usage`/`finish` chunk 也是 `'none'` |
| 增量 markdown 解析 | `packages/client/ui-primitives/src/markdown/incremental.ts` + `MarkdownText.tsx` | 冻结前 N-2 个块、缓存 React 元素、offset 稳定 key;footnote 等跨块状态从副本续算;settle 后整体切换完整解析 |
| 流式期间不高亮 | `render.tsx:325` | `lang={context.streaming ? undefined : lang}`;高亮器单例预热(boot 3 语法)+ 懒加载其余(`highlight.ts`) |
| 滚动跟随 | `ChatView.tsx` + `use-throttled-visual-update.ts` | followSig/atBottomRef/anchorRef 区分"自己的词到达"vs"用户滚动";rAF 帧节流 |

---

## 5. 会话加载:根因与对照

| 环节 | pi-web-chat(现状) | DSH |
|---|---|---|
| 打开会话 | `switchSession(path)` **同步读整个 JSONL**(`loadEntriesFromFile` 用 `readSync` 循环,**阻塞服务端事件循环**),并**整体重建 runtime**(services 全建、扩展重绑),然后全量快照下发 | `sessions.history` RPC **只拉尾页 50 条**(`PAGE_MESSAGES`),`installWindow` → `openState: cold→loading→open`,**首屏延迟与历史长度无关**;`hasMore` + `loadOlder(beforeSeq)` 向上翻页,prepend 有连续性断言 |
| 实时事件 | session.subscribe → 每次全量 `broadcastSnapshot` | mux 帧逐个 `session/event` 推,自带 seq;`acceptLiveEvent` 按 seq **去重/补洞**(gap → liveBuffer + `repairGap` 重拉尾页) |
| 断线重连 | 重连 → 重新全量快照(丢中间态,无对齐) | **无 since 续传(v1 未实现)**:重开流 + `session/subscribed.lastSeq` 基线 + 每会话 `resync()` 整窗重建 + liveBuffer 缝合(`events.ts:53-54` 明确 "unimplemented in v1") |
| 会话列表 | `/api/sessions` → `SessionManager.listAll()` **并发读所有会话文件的每一行**(O(所有会话字节数),每次开抽屉都全扫) | 不扫文件:SQLite 元数据行/内存摘要 + 增量帧;`session-query` 是 FTS5 搜索索引(不是列表查询) |
| 外部追加(终端里另开 pi) | 1.5s 轮询 stat+行数 → 检测到追加就**整个 runtime dispose 重建** + 全量快照(内存态、流式态全丢) | 不存在此问题:host 是唯一写入方,客户端只消费事件流 |
| 服务端分页边界 | 无 | `paginate`(`api-proxy.ts:283-313`):从尾部**向前数消息数**,chunk 经 `sourceEventSeqs` 归组,**绝不在消息中间切断**;`cut` = 最老消息组起始 seq |

### 5.1 对 pi-web-chat 的直接启示

- 若要"尾部增量",核心是**单调 seq 事件日志 + 客户端窗口**;若保持"全量快照",则需引入版本号/游标才能在重连时对齐。
- DSH 的 seq 机制可借鉴:seq 同时承担去重(`seq <= tail` 丢弃)、gap 检测(`seq > tail+1` 触发补拉)、排序键三重职责,不依赖服务器差分。
- JSONL 是 append-only,服务端实现"尾读 N 个完整 entry"很容易;**分页边界必须按完整 entry 对齐**(JSONL 一行一个 entry,天然满足,但 pi 的 message 内容可能含多行 JSON 转义,需以"解析后的完整 entry"计数)。

---

## 6. 当前项目还缺了什么(按优先级，已经复核重排)

### P0 —— 改动小、收益最大

1. **`ToolCallCard` 加 memo + 缓存派生计算**(新增,原报告遗漏):给 `ToolCallCard`(`MessageList.tsx:128`)包 `memo`,并用 `useMemo` 包住 `JSON.stringify(block.args)`、`buildEditDiffFromArgs`、`isUnifiedDiff`。**这是真正命中每快照开销的一刀,改动面最小。**
2. **流式期间停止高亮代码块**——实现位置**必须在 Streamdown 调用点**,不能在插件内:
   - 插件契约 `HighlightOptions = { code, language, themes }`(`streamdown/dist/index.d.ts:104-108`)**不携带 streaming 信号**,`highlight` 拿不到流式态;
   - 若改成模块级全局 flag,会**误伤同屏渲染的已完成消息**——`MessageList` 是“静态 Message 列表 + 流式 `<Markdown streaming>`”同时挂载的(:503-521);
   - 可落地写法:`<Streamdown plugins={streaming ? undefined : streamdownPlugins}>`,或者覆盖 `components.code`。注意 `Markdown.tsx` 和 `MessageList.tsx:262`(Thinking)两个调用点都要改。

### P1 —— 中等工作量

3. **服务端快照引用稳定化**(从 P0 降级):给 `serializeMessages` 加按 `(sessionFile, message 序号)` 的缓存。收益理由修正为——**省服务端 CPU 与 WebSocket 载荷**(每个事件原本要对全会话重建对象 + ANSI 剥离),而**不是**“让客户端 memo 生效从而避开 markdown 重解析”(那条传导链不成立,见 §4.1)。
4. **增量快照协议**:snapshot 事件改为只携带变更(如 `fromSeq` 之后的新消息),而不是全量消息数组。依赖第 3 项的缓存结构。
5. **渲染节流分级**(部分冗余):Streamdown 流式态已内置 `useTransition`,只剩下“状态事件微任务 / 流式事件 RAF”两档合并还值得做(借鉴 `notifier.ts`)。

### P2 —— 会话加载(论证成立,优先级不变)

6. **服务端分页**:打开会话时不经过 SDK 全量 `open`,直接读 JSONL **尾部 N 个完整 entry**;`loadOlder` 用偏移往前读。
7. **会话列表摘要索引**:服务端维护会话元数据缓存(各文件头部 + 尾部摘要,按 mtime 失效),`/api/sessions` 走索引,不每次全扫。
8. **事件 seq 对齐**:给 delta/snapshot 事件加 seq,重连后凭 seq 丢弃重叠、发现缺口时请求补拉,而不是全量重来。
9. **降低外部追加的重建代价**:`reloadEntry`(`server/index.ts:299`)现在是 `dispose()` + 整个 runtime 重建 + 扩展重绑;1.5s 轮询已经有 stat 短路(:338-352),但一旦命中仍然全量 `countFileEntries` 读文件。

### P3 —— 不建议

10. 事件溯源投影(`conversation-assembler.ts` 那套)、SQLite 持久化、节点级 selector store。这些是 DSH 为多客户端/子代理/恢复设计的,pi-web-chat 单机场景用 P0–P2 就能解决 90% 的不满意。
11. 移植 `incremental.ts` 增量 markdown 解析器——**从 P1 降到这里**,Streamdown 2.5 已覆盖(见 §4.2)。

---

## 7. 落地映射表(DSH 机制 → pi-web-chat 形态)

| DSH 机制(文件) | 移植到 pi-web-chat 的形态 | 优先级 |
|---|---|---|
| —(pi-web-chat 自有问题,DSH 无对应物) | `ToolCallCard` 加 `memo`,`JSON.stringify(args)` / `buildEditDiffFromArgs` / `isUnifiedDiff` 用 `useMemo` 包住 | **P0** |
| 流式期间不高亮(`render.tsx:325`) | **在 Streamdown 调用点**分流:`plugins={streaming ? undefined : streamdownPlugins}`(`Markdown.tsx` + `MessageList.tsx:262` 两处)。不可改在 `streamdownCode.ts` 的 `highlight` 内——契约无 streaming 信号,全局 flag 会误伤静态消息 | **P0** |
| 稳定引用契约(`chat-snapshot-builder.ts` 的 `MutableChatNodeStore`)| 服务端按 `(sessionFile, entryIndex)` 缓存序列化后的 `UIMessage`。目标是省服务端 CPU/载荷,不是避开 markdown 重解析 | **P1** |
| Notifier 三档节流(`notifier.ts`) | `chat.ts` 从固定 100ms 合并改为“状态事件微任务、流式事件 RAF”两档 | **P1** |
| 尾页 50 条 + `loadOlder(beforeSeq)`(`session.ts:32, 377-405`) | 服务端自实现 JSONL 尾读(读文件尾部 N 个完整 entry,不经过 SDK 全量 `open`)+ `beforeSeq` 翻页接口 | **P2** |
| seq 三重职责(`session.ts:646`) | 给 `delta`/`snapshot` 事件加单调 seq;重连后客户端凭 seq 丢弃重叠、发现缺口时请求补拉 | **P2** |
| 列表不扫文件(`api-proxy.ts:3548-3564` 增量帧 + `:134` `COLD_SUMMARY_BATCH_SIZE`) | 服务端维护会话摘要索引(读各文件头+尾,带 mtime 缓存),`/api/sessions` 走索引 | **P2** |
| 增量解析冻结块(`markdown/incremental.ts`) | ~~文本前缀命中缓存~~ —— Streamdown 2.5 已内置 `memo(Block)` + `useTransition`,重要度降至 P3 | ~~P1~~ → P3 |
| downlink-only WS + HTTP 上行(`websocket-downlink.ts:109-111`) | 保持双向 WS 即可,不必改(上行命令少,不值得拆) | 不做 |

---

## 8. 关键事实核对表(带源码依据)

| 事实 | 依据 |
|---|---|
| pi 的 `SessionManager.listAll()` 并发读所有会话文件全文 | `node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js`(`buildSessionInfo` 逐行 `createReadStream` 读完整文件) |
| pi 的 `loadEntriesFromFile` 用 `readSync` 循环同步读整个 JSONL | 同上(`openSync` + `readSync` 循环) |
| pi-web-chat 每个 tool_execution_end/message_end 都全量 broadcastSnapshot;共 16 处调用点 | `server/index.ts:321, 564, 588, 597, 611, 639, 651, 759, 770, 775, 782, 936, 990, 1228`。⚠️ `agent_end`(:656-661)走 `buildSnapshot` + 手写 `broadcast`,**不**调 `broadcastSnapshot`——初版写的 “:661” 对不上 |
| pi-web-chat 快照消息对象每次全量新建(引用不稳定) | `server/serialize.ts:36` `serializeMessages`;`server/index.ts:446` `buildSnapshot` 每次调用 |
| ⚠️ **修正**:快照风暴**不会**引起 markdown 重解析 | `Markdown.tsx:35` `memo`,props 为 `{text: string, streaming: boolean}` 全原语 → 按值命中;`components`/`plugins` 为模块级常量;`Streamdown` 自身也是 `memo`(`chunk-BO2N2NFS.js` 中 `Qs=memo(...)`) |
| ⚠️ **新增**:`ToolCallCard` 无 memo,每次重渲染重算派生值 | `src/components/MessageList.tsx:128`(无 memo)、`:134` `JSON.stringify(block.args)`、`:136` `buildEditDiffFromArgs`、`:159` `isUnifiedDiff` |
| ⚠️ **修正**:Streamdown 2.5 已内置块冻结,非“全量 unified 管线” | `streamdown/dist/chunk-BO2N2NFS.js`:`Tn=memo(..., (e,t)=>{if(e.content!==t.c...` (Block 自定义比较器);块列表 `useMemo(()=>h(Se))`;streaming 态 `useTransition` |
| pi-web-chat 流式文本 100ms 合并 | `src/lib/chat.ts:148` `DELTA_FLUSH_MS = 100` |
| ⚠️ **新增**:高亮插件契约不携带 streaming 信号 | `streamdown/dist/index.d.ts:104-108` `HighlightOptions = { code, language, themes }`;`:126` `highlight(options, callback?)` |
| pi-web-chat 流式期间每 delta 重新 tokenize 整块 | `src/lib/streamdownCode.ts:56` cacheKey 含全文、`:8` `MAX_CACHED_RESULTS = 48`;`streamdown/dist/highlighted-body-OFNGDK62.js` 以 code 为 `useEffect` 依赖直接调 `highlight` |
| `react-markdown`/`remark-gfm`/`rehype-highlight` 在 `src/` 零引用(仅注释提到) | `package.json:99-101`(均在 devDependencies);`src/components/Markdown.tsx:30` 仅为注释 |
| DSH 尾页 50 条 + loadOlder | `packages/client/runtime/src/client/sessions/session.ts:32`(`PAGE_MESSAGES = 50`)、`:377-405`(初版写 377-410,实际 377-405) |
| DSH 服务端分页按消息数切页、chunk 不切断 | `packages/host/apiproxy/src/api-proxy.ts:283-313`(paginate) |
| DSH seq 三重职责(去重/补洞/排序) | `session.ts:646` 注释 "seq is the sole dedup key";`conversation.ts:281` "seq is the React key" |
| DSH 重连无 since 续传 | `packages/host/apiproxy/src/api/events.ts:53-54`(初版写 54-55,偏 1 行) |
| DSH 每事件一帧推送、无差量编码 | `api-proxy.ts:3475-3493`(`ctx.on('session/event')`→`queue.push(frame({type:'session/event',...}))`) |
| DSH 流式期间不高亮 | `packages/client/ui-primitives/src/markdown/render.tsx:325` |
| DSH 增量块冻结解析 | `packages/client/ui-primitives/src/markdown/incremental.ts` |
| DSH 微任务/RAF 两级节流 | `packages/client/runtime/src/client/sessions/notifier.ts` |
| DSH 节点级订阅 | `packages/client/ui-conversation/src/client/chat/ChatNodeSeat.tsx` + `web-react/src/bind.ts` |
| DSH SQLite 后缀 seek 读 | `packages/session/session-persistence-sqlite/src/index.ts:225-238`(`loadStoredFrom`) |
| DSH downlink-only WS | `packages/client/connection/src/websocket-downlink.ts:109-111`(`websocket.close(1008, 'downlink only')`) |
| DSH 使用 React 18(非 19) | 66 个 `packages/*/*/package.json` 均钉 `"react": "^18.2.0"`;安装解析为 `react@18.3.1` |
| ⚠️ **修正**:DSH host 增量帧位置 | 实际在 `api-proxy.ts:3548`(`host/session-added`)、`:3558`、`:3561`;`COLD_SUMMARY_BATCH_SIZE = 16` 在 `:134`,分批循环在 `:1743`。初版写的 1725-1785 只覆盖分批循环,增量帧差约 1800 行 |
| ⚠️ **修正**:DSH 发布节奏分级范围 | `trajectory-assistant-definition.ts:336-340`(非 336-341)。实际是按 chunk 可见性分派,且 `usage`/`finish` chunk 也是 `'none'`——初版漏写这一条 |
| pi SDK `buildSessionInfo` 读到文件尾、无提前 break | `session-manager.js:382-455`(`for await (const line of rl)` 全程无 break) |
| pi-web-chat 外部追加检测与重建 | `server/index.ts:338-367`(1.5s 轮询,已有 stat 短路)、`:299-324`(`reloadEntry` 整个 runtime dispose + 重建 + 扩展重绑) |

---

## 9. 建议的落地路径(已按复核重排)

1. **先做 P0-1(`ToolCallCard` memo + 派生值 `useMemo`)**:改动面只在 `src/components/MessageList.tsx` 一处,约 1 小时。它直接消除“每次 tool_end 全会话工具卡重算”——这才是快照风暴的真正客户端成本。
2. **P0-2(流式期间不高亮)**:在 `Markdown.tsx` 与 `MessageList.tsx:262` 两个 Streamdown 调用点按 `streaming` 分流 `plugins`,约 1 小时。切记不要在插件内用全局 flag。
3. 验证效果后再做 P1(服务端序列化缓存 + 增量快照协议 + 两档节流),最后视需要做 P2(分页加载 + 摘要索引 + seq 对齐 + 降低 reloadEntry 代价)。
4. 不再把“移植 DSH `incremental.ts`”当作流式渲染优化项——先把 P0 两刀做完再实测,很可能已经够了。

> 实施提醒:按 `AGENTS.md` 项目规则,任何改动落地时需 bump patch 版本(同步 `package.json` 与 `package-lock.json`)并在 `release-notes.json` 对应版本下补充用户可见描述;TypeScript 改动后运行 `npm run typecheck`。

---

## 10. 复核记录(第二轮)

方法:pi-web-chat 侧逐文件读源码 + 反编译 `node_modules/streamdown/dist`;DSH 侧派 subagent 对 18 项断言逐一回源核行号。

### 结论分布

| 类别 | 数量 | 说明 |
|---|---|---|
| 完全成立 | 大多数 | DSH 的文件/行号引用几乎全部可复现;pi 侧 SDK 同步读、`listAll` 全扫、devDependencies 死依赖、轮询重建均成立 |
| 需修正(根因层) | 3 | §4.1 传导链错(memo 按值命中)、§4.2 高估(Streamdown 已有块冻结)、P0-2 不可落地(插件契约无 streaming 信号) |
| 行号/细节漂移 | 5 | `server/index.ts:661`、`api-proxy.ts:1725-1785`、`events.ts:54-55`、`session.ts:377-410`、`trajectory-assistant-definition.ts:336-341` |
| 遗漏项 | 2 | `ToolCallCard` 无 memo 且重算派生值(已提为 P0-1);`broadcastSnapshot` 实际 16 处调用点 |

### 不变的结论

报告的整体结构、依赖可替换性判断(无包可换、可抄的是模式不是依赖)、以及 §5 会话加载那一节的根因分析都经得起核对,本轮未改动。修正集中在流式渲染这一章的因果链与优先级。
