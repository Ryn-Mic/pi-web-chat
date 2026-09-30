# Agent Note: 用 AG-UI 规范 agent↔前端边界（调研与取舍）

Status: proposed

## Problem

pi-web-chat 目前的「agent ↔ 前端」边界是本项目自定义的：`shared/protocol.ts` 定义 `ServerEvent`/`UISnapshot`/`UISnapshotDelta`，通过 WS 传输，重连靠 `seq` 重放 + 快照增量 + 历史游标。每接入一门后端（pi SDK runtime、Codex app-server、以及 CometixCode 调研 Note 里的方案）都要**手写一套适配器 + 事件映射 + 相应测试**，适配器文件之间没有共同的事件词汇，第三方前端也无法接入。

问题：是否应该把这条边界换成/对齐到 AG-UI（Agent–User Interaction Protocol），以换取「后端与前端各自解耦、新后端零协议成本、第三方前端可复用」。

调研对象：<https://www.copilotkit.ai/ag-ui>、规范 <https://docs.ag-ui.com/spec/1.0/index>、仓库 <https://github.com/ag-ui-protocol/ag-ui>。本地副本见文末 References。

## Proposal

**结论先行：值得对齐事件词汇与「run」语义，但不应替换本项目的前端↔daemon 协议。** 建议把 AG-UI 当作「后端适配器」的规范来源，而不是把 `shared/protocol.ts` 换掉。

### 已核实的事实（AG-UI 1.0）

定位：AG-UI 是三层 agentic 协议里「Agent ↔ User Interaction」那一层（另外两层是 MCP = Agent↔工具/数据，A2A = Agent↔Agent）。官方描述它是 **open / lightweight / event-based**，且**transport agnostic**：`任何事件传输均可承载（SSE、WebSockets、webhooks…）`，并带一个**参考 HTTP 实现**与默认 connector。

核心模型：**一次请求进（`RunAgentInput`），一条有序的类型化事件流出**；「run」是交互单元。规范 1.0 的事件家族（`spec/1.0/events/index`）：

| 家族 | 事件 | 模式 | 消费者 |
| --- | --- | --- | --- |
| Runs & steps | `RUN_STARTED` · `RUN_FINISHED` · `RUN_ERROR` · `STEP_STARTED` · `STEP_FINISHED` | lifecycle | 客户端自身 |
| Text messages | `TEXT_MESSAGE_*` | streaming | UI |
| Tool calls | `TOOL_CALL_*` | streaming | 应用 |
| Reasoning | `REASONING_*` | streaming | UI |
| State | `STATE_SNAPSHOT` · `STATE_DELTA` · `MESSAGES_SNAPSHOT` | snapshot–delta | 应用 store |
| Activity | `ACTIVITY_SNAPSHOT` · `ACTIVITY_DELTA` | snapshot–delta | UI |
| Subagents | `SUBAGENT_STARTED` · `SUBAGENT_FINISHED` · `SUBAGENT_ERROR` | lifecycle | 客户端自身 |
| Passthrough | `RAW` · `CUSTOM` | standalone | 应用（opt-in） |

三种事件模式：start–content–end（流式内容）、snapshot–delta（状态）、lifecycle（run 监控）。`RUN_STARTED` 与 `RUN_FINISHED`/`RUN_ERROR` 是必需边界，step 事件可选。

传输绑定契约（`spec/1.0/basic/transports`）：任何传输必须提供 ① **有序且完整**地投递一次 run 的事件（按生产者顺序）② 在任何事件**之前**投递开启本次交换的 `RunAgentInput` ③ **可区分「截断」的终止信号** ④ 对**结构非法输入**的错误路径。标准绑定两种：HTTP+SSE（默认：POST `RunAgentInput` → `text/event-stream`）与 HTTP+Protobuf（二进制、长度前缀帧）。协议语义在所有传输上一致。

人工介入（`spec/1.0/basic/patterns/interrupt-resume`）：run 可以「中断」并把问题抛给外部，下一次 run 的 `RunAgentInput.resume` 逐条回答。规范里的硬约束包括：中断的 run **不得**被报告为成功；每个 interrupt 的 `id` 在 run 内唯一；resume 条目用 `interruptId` 指向被继续的那次 run 的中断；resume 列表**必须覆盖**该 run 的所有未决中断，消费方必须拒绝不合规的 resume 输入；被中断的动作不得凭缺失条目执行。另有 reason taxonomy 与错误处理条款。

能力声明（`spec/1.0/basic/capabilities`）：agent 可声明 `identity` / `transport` / `tools` / `output` / `state` / `multiAgent` / `reasoning` / `multimodal` / `execution` / `humanInTheLoop` / `custom`。

