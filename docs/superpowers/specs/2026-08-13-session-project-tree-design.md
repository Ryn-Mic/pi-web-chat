# 会话项目目录树 + Composer @ 文件引用设计（2026-08-13）

## 目标

1. **目录树**：在 Web UI 中展示当前打开会话所处项目的目录树——入口在会话页右上角"+"左侧（桌面为右侧 docked 面板、移动为右侧抽屉），懒加载浏览项目目录，点击文件把 `@相对路径` 插入输入框（Composer）。
2. **@ 文件引用**：Composer 中输入 `@` 触发文件选择器，`@` 后继续输入即为模糊搜索（对齐 pi TUI 的官方约定："Type `@` to fuzzy-search project files"），选中后插入 `@相对路径`。

## 决策（默认值，用户反馈已纳入）

| 决策点 | 选择 | 备选（未采用原因） |
|--------|------|---------------------|
| 树布局 | **头部入口 + 右侧树面板**：会话页右上角"+"左侧放切换按钮；桌面（≥md）切换右侧 docked 面板，移动（<md）打开右侧 overlay 抽屉 | 侧栏标签页（用户否决）；ProjectBadge 弹出（空间局促） |
| 多 tab 行为 | 树跟随**活跃 tab** 的项目（机制天然支持，见下节） | 同时展示所有 tab 的树（信息过载，YAGNI） |
| 点击文件 / @ 选中 | 插入 `@相对路径` 到 Composer 光标处并聚焦 | 纯浏览（价值低）；附带文件内容（后续迭代，见"明确不做"） |
| 目录过滤 | 硬排除 `.git`/`node_modules` + 根 `.gitignore`（新增 `ignore` 依赖） | 仅硬编码（误显被忽略文件）；不解析嵌套 .gitignore（YAGNI） |
| 加载方式 | 树：单层懒加载；@ 搜索：服务端遍历索引 + 短 TTL 缓存 | 全量树（大项目 payload 不可控） |
| 刷新 | 手动刷新按钮 + 面板激活时拉取；@ 索引 5 秒 TTL 自动过期 | FS 监听（复杂度高，YAGNI） |
| 隐藏文件 | 显示（开发者工具，同 VS Code 默认） | — |
| 符号链接目录 | 不穿透、不可展开、不进搜索索引（防环） | — |
| 引用格式 | `@相对路径` 纯文本（pi CLI/TUI 约定；agent 的 read/bash 工具以会话 cwd 为根可直接解析） | 附带文件内容（涉及大小上限/二进制/图片，后续迭代） |

## 多 tab 架构事实（已核实）

`SessionWorkspace`（`src/lib/session-workspace.ts`）为**每个 tab 维护一个独立的 WS client**；`ChatWorkspaceClient.state` / `useChat()` 恒返回**活跃 tab** 的状态。因此：

- `snapshot.cwd` 恒为活跃 tab 会话的项目目录 → 树与 @ 搜索的根**自动跟随 tab 切换**（React Query key 含 cwd）。
- 展开状态按 cwd 持久化 → 切回某项目的 tab 时恢复其树的展开形态。
- 两个 tab 同属一个项目 → 共享同一棵树与同一份展开状态（合理）。
- 后台 tab 的 streaming 不影响树（树只看活跃 tab）。

结论：多 tab 场景**可以**正常显示，无需额外机制；规格各处"snapshot.cwd"均指活跃 tab。

## 架构与组件

### 服务端

**`server/files.ts`（新，可独立测试）** —— 目录列举与文件搜索共用过滤/遍历原语

```
listDir(root, rel) → { nodes: UITreeNode[], truncated }     // 单层
searchFiles(root, query, limit) → UIFileMatch[]             // 全项目遍历 + 过滤
```

共享规则：
- 过滤：`.git`、`node_modules` 硬排除；root 存在 `.gitignore` 时用 `ignore` 包编译并应用（仅根级，不递归嵌套）。
- 符号链接：`lstat`，链接目录不下钻、不入索引。
- 安全：`resolve(root, rel)` 必须等于 root 或位于 root 内（`startsWith(root + sep)`）；拒绝绝对路径形式的 rel。

`listDir` 专有：
- 排序：目录优先，同类按 name 大小写不敏感。
- 上限：单目录最多 1000 条，超出 `truncated: true`。
- 子目录 EACCES：该节点 `hasChildren: false, inaccessible: true`，不使整个请求失败。

`searchFiles` 专有：
- 深度优先遍历收集 `{ name, path, type }`（文件与目录都入索引——目录也可被引用）；遍历总量兜底上限 100_000 条，超出停止并标记 `partial: true`。
- 匹配（大小写不敏感）：`basename 前缀` > `basename 子串` > `路径子串`；同级短路径优先；返回前 `limit`（默认 50）。
- 空 query：退化为根层列举（目录优先，cap 20）——"@ 后尚未输入"的初始态。
- 按 cwd 缓存遍历结果，TTL 5 秒（进程内 Map；击键间命中缓存，TTL 到期自然拿到新文件）。

**`server/index.ts`（新增两个端点，约 70 行）**

