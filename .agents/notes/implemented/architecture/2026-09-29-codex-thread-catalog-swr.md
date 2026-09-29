# Agent Note: Codex 线程目录缓存从 TTL 重建改为 stale-while-revalidate

Status: implemented

## Problem

`/api/sessions` 冷调用耗时 5–7 秒，是「重新打开网站要等一会」的主因。根因链：

- 该接口 `Promise.all` 中的 `codexThreads()` 走 `thread/list` RPC，且 `useStateDbOnly: false` 会全量扫描 `~/.codex/sessions` 下的每个 rollout 文件（本机 1276 个 / 5.9GB，单次 4.5–6.5s）。
- 旧实现是「15s TTL + 失效点直接 `codexThreadsCache = null`」：每次 `turn_end`、重命名、fork、发布草稿、删除后，下一次列表请求都变成阻塞的整目录重扫。
- 同接口的 `sessionSummaryIndex.list()` 仅 7ms（自带增量缓存），不是瓶颈。

实测对照（同机 codex app-server probe）：`useStateDbOnly=false` 单页 4481–5435ms；`useStateDbOnly=true` 8–32ms，但两者线程集合互有缺失——DB-only 缺 15 个仅存在于 rollout 的 CLI 线程，且多出 11 个 rollout 已被清理的归档幽灵条目（与 `~/.codex/archived_sessions` 数量吻合）。单靠 state DB 无法保持正确性。

## Decision

Codex 线程目录（`server/index.ts`）改为进程内 stale-while-revalidate：

- `refreshCodexThreads()` 作为唯一刷新入口，in-flight 去重（并发请求共享同一次扫描）。
- `codexThreads()`：缓存新鲜（60s TTL）直接返回；缓存过期但存在则**立即返回旧值**并后台刷新；无缓存（进程首次）才阻塞等待。
- 服务启动时后台预热一次（`PI_WEB_CODEX_STARTED_MARKER` 存在时跳过，保持测试「draft-only 命令不得启动 Codex」的断言）。
- 已知形态的失效点不再清空缓存，改为廉价的原地更新，保证客户端立即重取时看到最新状态：
  - 重命名 → `renameCachedCodexThread`（同时保留名称不被并发读回覆盖）；
  - 删除 → `dropCachedCodexThread`；
  - `turn_end` / fork / 草稿发布 → `readThread`（单线程毫秒级 RPC）`upsertCachedCodexThread`，读失败才退化为 `invalidateCodexThreads()`（标记过期，不清数据）；
  - 外部 `catalog_changed` → `invalidateCodexThreads()`，由下次请求触发后台对账。
- 保留 `useStateDbOnly: false` 全量扫描作为唯一数据源——后台执行时其成本不再落在用户请求路径上。

实测效果：`/api/sessions` 冷重启后首次请求（预热未完成时）≤5s，此后热/过期请求稳定 0.08–0.10s。

## Alternatives considered

- **切换 `useStateDbOnly: true`（state DB 直读，8ms）** — 实测两侧线程集合互有缺失：DB-only 丢 15 个 CLI 创建的线程、多 11 个 rollout 已删除的幽灵条目，直接切换会引入数据错误，否决。
- **保持「失效即清缓存」仅把阻塞改成后台** — 客户端在发布/fork 后立即重取时会拿到没有新会话的旧列表，直到下次刷新落地；需要额外推送机制才能自愈，复杂度不成比例，否决（改为失效点原地乐观更新）。
- **B2 计划中的「首屏快照管道化」（把 codex connect 三连移到快照之后）** — profiling 显示 `createEntry` 中收尾步骤仅 0–2ms，而 connect 携带 `thread/resume` 的历史页，是 codex 会话首屏消息的来源，推迟只会让首屏变空再闪现，无收益有回归，按计划「以 profiling 数据决定做哪几项」放弃。
- **把 15s TTL 调大** — 不解决失效点清缓存后的阻塞重扫，也降低外部变更可见性，否决。

## Consequences

- 侧边栏最多展示 60s 旧的外部 Codex 会话（其他客户端创建/删除），本地操作的可见性不受影响（原地更新保证）。
- 守护进程常驻后每次启动会 spawn codex app-server 做一次预热扫描；codex 不可用时静默失败，首次请求按需重试。
- 后台刷新（含每次 turn_end 的对账读）仍执行全量 rollout 扫描，成本从用户请求路径转移到后台，与旧实现的总扫描次数持平。
