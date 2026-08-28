# Agent Note: 独立 npm 启动器与 Agent 安装探测

Status: implemented

## Problem

`@ryn-mic/web-chat` 虽然已经声明 `pi-web-chat` bin，但原 bin 只以前台方式直接加载服务，完整 daemon 生命周期、用户文档与安装路径仍绑定 `pi install`、`pi --web` 与 `/web`。项目主体已经同时承载 Pi SDK 会话与 Codex 原生线程，启动入口需要从 Pi 扩展机制解耦，同时不能复制服务、迁移状态、改变认证或破坏任一现有入口。

另一个边界是本机 Agent 能力并不等价：Pi 会话使用 npm 包内的 SDK runtime，外部 Pi CLI 只是兼容入口；Codex 会话则需要可用的 `codex` CLI。启动器必须准确诊断两者，且某个外部命令缺失不能阻断另一种仍可用的 Agent。

## Decision

将 `npm install -g @ryn-mic/web-chat` 与 `pi-web-chat` 设为默认安装和启动路径。独立命令默认启动后台 daemon，并支持 `start`、`status`、`stop`、显式端口 `restart`、host/LAN、token、token 轮换与 `doctor`。

daemon 生命周期从 Pi 扩展抽到 `extensions/daemon-manager.ts`。独立 CLI 与 `pi --web`、`/web` 都是共享 manager 的薄适配器，继续使用 `~/.pi/web-chat/` 下相同的 pid、port、host、log 与认证状态，只管理同一个 HTTP/WebSocket 服务。

保留 Pi 扩展入口及其参数语义，不迁移会话或改变服务协议。服务端、前端快照、Pi JSONL、Codex `threadId` 和活动 turn 所有权均不因 launcher 重构而变化。

## Key mechanisms

- `pi-web-chat doctor` 与启动/重启前的摘要使用无 shell、限时的 `--version` 探测，区分 detected、missing 与 unusable；探测不会安装、登录或修改 Agent。
- Pi runtime 只陈述为 npm 包内的已声明依赖，不把外部 `pi` 命令缺失误报为 Pi runtime 不可用；Codex CLI 缺失只降级 Codex 会话能力。
- `PI_WEB_PI_BIN` 与 `PI_WEB_CODEX_BIN` 支持显式目标。含路径分隔符的相对值在 launcher 当前目录解析为绝对路径，再传给 detached daemon，保证探测与实际会话使用同一可执行文件。
- 默认仍只监听 `127.0.0.1:3141`；非 loopback 继续使用原有 token 与 2FA 边界。托管 restart 仍要求显式端口，并在停止前保存现有 host。
- launcher 为每次托管启动生成随机 instance id；服务成功监听后将其写入共享状态并通过 health 握手回报自身 PID。npm 全局安装与 Pi 安装副本据此跨目录确认同一个 daemon，而 PID 被复用、普通调试进程或其他 `dist/index.js` 不会被误认。信号失败或进程未退出时保留状态并返回错误。
- 升级中的旧 daemon 没有 instance id。manager 只在旧版 health 精确形状、state PID、监听端口 PID 与 Node `dist/index.js` 入口同时吻合时允许停止，并在发信号前再次复核；不满足时仍可保留服务与状态，拒绝猜测杀进程。下一次成功 restart 会自然写入新版实例身份。
- 并发 launcher 的 readiness 必须匹配自己生成的 instance id 与子进程 PID。失败方只在共享状态仍属于自己的 PID/instance 时清理，不能删除已经成功监听的另一实例状态。
- 运行时依赖固定为 `@earendil-works/pi-coding-agent@0.80.10`，根包 Node 要求校准为 `>=22.19.0`，与该 SDK 的实际 engine 一致。

## Alternatives considered

- **让 `pi-web-chat` 内部继续执行 `pi --web`** — 仍要求 Pi CLI 与扩展安装，没有实现分发和启动解耦。
- **为 npm CLI 复制 daemon 管理代码** — 端口保护、状态落盘和停止语义会漂移，并可能启动两套互相不可见的服务。
- **删除 `pi --web` 与 `/web`** — 会破坏现有安装和自动化；保留薄兼容适配器的成本更低。
- **任一外部 CLI 缺失就拒绝启动** — Pi 与 Codex 能力可以独立降级，硬失败会把诊断结果错误升级为全产品不可用。
- **启动时自动安装 Pi 或 Codex** — 涉及网络、版本、认证和用户环境写入，超出安全 launcher 的职责。
- **继续声明 Node 20 或把 Pi SDK 仅改为 optional/peer** — 前者与锁定 SDK 的 engine 冲突，后者会让全新独立安装缺少服务端静态依赖。
- **仅凭旧 pid 文件或 `{ok,version}` health 停止升级前 daemon** — PID 会复用，普通服务也可能复刻宽松 health；必须再绑定实际监听 PID 与已知 Node 服务入口，无法证明时 fail closed。

## Consequences

用户不再需要先执行 `pi install` 或通过 `pi --web` 代理即可运行 Web Chat；旧入口仍可查询和停止独立 CLI 启动的同一 daemon，独立入口也能安全查询并重启升级前的旧 daemon。发布包新增独立 CLI bundle 和共享 manager 源码，构建与 pack 门禁会检查这些运行时文件。

这次没有把 Pi 会话改为调用外部 Pi 可执行文件，也没有改变 Codex transport、会话契约或 UI。`/api/health` 仅新增服务标识与托管实例身份字段，原有 `ok`、`version` 保持不变；正常 daemon 识别不再依赖 `ps`。Windows npm `.cmd` shim 的真实主机行为尚未在本次 macOS/Linux CI 范围内验证；探测保持无 shell，后续需要在 Windows CI 单独覆盖。

## Verification

- `npm run notes:check`、`npm run typecheck` 与 `git diff --check` 通过。
- launcher、探测、manager、legacy 参数及 pack 门禁聚焦测试 26/26 通过；包含真实 0.1.109 health/state daemon 接管、并发 winner 状态隔离与错误 health 拒绝。`npm test` 最终完整测试 293/293 通过。
- `npm run build` 生成 `dist/index.js`、`dist/cli.js` 与前端产物；`npm run pack:check` 通过，包体约 62.43 MiB packed、173.11 MiB unpacked，共 3105 个文件。
- `npm pack --dry-run --json --ignore-scripts` 通过；实际 `0.1.110` tarball 解包后，独立 bin 的 `--version`、`--help` 与 Pi/Codex 都缺失的 `doctor` 均可运行。
- 使用隔离状态目录和临时端口 3246，由最终实际 tarball 解包副本启动、仓库副本查询并重启、再由解包副本查询并停止。跨安装副本共享同一实例身份，初始及重启后的 host 都是 `0.0.0.0`，health 返回版本 `0.1.110`，停止后 3246 listener 与 pid/port/host/instance 状态已清理。
- 未安装全局包、未修改用户正式 daemon 状态、未启动或重启受保护的 3141 服务。