版本与兼容（`spec/1.0/basic/versioning`）：规范明确规定与旧 peer 通信时**哪些可以丢、何时必须给出告警**——这一点比多数自研协议成熟。

生态（截止本次调研）：

- 官方/主推 SDK：TypeScript（`@ag-ui/core`、`@ag-ui/client`、`@ag-ui/encoder`、`@ag-ui/proto`，均为 **1.0.1**）与 Python（PyPI `ag-ui-protocol` **1.0.0**）；社区 SDK 覆盖 Kotlin / Go / Dart / Java / Rust / Ruby / C++ / .NET。
- 框架集成：LangGraph（官方 partnership）、CrewAI（partnership）、Google ADK、AWS Strands、AWS Bedrock AgentCore、Mastra、PydanticAI、Agno、LlamaIndex、Microsoft Agent Framework、Claude Agent SDK（Python/TS）、Claude Managed Agents、Langroid、AG2、DeepAgents；OpenAI Agent SDK 与 Cloudflare Agents 标注为进行中。
- 生成式 UI 侧：CopilotKit 提供 controlled / declarative / open-ended 三档 GenUI、WebMCP、以及对 MCP Apps、A2UI 的支持。
- 可交互样例：AG-UI Dojo（<https://dojo.ag-ui.com/>）可逐特性对比各框架实现。

### 与本项目现状的对照

| 本项目能力 | AG-UI 对应物 | 判断 |
| --- | --- | --- |
| `UISnapshot` + `UISnapshotDelta`（revision 基线的后缀替换） | `STATE_SNAPSHOT` / `STATE_DELTA` / `MESSAGES_SNAPSHOT` | 语义同构，**词汇可对齐**；我们的增量实现已带 baseline revision 校验，不比规范弱 |
| `ServerEvent`（message/tool/thinking/agent_start…） | `TEXT_MESSAGE_*` / `TOOL_CALL_*` / `REASONING_*` / `RUN_*` | 事件名可对齐，映射是机械的 |
| WS + `seq` 重放 + 完整快照回退 + history cursor | 无对应（AG-UI 的一条 run 流是一次交换；重连/续传属于传输层自由发挥） | **我们的更贴合常驻移动端会话**：断线重连、多客户端观察、长历史分页都在这一层 |
| `CodexInteractionHost` 的审批/elicitation 交互 | `interrupt` / `resume`（含 MUST 级契约与 reason taxonomy） | 规范比我们现写的更严谨，**值得反向借鉴**（尤其是「不得把被中断的 run 报告为成功」这类不变量） |
| 会话/分支/fork、多会话并发、cwd 约束 | 不在协议范围（`threadId`/`runId` 只是标识） | 仍归本项目 |

### AG-UI 覆盖到哪一层（关键边界）

把整条链拆成 `源数据 → 解析/归一 → 事件词汇 → 传输 → 前端渲染`，AG-UI 只覆盖 **「事件词汇 → 传输」** 这一段。它**不是**「JSONL → 统一渲染格式」的转换层：

- **不解析源格式**：pi 的 JSONL、codex app-server 的 turns/items、cometix 的 Claude 风格 JSONL，仍要有人解析、配对 `toolCall↔toolResult`、抽取 reasoning/usage——这正是 `server/serialize.ts`、`server/codex.ts`、`server/session-history.ts` 现在做的事。AG-UI 在「已经结构化的事件」之后才开始生效。
- **不提供历史/分页/索引**：规范文本里没有 pagination 概念；会话列表、活动分支、倒序分块读历史都不在协议范围。
- **不提供会话状态存储**：AG-UI 的会话状态是**客户端往返**的——`messages` 跨 run 累积、由下一次 `RunAgentInput` 带回；`MESSAGES_SNAPSHOT` 只是生产者「重述它拥有的完整消息集合」。服务端**转写库**这一角色仍然属于本项目。
- **adapter 不会消失**：AG-UI 生态自身就是「一个框架一份 integration」（LangGraph / CrewAI / ADK / Claude Agent SDK 各自维护适配器）；pi、codex、cometix 都不在支持列表里，仍需各写一份。
- **它的 middleware 不是中间件层**：指「事件格式可宽松匹配 + 传输无关」的兼容层，位于 processing model 的前置阶段（middleware before enforcement），不承担翻译职责。

因此：能替换的只有 **`ServerEvent` 这一层的词汇与生命周期**（且前提是各后端改写为 emit AG-UI 事件）；`serialize/session-history/session-index/replay` 这些「重」的部分一点也省不掉。

### 落地形态（若要接入）