```
GET /api/tree?cwd=<项目路径>&path=<相对路径>   → UITreeResponse
GET /api/files/search?cwd=<项目路径>&q=<查询>&limit=<n> → UIFileSearchResponse
```

- 均走既有 `/api/*` token 鉴权。
- **cwd 校验（防任意读盘，两端点共用）**：cwd（展开 `~` 后）必须命中已知项目集合——已加载 entry 的 `runtime.cwd` ∪ `SessionManager.listAll()` 的会话 cwd ∪ `AGENT_CWD`；不命中 → 403。`listAll()` 结果按 3 秒 TTL 缓存（沿用 `gitBranchCache` 模式）。
- root 不存在/非目录 → 404 `{ error }`；path 逃逸或 rel 指向文件 → 400。

**`shared/protocol.ts`（+~35 行）**

```ts
export interface UITreeNode {
  name: string;
  /** 相对项目根（POSIX 分隔符） */
  path: string;
  type: "dir" | "file";
  /** 目录是否含可展示子项（决定是否渲染展开箭头） */
  hasChildren?: boolean;
  /** 无权限访问的目录 */
  inaccessible?: boolean;
}

export interface UITreeResponse {
  /** 项目根，~-缩写（展示用） */
  root: string;
  /** 本次返回的相对目录（"" = 根） */
  path: string;
  nodes: UITreeNode[];
  truncated?: boolean;
}

export interface UIFileMatch {
  name: string;
  path: string;
  type: "dir" | "file";
}

export interface UIFileSearchResponse {
  root: string;
  query: string;
  matches: UIFileMatch[];
  /** 遍历触及总量上限，结果可能不全 */
  partial?: boolean;
}
```

### 前端

**头部入口 + 双宿主面板**
- `ChatPage` 头部：在"+"（新建会话）按钮**左侧**新增文件树按钮（folder 图标，`size-9` 圆角按钮，样式对齐"+"按钮）。
- 桌面（≥md）：按钮切换右侧 docked 面板 `FilesSidebar`——`<aside class="hidden md:flex w-64 bg-sidebar">` 作为 flex 兄弟挤压聊天区（镜像左侧 `SessionsSidebar` 的布局位）；开关状态持久化 localStorage（`pi-web-chat:files-panel-open`），按钮 `aria-pressed` 反映状态。
- 移动（<md）：按钮打开右侧 overlay 抽屉 `FilesDrawer`——base-ui Dialog，镜像 `SessionsDrawer`（`inset-y-0 right-0`、`w-[82vw] max-w-xs`、translate-x 进出场动画、safe-area 处理）。另加**右缘左滑手势**打开抽屉：`useEdgeSwipe` 泛化出右缘变体（参数化 edge），经 `src/lib/drawer.ts` 同模式的事件总线（新增 `requestOpenFilesDrawer`/`onRequestOpenFilesDrawer`）触发。
- 桌面面板开关与移动抽屉是两个独立状态，互斥于 md 断点两侧；跨断点 resize 不做状态迁移（各自保持，无碍）。
- 与会话侧栏的 pin/dock 流程**有意不同**：文件面板无中间态（桌面点按钮直接 dock/关闭，一次点击到位），不为桌面提供 overlay 形态（YAGNI）。
- `SessionsPanel` 不加标签切换，侧栏保持纯会话列表。

**`src/components/FileTreePanel.tsx`（新，~200 行）** —— 树内容组件，被 `FilesSidebar` 与 `FilesDrawer` 两种宿主复用（同 `SessionsPanel` 被 Sidebar/Drawer 复用的模式）
- 顶部 chrome：标题"文件" + 项目路径（`snapshot.cwd`，~-缩写，title 显示全路径）+ 刷新按钮（按 cwd 前缀失效全部 tree query）+ 关闭按钮。
- 目录行：chevron + 名称；点击展开/折叠；展开时拉取 `["tree", cwd, path]`（`staleTime: 0`）。
- 展开集合按 cwd 持久化到 localStorage（新 `src/lib/filetree.ts`，沿用 sidebar.ts 模式）。
- 文件行点击 → 把 `@相对路径` 插入 Composer 光标处（经下述 inject 机制，insert 模式）并聚焦；移动端点击后顺带关闭抽屉。
- 内联状态：加载中骨架行、空目录提示、加载失败可重试、`truncated` 末尾提示、`inaccessible` 目录置灰。

**Composer @ 文件引用（`Composer.tsx` + 新 `FileMentionPalette.tsx`）**
- 触发解析为纯函数 `extractMentionQuery(text, caret) → { start, query } | null`（便于单测）：光标所在 token 以 `@` 开头（token 起点 = 文本头或空白之后）时返回 token 起点与 query（`@` 后至光标的片段）。
- 打开时镜像 `CommandPalette` 的既有形态：锚定在输入框上方的绝对定位弹层、`role="listbox"`、↑↓ 移动、Enter/Tab 选中、Esc 关闭、`onMouseDown preventDefault` + 点击选中。
- 数据：query 变化 debounce 150ms → `useFileSearch(cwd, query)`；`@` 空 query 显示根层建议（服务端行为，见上）。
- 选中：用 `@path `（含尾随空格）替换 `[start, caret)` 区间，光标移到插入文本之后，关闭弹层。
- 与 `/` CommandPalette 互斥：`commandMatches` 仅匹配文本以 `/` 起始的情形；mention 解析要求光标在 `@` token 内——两者触发条件不同时成立时 mention 优先（光标语境优先于全文语境）。
- 失焦、发送、切换 tab 后关闭弹层。

