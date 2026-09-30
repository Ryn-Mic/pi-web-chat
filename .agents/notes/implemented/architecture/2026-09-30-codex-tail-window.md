# Agent Note: Codex 会话快照改为有界尾窗 + 游标分页

Status: implemented

## Problem

iPhone Safari 打开某个 Codex 会话时反复显示 “A problem repeatedly occurred on …”，即 WebKit 内容进程被连续杀死（OOM 崩溃循环）。

实测该会话：rollout 文件 `~/.codex/sessions/2026/09/03/rollout-…-01a06121-cb0a-71d1-9c96-f1e1f75ecfb9.jsonl` 共 **216 MB / 7971 行**，app-server 水合出的 turn page 为 **7220 条消息**。服务端首次下发的 WS `snapshot` 帧实测 **129,924,590 字节（≈124 MB）**；`/api/sessions/<id>/history` 无 cursor 的首次请求同样返回 ~124 MB（`cursor: null, hasMore: false`，即一次性全量）。移动端 WebKit 在接收/解析这一帧时内存耗尽，页面被杀后自动重载，于是循环崩溃。

根因在 `server/index.ts` 的两处「无界」行为：

- `refreshEntryFileState()` 对没有 Pi JSONL 文件的条目（Codex 原生会话使用 `SessionManager.inMemory`，`sessionFile` 为 null）直接 `snapshotMessageOffset = 0`，而 Pi 会话会按 `readSessionHistoryPage()` 的尾页长度截断。于是 Codex 会话的每次快照都携带整个水合页。
- history 接口的 Codex 分支在无 cursor 时返回 `loaded.codexMessages` 全量，而不是与快照一致的有界窗口。

对比：本机直连时该会话首个快照 124 MB / 2722 ms；同机上 `/api/sessions` 已通过 SWR 优化到 0.1 s，说明瓶颈不在目录扫描而在会话载荷本身。

## Decision

Codex 原生会话改用与 Pi 一致的「有界尾窗 + 游标分页」契约。快照继续携带 `messages` 与 `history: {cursor, hasMore}`；v0.1.121 为滑动边界补充 `snapshot_delta.resetHistory`，客户端据此清除旧分页、恢复加载入口并使在途响应失效：

- `CODEX_TAIL_MESSAGES = 120`：快照只下发水合页末尾 120 条 UI 消息。
- `CODEX_PAGE_MESSAGES = 120`：history 每次向上翻页最多 120 条。
- `CODEX_TAIL_HIGH_WATER = 240`：活跃 turn 追加消息时窗口可增长，超过高水位才回收（滑动会让下一次 delta 变成整段尾窗替换并丢弃客户端已加载的更早页，故不宜频繁触发）。
- 窗口边界统一以**序列化后的 UI 消息**计数，并缓存 `entry.codexUi`：raw 消息与 UI 消息不是 1:1（`serializeMessages` 会把 toolResult 合并进 toolCall、丢弃空消息），且工具调用与结果的配对是全局的——按 raw 切片会把一次调用与其结果分到两页，渲染成未完成状态。因此分页一律在缓存的全量 UI 数组上切片。
- 新增 `page:<generation>:<offset>` 游标（前缀区分于 app-server 的不透明游标）：先从水合页自身向前翻，翻到页首后把 `entry.codexStreamCursor`（app-server 提供的、位于整页之前的游标）交还给客户端，由既有 `loadHistory()` 继续取更早的 turn。

初次实现时实测同一会话（旧 offset 游标格式）：首帧 **220,345 字节 / 120 条**（降低约 590 倍），游标 `page:7100`；向上分页 60 页取回全部 7100 条更早消息，链路正常终止。普通会话（33 条）快照与分页行为不变。

## Alternatives considered

- **把 `useStateDbOnly`/`initialTurnsPage.limit` 调小（例如 50 turns → 5）** — 该会话体积来自单个 turn 内的巨型 tool 输出（单条最大 1.25 MB），减少 turn 数并不能把载荷压到移动端可承受范围，而且会牺牲最近上下文，否决。
- **按 raw 消息下标切片，不建序列化缓存** — 实现更小，但 raw 与 UI 计数不一致（实测水合页 12319 raw → 7220 UI），窗口会算错（首帧一度为空）；更严重的是可能把 toolCall 与其 toolResult 分页，否决。
- **对超长消息内容做截断（每条上限 N KB）** — 能进一步压缩体积，但改变消息语义、让用户看不到完整输出，且需要新增「按需展开全文」通道；当前崩溃由总帧大小驱动，先解决总量，否决（留作后续选项）。
- **只修 history 接口、不动快照** — 崩溃发生在 WS 首帧（124 MB），history 只是同样大的第二次请求，只修一处不解决问题，否决。
- **客户端懒渲染/虚拟滚动** — 崩溃发生在 `JSON.parse` 之前（帧本身 124 MB），客户端优化无法避免解析前就被杀，且改动面大，否决。

## Consequences

- 打开超长 Codex 会话时，首屏只渲染最近 120 条；更早内容需向上滚动触发分页（与 Pi 会话的既有行为一致）。
- 服务端仍完整持有水合页（`codexMessages` + `codexUi`），内存占用与本次修复前相同；只是不再把它整段发给浏览器。
- 窗口滑动时服务端必须在 delta 标记 `resetHistory`，客户端才会丢弃旧页并刷新游标，不能仅依赖整段替换。只在超过高水位时滑动，保证较少重置且仍可重新加载更早页。
- `page:` 游标包含水合代次。重新水合改变已有消息序列或显式重置时递增代次，旧游标返回 409；格式无效返回 400。纯追加保留代次与既有窗口，避免观察模式每次刷新都重置已加载历史。
