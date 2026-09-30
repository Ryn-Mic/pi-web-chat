# Agent Note: CometixCode 作为第三种 Agent 后端的接入方案

Status: proposed

## Problem

pi-web-chat 目前支持两类 Agent 会话：pi（npm 包内 Pi SDK，默认）与 Codex（spawn 本机 `codex` CLI 的 app-server，JSON-RPC over stdio，`server/codex.ts`）。用户本机已在运行第三类编码代理 CometixCode（`/Users/ryn/Documents/tmp/CometixCode`，Rust 编写的 Claude Code 1:1 复刻，二进制名 `cometix`），希望与 pi、Codex 一样从 Web UI 统一驱动。当前没有任何通路可以在 pi-web-chat 中创建、驱动或恢复 CometixCode 会话。

约束：

- CometixCode 无 app-server 常驻模式；其机器可读接口是 `--print` + `--input-format/--output-format=stream-json` 的结构化 I/O（`src/cli/print.rs`、`src/cli/structured_io.rs`）。
- 会话持久化格式为 Claude Code 风格 JSONL（`~/.cometix/projects/<project-hash>/<session-id>.jsonl`，`src/utils/session_storage.rs:779`），与 pi 的 `~/.pi` 会话 JSONL 不兼容，无法纳入现有 `SessionSummaryIndex` 的解析。
- 许可证为 **AGPL-3.0**，项目自称 WIP，协议面未承诺稳定。

## Proposal

新增第三种 `UIAgentKind = "cometix"`（`shared/protocol.ts:99`），以「每轮一个 headless 进程 + 双向 JSON 流」的方式接入，整体对照现有 Codex backend 的形态（spawn 子进程 + stdio JSON + 服务器内会话状态机）。

### 已核实的接入事实（CometixCode 源码）

- 命令行：`cometix --print --input-format=stream-json --output-format=stream-json --include-partial-messages`（`src/cli/parse.rs:130/135/184/189`）；`--permission-prompt-tool=stdio` 启用 SDK control bridge（parse.rs:498 有对应测试）；`-r/--resume [sessionId|path]` 恢复会话（parse.rs:140/282，`src/commands/resume/mod.rs`）。
- stdin 协议：逐行 JSON。用户消息 `{type:"user", message:{role:"user", content:...}}`；control 请求（`control_response`，print.rs:521）支持 `initialize`、`set_permission_mode`、elicitation 应答、tool permission 应答（`can_use_tool` → `request_sdk_tool_permission`，structured_io.rs:532）。
- stdout 协议：逐行 JSON，`{type:"assistant", message:{...}}` 流式消息、`{type:"result", subtype:"success", ...}` 收尾（含 cost/duration/usage）、`{type:"system", subtype:"init", ...}` 初始化（含 session_id、tools、model）、`rate_limit_event`（print.rs:41）、tool 权限请求与 elicitation 请求作为 server-side control request 经 stdin 回应。
- 会话恢复：`--resume <session-id>` 或首条消息 `{"resume":"..."}`；transcript 落盘在 `~/.cometix` 下，路径由 `get_session_file_path(project_path, session_id)` 决定。

### 设计要点

1. **runtime 进程模型**：与 Codex app-server（一个进程常驻、多线程复用）不同，`--print` 模式按「一次交付」运行。拟采用 Codex native thread 的既有先例——`SessionManager.inMemory` 承载 Web 侧会话条目（`server/index.ts:607`），每个 agent turn spawn 一个 `cometix` 进程，turn 结束进程退出；会话身份由 cometix 的 `session_id`（从 `system init` 事件读取）+ `--resume` 维系。
2. **新文件 `server/cometix.ts`**：`CometixClient` 封装 spawn/stdin 写入/stdout 行解析/退出码处理，接口对照 `CodexAppServerClient` 的窄面（connect/request/事件回调），但语义是「每 turn 一进程」而非常驻 RPC；映射 `assistant`/`result`/tool 事件到现有 `ServerEvent`。
3. **审批与交互**：tool permission 请求与 elicitation 复用 `UICodexInteraction` 通道与 `CodexInteractionHost` 的既有 UI（语义上是「外部 agent 阻塞请求」，与 Codex 同构），协议届时需扩展 `UIAgentKind` 与交互来源字段——按 AGENTS.md 原子协议变更规则同步 `shared/protocol.ts`、生产者、消费者、重连路径与测试。
4. **会话目录**：新增 `cli/agent-detection.ts` 的 `cometix` 探测（`which cometix` + `cometix --version`），类比现有 codex 探测；会话列表不并入 `SessionSummaryIndex`（格式不兼容），沿用 Codex native thread 的思路——条目由 Web 服务自身的 `~/.pi` JSONL 影子记录承载（`appendCodexState` 先例，`server/index.ts:452`），cometix transcript 仅作为恢复种子。
5. **降级**：`cometix` 不可用时仅提示该 Agent 能力不可用，不影响 pi/Codex 会话（对照 README 的 doctor 语义）。