**inject 机制扩展（复用现有通道，不新建并行通道）**
- 现状：`ChatState.injectText: string | null` + `refillComposer/consumeInjectText`，语义为**整体替换**（fork selectedText、"重用消息"在用）。
- 扩展：`injectText` 变为 `{ text: string; mode: "replace" | "insert" } | null`；`refillComposer(text)` 默认 replace（兼容现有调用点）；新增 `insertComposerText(text)` 走 insert 模式。Composer 消费时：replace = `setText`（现状）；insert = 光标处插入（无光标追加末尾，必要时补空格），写入 per-tab 草稿后聚焦。
- 该通道本就连着活跃 tab 的 client（`refillComposer` 即按此路由），天然满足"插入到当前 tab 的 Composer"。

**`src/lib/api.ts`**
- `useTree(cwd, path, enabled)`、`useFileSearch(cwd, query, enabled)`、`useInvalidateTree(cwd)`。

**i18n**：`en/zh/ko/ja` 四语言新增键：`files`（文件）、`openFiles`/`closeFiles`、`refreshTree`、`emptyDirectory`、`treeLoadError`、`treeTruncated`、`inaccessible`、`mentionNoFiles`（无匹配文件）等。

## 数据流

**树**：ChatPage 已有 `snapshot.cwd`（WS 连接即推送，草稿会话也有）→ 头部按钮打开文件面板 → 拉根层 → 展开目录 → `GET /api/tree?cwd&path` → 校验 cwd → `listDir` 返回单层。tab 切换 → `snapshot.cwd` 变 → query key 变 → 自动换根。

**@ 引用**：Composer 光标进入 `@` token → `extractMentionQuery` 命中 → 弹层 → 输入经 debounce → `GET /api/files/search?cwd&q` → 选中 → 本地替换文本（纯前端，无额外往返）。

## 错误处理

| 场景 | 行为 |
|------|------|
| cwd 不在已知项目集合 | 403 → 树面板空态 / mention 弹层显示无结果（正常不会发生，客户端只传 snapshot.cwd） |
| 项目目录被删 / 不存在 | 404 → 树空态 + 重试；mention 显示无结果 |
| 展开瞬间目录被删 | 404 → 该节点下内联错误行，可重试 |
| 子目录无权限 | 节点 `inaccessible` 置灰不可展开；搜索索引跳过 |
| 搜索遍历超上限 | `partial: true` → 弹层底部提示"结果可能不全，请输入更多字符" |
| root 无权限 | 403 → 树错误态 |

## 边界情况

- 草稿会话（未发布）：`snapshot.cwd` 存在（`AGENT_CWD` 或建会话指定目录），两个功能均可用。
- 非 git 项目：无根 `.gitignore` → 仅硬排除。
- 路径含空格：插入为纯文本不受影响；mention token 替换区间为 `[start, caret)`，与后续字符无关。
- 邮箱式文本（`a@b`）：`@` 不在 token 起点，不触发。
- 同名大小写文件：排序稳定即可，不合并。
- 超长名称/深层缩进：CSS truncate，面板横向滚动兜底。

## 测试

- **`tests/files.test.ts`（新，node:test + 临时目录 fixture）**：
  - `listDir`：目录优先排序、大小写不敏感、硬排除、根 `.gitignore` 生效（含目录型模式）、`truncated`、rel 逃逸/绝对路径拒绝、符号链接不下钻、EACCES 标记。
  - `searchFiles`：三种匹配层级的排序、limit、空 query 根层退化、过滤规则与 listDir 一致、总量上限 `partial`。
- 前端纯函数（可与实现同 PR 的轻量单测）：`extractMentionQuery`（token 起点、邮箱不误触发、光标区间）、mention 替换区间计算。
- 端点冒烟：未知 cwd → 403；已知 cwd 根层 200；search q 命中。
- 回归：`npm run typecheck`、`npm run test`、`npm run build`。

## 版本

- 实现完成前：patch +1（当前工作区 0.1.66 → 0.1.67；若实现时工作区版本已变，按当时 +1），同步 `package.json`、`package-lock.json`，并在 `release-notes.json` 对应版本键下加一条用户向描述。

## 明确不做（本期）

- 文件内容随引用附带进消息（`@file` 的内容展开/图片附件化）——后续迭代
- 文件内容预览 / 右键菜单 / 复制路径按钮
- 嵌套 `.gitignore`、全局 gitignore、`core.excludesFile`
- FS 监听自动刷新
- 目录树的创建/重命名/删除等写操作
- mention 高亮 pill（插入后仅是纯文本 `@path`，无富文本标记）