1. **只做词汇对齐（低成本、推荐先做）**：新增后端时，adapter 输出的事件按 AG-UI 家族命名与生命周期组织（内部类型可保留本项目形状），使「后端 → 内部事件」的映射成为唯一差异面。
2. **暴露 AG-UI 端点（对外能力）**：在 daemon 上加一个 AG-UI 适配层（如 `server/agui.ts`），POST `RunAgentInput` → SSE 事件流；必须遵守传输绑定契约的四条要求，并复用现有认证与 cwd/path 授权（本项目硬不变量，不能只加端点）。
3. **作为客户端驱动外部后端**：用 `@ag-ui/client` 的 `HttpAgent`（POST `RunAgentInput`、读 `BaseEvent` 流）接入 LangGraph/ADK/Claude Agent SDK 等，让它们成为本项目的一门「后端」。这条能立刻复用现成生态，且不改前端。

## Acceptance criteria

- 新增一门后端（下一个真实案例是 CometixCode）时，daemon 侧改动只落在「adapter 文件 + 注册」，**不再修改 `shared/protocol.ts`，也不改前端渲染路径**。
- 现有 WS 契约（重连/重放、snapshot delta、history cursor、多客户端只读观察）行为不变，`npm test` 全绿。
- 至少一个真实 AG-UI 后端（LangGraph 或 Claude Agent SDK 的 AG-UI 适配）能被本项目驱动，**或**本项目的 agent 能以 AG-UI 端点被第三方前端驱动——二者跑通其一即可判定方向成立。
- 若对外暴露端点：实现并通过传输绑定契约的四项检查（有序完整投递、先投 `RunAgentInput`、可区分截断的终止信号、非法输入的错误路径），并补齐认证与授权测试。

## Risks

- **规范仍在演进**：1.0 刚落地，社区 SDK 质量参差（`@ag-ui/langgraph` 仍是 0.0.x）；协议由 CopilotKit 主导，中立性与长期走向需持续观察。
- **语义错配**：AG-UI 是「一次请求 → 一条 run 流」，本项目是常驻会话 + 增量快照 + 多客户端共享；若强行替换前端协议，重连/重放/分页/只读观察都要在 AG-UI 语义下重新论证，风险与收益不成比例。
- **成本易被低估**：映射层需要双份测试；规范要求对旧 peer 的降级与告警；interrupt 契约的 MUST 条款意味着审批路径要按规范重写一遍。
- **安全边界**：任何对外端点都必须先解决认证、cwd/path 授权与凭据不落盘，否则等于开了一个绕过本项目硬不变量的口子。

## Alternatives considered

- **用 AG-UI 替换 `shared/protocol.ts`（前端↔daemon 唯一协议）** — 需要把重连/重放、快照增量、历史分页、多客户端观察全部在 AG-UI 语义下重建，属于本项目的不变量级改动（协议变更必须原子完成），而 AG-UI 并不覆盖这些场景。收益（标准化）与风险（回归）不成比例，否决。
- **直接引入 CopilotKit 前端栈** — CopilotKit 是 React 产品层（Runtime、Inspector、Intelligence/Learning/Memories/Analytics、托管），与本项目已有前端（移动优先、GrokBot/Morphicons 视觉体系、PWA 缓存与懒加载边界）重叠且引入运行时依赖；我们只需要协议，不需要产品层，否决。
- **什么都不做，继续每后端手写适配器** — 这正是 CometixCode Note 已经暴露的模式：每门后端一套映射 + 一套测试，且没有共同事件词汇。短期可行，长期成本随后端数量线性增长，否决。
- **自研一套内部 agent 协议** — 更自由，但要自己维护规范、版本兼容、文档与 SDK，并放弃「外部框架零成本接入」这一核心收益，否决。

## References

- 官方入口：<https://www.copilotkit.ai/ag-ui>
- 规范 1.0：<https://docs.ag-ui.com/spec/1.0/index>（architecture / events / run-input / transports / patterns / capabilities / versioning）
- 概念文档：<https://docs.ag-ui.com/introduction>、`docs/concepts/{events,agents,architecture}.mdx`
- 仓库与集成清单：<https://github.com/ag-ui-protocol/ag-ui>
- 交互样例（Dojo）：<https://dojo.ag-ui.com/>
- 本地副本（本次调研下载，便于复核）：`/tmp/agui/`（`llms.txt`、`spec10_index.md`、`events_index.md`、`basic_run-input.md`、`basic_transports_index.md`、`basic_capabilities.md`、`basic_patterns_interrupt-resume.md`、`events_{lifecycle,tool-calls,state}.md`）