实现将另起版本分支承载；本 Note 只固化方案与边界。

## Alternatives considered

- **MCP 方式接入** — cometix 本身不是 MCP server；其 client 侧 MCP 支持（`src/services/mcp/`）与「被 Web 驱动」方向相反。作为 server 接入需先给 CometixCode 实现 MCP server 模式，工程量与协议稳定性都不可控，否决。
- **等待 app-server 等价物** — CometixCode 的 `remote-control`/bridge 子命令（parse.rs:102）依赖 claude.ai 订阅 OAuth 与 CCR bridge（`src/bridge/bridge_enabled.rs`），是云中转方案而非本地 stdio 服务，与 pi-web-chat「本地 daemon、默认 127.0.0.1」的安全模型冲突，否决。
- **只读 transcript 浏览器（不接入驱动）** — 只做 cometix JSONL 的会话查看器改动最小，但不满足用户「统一使用」的诉求，且 `~/.cometix` 格式仍需独立解析器，性价比低，否决。
- **经由 Pi SDK 的自定义 provider 包装** — cometix 不是 OpenAI 兼容 HTTP API，无法作为模型 provider 挂载；强行走 HTTP 代理层会丢失工具审批、elicitation 全部交互能力，否决。

## Acceptance criteria

- 实现版本中：网页设置可为新会话选择 Cometix；会话能创建、收发消息、展示流式输出与工具进度；审批/提问阻塞并可在 Web UI 应答后继续；断线重连后 `--resume` 恢复上下文。
- `cometix` 未安装时 doctor/status 明确提示且不影响 pi/Codex。
- 协议变更（`UIAgentKind` 扩值、交互通道）一次性覆盖 `shared/protocol.ts`、服务端生产者、`ChatClient` 消费者、重连/完整快照路径及全部受影响测试。
- 浏览器验收覆盖：新会话、恢复会话、审批流、多 Agent 标签并存互不串线。

## Risks

- **AGPL-3.0 边界**：pi-web-chat（MIT）通过进程边界 spawn 独立二进制、不链接、不分发其代码，网络交互不构成衍生作品；但需在 THIRD_PARTY_NOTICES 与文档中明确 cometix 为用户自备的第三方工具及其许可证，并在用户向社区分发指引时避免暗示捆绑。若未来 CometixCode 自身调整许可证或增加云依赖，需重审。
- **协议面不稳定**：CometixCode 自称 WIP，stream-json/control 协议跟随上游 Claude Code SDK 语义演化，`server/cometix.ts` 需版本探测与宽容解析（未知事件忽略而非崩溃），并接受小版本内出现兼容窗口。
- **每 turn 一进程的延迟**：Rust 二进制启动快，但每轮冷启动仍高于 Codex 常驻 app-server；若实测不可接受，备选是长驻 `--print --input-format=stream-json` 进程并复用（print.rs 的 control 协议支持多轮 stdin），但这偏离其「headless 一次性」设计，风险后移。
- **回滚条件**：若审批/elicitation 映射在真实会话中出现语义偏差（如 deny 语义、interrupt 处理不一致），该 Agent 入口先降级为隐藏/实验开关，不影响既有 pi/Codex 路径。
