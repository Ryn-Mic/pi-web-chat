# Agent Note: 区分旧守护进程与前端更新

Status: implemented

## Problem

全局 npm 升级会原地替换包目录，但已经运行的托管 Node 进程不会自动重启。旧进程仍从内存发送旧版 `hello.version` 与 `updateNotes`，同时又从被替换的 `dist/public` 提供新版前端资源。此前客户端只判断版本字符串是否不同，因此把“新版前端连接旧版服务端”误报为有新版本，并展示旧版更新说明；刷新按钮只会再次加载同一组混合资源。

## Decision

客户端通过独立的 SemVer 方向判断区分三种状态：服务端较新时保留更新提示和对应说明；版本相等时清空提示；服务端较旧时丢弃其更新说明，改为显示托管服务需要重启，并引导先运行 `pi-web-chat status`。预发布标识按 SemVer precedence 比较，build metadata 不影响相等性；非标准且不相等的版本保留原有更新提示兼容路径。

daemon manager 在完成实例身份验证后同时保留 health 中的运行时版本。独立 CLI 的 `status` 与兼容的 `pi --web status` 都对比运行版本和当前安装包版本；不一致时显示两者，并给出带实际本地端口的 `pi-web-chat <port> restart`。普通 `start` 不自动终止现有 daemon，继续遵守实例身份验证和显式 restart 边界。

版本同步为 `0.1.113`，`package.json`、`package-lock.json` 根元数据与 `release-notes.json` 使用同一版本。

## Alternatives considered

- **npm 安装后自动重启 daemon** — npm 生命周期脚本无法安全确认用户是否在运行服务、使用哪个端口或是否允许中断当前会话，而且安装阶段修改用户进程超出包管理职责。
- **版本不一致时继续统一显示更新横幅** — 无法区分服务端升级和前端资源先升级，正是旧说明被误报为新说明的原因。
- **服务端每次请求都重读磁盘版本并自杀或热更新常量** — 原地升级期间文件并非原子替换，自动退出可能中断任务；只热更新版本与说明仍会让旧服务端代码和新前端协议混用。

## Consequences

新版前端不会再把旧守护进程的 release notes 当作新版本信息，CLI 也能直接指出“已安装版本”和“运行版本”的差异及正确重启命令。代价是包升级后仍需用户显式重启托管服务；这是为了避免安装或普通查询隐式中断正在运行的 Agent 任务。旧前端不理解新的重启提示，但它连接新版服务端时继续走既有服务端更新路径；刷新到本版后即可获得方向判断。

## Testing

- 版本与 CLI/daemon 聚焦测试 19/19 通过；完整 `npm test` 318/318、`npm run typecheck` 与 `npm run build` 通过。
- 真实浏览器使用 0.1.113 前端连接只发送 0.1.111 `hello/updateNotes` 的本地 mock：重启提示可见，旧说明和刷新按钮均不可见。
- 刚构建的 CLI 对现有 3141 服务输出 `running v0.1.111; installed v0.1.113` 与 `pi-web-chat 3141 restart`，未执行重启。
- 使用隔离 npm cache 的 `npm run pack:check` 与 `npm pack --dry-run --json` 通过；包体约 6.79 MiB packed、20.62 MiB unpacked，共 223 个文件。
