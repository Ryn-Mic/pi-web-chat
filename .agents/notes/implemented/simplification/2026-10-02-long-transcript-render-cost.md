# Agent Note: 长会话与流式渲染中去除重复工作

Status: implemented

## Problem

长会话（上百轮）里有三处重复劳动，都随会话长度线性增长：

1. **每个流式 delta 重渲染全部历史轮次**：`MessageList` 必须在 `streamText` 变化时重渲染，但 `AssistantTurn` 没有 memo，于是每个 delta 都会把所有已结束轮次重新走一遍渲染；同文件里的 `Message`、`UserMessageBubble`、`ToolCallCard` 早已 memo，只有轮次包装层漏掉。
2. **刻度判定每帧 N 次 DOM 查询**：判定需要每个提问的 `rect.top`，原实现每个滚动事件都对每条已加载提问执行一次 `querySelector([data-msg-index])`；45 个提问就是 45 次查询 + 45 次 `getBoundingClientRect`。
3. **全量大纲每行新建格式化器**：`relativeAge()` 每次调用都构造一个 `Intl.RelativeTimeFormat`。

另外消息区“滚底按钮”用 24px 判定到底，刻度用 60px 判定到底，同一概念两个阈值。

## Decision

- `AssistantTurn` 用 `memo` 包裹：`turn` 只在加载页或流式生命周期变化时改变，`live` 只对当前运行轮次是每帧新建的对象，因此已结束轮次在每个 delta 中不再参与重渲染。
- 刻度判定按 `[data-msg-index]` 建立一次 `Map<index, element>` 并缓存在 ref 中：加载页变化时重建，使用前校验首节点仍 `isConnected`（把每帧 N 次 `querySelector` 降为 0 次）。这是对“消息存续期间用户气泡 DOM 稳定”这一前提的显式依赖，已写进刻度组件的 Note。
- `TAIL_EPSILON_PX = 24` 由 `src/lib/message-anchors.ts` 导出，刻度判定与消息区滚底判定共用，消除两个阈值。
- `Intl.RelativeTimeFormat` 按语言 `useMemo` 一次，供大纲所有行复用。

## Alternatives considered

- **给助手回复加 `content-visibility: auto` 跳过离屏渲染** — 实装后又回滚：长会话里它把文档高度按占位尺寸撑大，远端提问的 `scrollIntoView` 直接失效（详见 [被否决的离屏跳过方案](../../rejected/feature/2026-10-02-content-visibility-offscreen-skip.md)）。
- **把 `useChat()` 拆成按字段订阅（store 选择器 / 分片 hook）** — 未做：每次 delta 变化的状态就是 `streamText`/`streamThinking` 等消息流字段，`ChatPage` 重渲染的主要成本集中在消息子树，而消息子树的问题已由 memo 处理。拆 store 会触及会话、预览、Git 面板等全部订阅点，收益不成比例。
- **引入列表虚拟化** — 否决：刻度的几何判定依赖真实布局（需要真实 `rect.top`），折叠块的内部展开态、代码高亮结果也依赖持续挂载；虚拟化必须同时接管刻度的测量与滚动定位，属于独立交付。
- **给滚动监听加 rAF 节流** — 未做：单帧内已经只做一次布局读取（缓存映射后），节流会牺牲滑动手感的跟手程度，收益小于代价。

## Consequences

- **收益**：长会话中已结束轮次不再随每个 delta 重渲染；刻度判定的 DOM 查询从每帧 N 次降为 0 次；“滚底”在刻度与按钮之间只有一个定义；全量大纲不再为每行构造 `Intl` 实例。
- **代价 / 诚实记录**：memo 的收益在本机 CDP 探针里**无法稳定测量**——60 轮 + 30 个 delta 与 150 轮 + 60 个 delta 各跑多次，`TaskDuration` 同配置重复采样方差约 ±25%，大于差异本身（150 轮：有 memo 61.2/76.5/78.4ms，无 memo 79.0ms）。保留该改动是因为它让“无变化的轮次不参与渲染”成为结构性保证，而不是依赖 `Message` 的 memo 恰好兜住成本；本 Note 不把它记为可测量的性能收益。节点映射缓存的收益同样以结构性论证为主，未做逐帧基准。
- **验证**：`npm test`（425）、`npx playwright test`（44，含新增的长会话跳转与浮层存活用例）、`npm run typecheck`、`npm run notes:check`、`npm run pack:check`、`git diff --check` 全部通过；长会话跳转用例（60 轮 + 从全量大纲跳回第 5 问）是这次改动与离屏跳过方案的共同回归门禁。
