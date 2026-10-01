# Agent Note: 长会话的请求与渲染开销分层优化

Status: implemented

## Problem

会话越长、刷新越频繁，下列三层重复开销越明显（刻度的每帧布局读取已由 [提问刻度 Nav Note](../feature/2026-10-01-timeline-ticks-navigation.md) 处理）：

1. **服务端问题索引每次全量重算**：`GET /api/sessions/:id/anchors` 每次请求都走一遍整条活动分支（`createSessionUserMessageAnchors(manager.getBranch())`）；会话未加载在内存时还要先 `SessionManager.open(path)` 全量解析 JSONL。打开提问浮层、打开全量大纲、跨页跳转各触发一次。
2. **客户端整个 store 被 11 个组件订阅**：`useChat()` 返回整个 state，而 store 每次 `update()` 都换新对象；流式 flush 只改 `streamText` / `streamThinking` / `streamThinkingComplete`，却让 `ChatPage`、`Composer`、`ModelMenu`、`SettingsMenu`、`SessionsDrawer`、`FileTreePanel`×2、`FileWorkspaceSidebar`、`CodexInteractionHost`、`ExtensionUIHost`、`ForkDialog` 全部重渲染（上限约 10 次/秒，delta 已按 rAF + 100ms 合并）。
3. **后台轮询按固定短周期跑**：Git 面板打开期间每 5s 跑一次 `git status`（服务端 spawn 进程）；Codex observer 空闲时仍每 2s 发一次 `thread/resume` + `thread/turns/list`（两个 RPC）。

## Decision

**服务端索引缓存（精确失效，不引入 TTL）**：`server/session-anchors.ts` 新增 `createSessionAnchorCache()`，以会话文件的 `(mtimeMs, size)` 为戳缓存 anchors 数组；命中时既不遍历分支也不打开会话。已加载会话的唯一写入者就是追加消息（Web UI 没有分支切换入口），所以文件戳是精确失效键；LRU 上限 64。Codex 线程没有等价的文件戳（要拿到末端必须分页 RPC），因此**不缓存**，保持每次读取的正确性优先。

**客户端按字段订阅**：`src/lib/chat.ts` 新增 `useChatField(key)` 与 `useChatPick(keys)`（浅比较、按 state 身份缓存选中值，避免 `useSyncExternalStore` 拿到每次都新建的对象而无限重渲染）。约定：`useChat()` 保留为逃生口并标注“会随每个流式 flush 重渲染”；能用字段就用字段；需要多个字段时用 `useChatPick` + 模块级 key 数组。`ChatPage` 只订阅粗粒度字段（`CHAT_PAGE_KEYS` 明确排除 4 个流式字段），`MessageList` 自己订阅这 4 个字段；`MessageTimelineTicks` 加 `memo`（它的 props 在流式刷新期间不变）。

**跳转与贴底解耦**：刻度跳转前调用 `onAnchorJump`，让消息区把 `stickToBottom` 置否——贴底时的自动跟随会在跳转动画期间把容器写回底部，取消跳转并让高亮与视图分离。

**后台轮询按活跃度分级**：`useGitStatus` 从 5s 放宽到 15s（窗口聚焦自动刷新，提交/暂存/检出等变更路径本就走 `useInvalidateGit` 显式失效，轮询只兜外部改动）。Codex observer 由固定 `setInterval` 改为每次 tick 自调度 `setTimeout`：有活跃 turn 时 2s（保持镜像实时性），空闲时 5s，读取失败时仍按 2s 快速重试。

## Alternatives considered

- **服务端 anchors 用 TTL 缓存** — 否决：新提问后可能返回过期索引，刻度会缺一条或整体错位，正是此前修过的“位置对应偏差”同类问题。
- **Codex anchors 也缓存（TTL 或显式失效）** — 否决：没有便宜的线程版本戳，TTL 会把“刚发完提问就打开大纲”变成缺新提问；显式失效需要把 prompt 路径与缓存耦合，收益（主要是 Codex 观察模式）不值这个耦合。若将来需要，先做一次 `thread/items/list` 取末端 id 作为戳。
- **引入选择器库或把 store 拆成多个分片 store** — 否决：4 个流式字段与其余粗粒度字段的边界已经够用，`useChatPick` 约 20 行即可覆盖，不值得新增依赖或改造 store 形状。
- **给历史轮次做列表虚拟化** — 否决：刻度判定依赖真实布局（见被否决的离屏跳过方案）。
- **外部会话同步的 1.5s stat 轮询改退避** — 有意不改：它是“外部 pi CLI 写入被镜像进 Web”的延迟预算，1.5s 一次本地 `stat` 的成本在微秒级，而退避会把外部输入/流式的可见延迟拉到十几秒。该循环已经跳过没有客户端的会话。
- **用 `fs.watch` 替代外部同步轮询** — 暂不做：跨平台的事件合并、重复与丢失需要一整套回退路径，风险大于收益。

## Consequences

- **收益**：打开提问浮层/全量大纲不再重扫分支（未加载会话连解析都省掉）；流式刷新不再牵动页面外壳、面板与编辑器输入框；后台轮询从“固定短周期”变为“按活跃度”。
- **代价**：anchors 缓存的有效性依赖“已加载会话只追加写入”这一前提（新增分支切换能力时必须同时接入缓存失效）；订阅粒度成为约定，新增组件若图方便直接用 `useChat()` 会把重渲染问题带回来（hook 注释里写明）；Codex 观察模式仍承担每次分页读取的成本。
- **验证**：
  - `npm test` 428 项（新增 `tests/session-anchors.test.ts` 的缓存用例：stamp 变化重建、命中返回同一数组、容量上限；原文件既有 5 项 Codex/预览用例保留）；
  - `npx playwright test` 44 项通过；
  - **渲染计数探针**（临时给 `ModelMenu`/`Composer` 加计数器，40 轮会话 + 8 次间隔 180ms 的 delta）：`ModelMenu` 与 `Composer` 各重渲染 0 次；把 `ModelMenu` 临时改回 `useChat()` 后 `ModelMenu` 变为 8 次（每个 flush 一次）而 `Composer` 仍为 0——同一探针同时证明改动前的问题与改动后的效果；
  - `npm run typecheck`、`npm run notes:check`、`npm run pack:check`、`git diff --check` 通过；
  - 未验证边界：Codex 观察模式的真实外部写入延迟（依赖其上游 RPC），以及真机耗电。
