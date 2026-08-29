# Agent Note: Codex 会话的 Web 斜杠命令契约

Status: implemented

## Problem

Web 输入框已经能展示 Pi 的内置、扩展、提示词和技能命令，但 Codex 会话仍复用一组精简的 Pi/Web 命令名，只提供 `settings`、`model`、`new`、`resume`、`fork`、`copy`、`name` 与 `session`。用户看不到 Codex 常用的 `reasoning`、`compact`、`review`、`diff`、`rename` 和 `status`，已存在的原生 app-server 能力也没有进入命令面板。

命令仍通过普通 `prompt` 信封提交。成功结果、客户端动作和错误没有统一携带原请求 ID；尤其是参数错误或未知命令报错时，浏览器无法确认哪个乐观输入已经终止，输入框会停留在发送中。运行中的 Codex turn 发送 Web 本地命令时，一个无关联的命令结果还可能错误清空其他 steering 状态。

Codex CLI 的完整命令集包含终端显示、进程退出、账号、插件、实验特性和交互式选择器等客户端专属行为。它们不能在没有等价 UI、权限确认和生命周期处理的情况下直接转发给模型或照搬到 Web。

## Decision

命令目录按当前会话的 Agent 构建。Pi 保持现有内置命令和动态 extension command、prompt template 与 skill；Codex 使用独立目录，只展示 Web 明确实现的十二个主要命令：

- Web 界面动作：`settings`、`new`、`resume`、`fork`、`copy`、`diff`。
- 会话设置与状态：`model`、`reasoning`、`rename`、`status`。
- 原生 app-server 操作：`compact` 与 `review`。

`name` 与 `session` 继续作为兼容别名可执行，但不占用 Codex 面板的主要命令名。为了让上一版 PWA 能解析目录，传输层继续使用既有 `source: "builtin"`，面板根据当前 Agent 将该组标为 Codex，而不扩展协议枚举。

`reasoning` 无参数时打开现有推理档位菜单，带参数时只接受当前模型广告的档位；`diff` 打开现有 Git 工作区；`compact` 使用 `thread/compact/start`；`review` 使用 inline `review/start`，默认审查未提交改动，并接受 `--base <branch>`、`--commit <sha>` 或自定义审查说明。需要真实原生 thread 的命令在空白草稿上明确提示先发送消息，不为了控制命令创建空 thread 或影子 Pi 会话。

## Key mechanisms

- 所有 Web 内置命令的 `command_result`、`client_action` 和 `error` 都带原 prompt 的 `requestId`。客户端只结算匹配的 pending prompt 或 steer；命令失败恢复对应输入，命令成功移除对应乐观消息，并以权威快照决定回到 idle 还是 running。
- 服务端按 session 和 request ID 保存命令 receipt。相同 ID 在执行中只增加 waiter，完成后重放同一个终态；浏览器生成的 draft connection ID 让未发布草稿断线后仍绑定原 entry，避免本地命令因重连重复执行。
- 旧服务没有 request ID 时，客户端只在恰好一个请求明确等待 Web 命令终态时推断归属；存在歧义就保留所有输入。成功终态与错误终态使用同一归属规则。
- `compact` 与 `review` 在 RPC 响应和 turn 通知之间保持独占控制状态，分别暴露 `controlOperation`、`canSteer` 和 `canAbort`。图片输入准备在首次异步 I/O 前同步预约线程，不能与控制操作抢占。
- observer 目录只提供 `settings`、`new`、`resume`、`copy`、`diff` 和 `status`。服务端同时拒绝直接 slash、`set_model`、`set_thinking_level` 与 approval response；观察者不会认领共享 app-server 广播给原 writer 的审批。
- 新 `client_action` 与请求关联字段保持可选，服务端命令 source 仍为旧枚举值；但旧 PWA 不理解新增动作，也没有并发结算修复，因此产品支持边界是收到版本提示后刷新，使前端与服务端版本一致。

## Alternatives considered

- **把 Codex CLI 的完整硬编码命令表全部展示并原样发送给模型** — app-server 不会把 TUI 命令当成普通 prompt 执行，且退出、删除、账号与终端 UI 命令会产生错误或危险的伪语义。
- **只增加命令菜单项，不实现结构化执行** — 菜单会承诺实际不存在的能力，`compact` 与 `review` 也无法保持原生线程状态和事件流。
- **本次重写成独立 `run_command` 协议并迁移所有 Pi 扩展命令** — 长期能提供更强类型，但会同时改变 Pi extension、prompt template、skill、图片和 Extension UI 的执行契约，扩大主体回归范围。
- **继续使用无 requestId 的终态事件** — 参数校验和 app-server 失败路径会放大输入框卡死及误清 steering 的问题，不能作为可靠基础。
- **为 `review` 或 `compact` 自动创建空白 Codex thread** — 纯控制操作会产生用户未预期的会话记录，违反草稿不落盘约束。
- **让 observer 预配置未来模型或回答当前审批** — read-only 会变成部分写入，且共享审批可能与真正 writer 竞态；应等待线程升级为 writer 后再修改。
- **声称旧缓存 PWA 行为兼容或强制服务端断开旧页面** — 前者会掩盖旧客户端不认识新动作的事实，后者需要新增版本协商并可能中断正在显示的任务；本次采用明确的更新提示刷新边界。

## Consequences

Codex 草稿和原生线程现在拥有与自身能力一致的命令面板，Pi 命令目录与动态资源路径保持不变。Web 可执行命令不会被当作模型 prompt；未知 Codex 命令明确拒绝。原生 compact/review 沿用同一 thread 生命周期、历史刷新和中止能力，不能与 prompt 或彼此并发。

命令 receipt 和 draft identity 增加少量有界内存状态：已完成 receipt 保留五分钟且最多 256 条，执行中请求最多 256 条；空闲 entry 仍由现有 TTL 清理。Pi 的长运行 extension 命令仍由其底层完成时机决定，本次没有增加通用命令超时或取消协议。

已经打开的旧 PWA 可以继续解析新版快照和目录，但新增 `open_reasoning`、`open_git`、带 Agent 的新会话动作及精确并发结算只在刷新到同版本前端后受支持。README 与 release notes 明确要求看到更新提示后刷新。

## Verification

- `npm run typecheck`、`git diff --check` 与 `npm run notes:check` 通过；全量 `npm test` 307/307 通过，覆盖 Pi 主体、Codex 命令解析、请求关联、原生控制生命周期、prompt 准备并发、observer 只读和 WebSocket 双 Agent/草稿重连。
- `npm run build` 与使用隔离 npm cache 的 `npm run pack:check` 通过；包体约 62.43 MiB packed、173.13 MiB unpacked，共 3105 个文件。`npm pack --dry-run --json --ignore-scripts` 确认包名 `@ryn-mic/web-chat`、版本 `0.1.111` 与发布文件清单。
- 真实浏览器验收通过：Codex 草稿 `/` 面板显示 Codex 分组和 12 个主要命令；`/reasoning` 打开推理菜单，`/status` 结算且 URL 仍为未发布草稿，桌面 `/diff` 打开 Git 工作区，390×844 移动视口 `/diff` 打开选中 Git 页的工作区抽屉，`/new` 保持 Codex。浏览器控制台无 warning/error，临时 viewport 已 reset。
- 浏览器中没有执行真实 compact/review；结构化 RPC 参数、响应/通知交错与控制 turn 能力由隔离 app-server 集成测试覆盖。未安装全局包、未重启受保护的 3141 服务；3242 调试 listener 在验收后已停止。
