# pi-web-chat

[pi](https://pi.dev) 编码代理的 Web 界面（OpenWebUI 风格，支持移动端）。

[English](./README.md) · [한국어](./README.ko.md)

## 安装与运行

推荐流程：

```bash
# 1) 安装 pi（已安装可跳过）
npm i -g @earendil-works/pi-coding-agent

# 2) 安装 pi-web-chat
pi install npm:pi-web-chat
# pi install /path/to/pi-web-chat          # 本地路径
# pi install git:github.com/preinpost/pi-web-chat@v0.1.1

# 3) 仅启动 Web UI 守护进程（不打开 TUI，立即返回 shell）
pi --web
# → pi-web-chat started — http://localhost:3141

pi --web status
pi --web stop
pi --web restart             # 停止 + 启动（保留原有端口/host）
pi --web 3200                # 自定义端口
pi --web --lan               # 绑定 0.0.0.0（局域网）
pi --web --host 0.0.0.0      # 同上，显式指定绑定地址
pi --web 3200 --host 0.0.0.0
pi --web --token my-secret   # 指定访问令牌（默认自动生成）
pi --web rftoken             # 轮换访问令牌（立即生效）
```

`pi --web` 只启动 Web 服务器守护进程然后退出，不会打开 pi TUI。
如果服务器已在运行，会再次打印访问地址。

> **认证（令牌 + 2FA）：** 服务器对每个 API/WebSocket 调用强制执行访问控制。
> 首次启动时自动生成访问令牌（`~/.pi/web-chat/token`，重启后保留；随时可用
> `pi --web rftoken` 轮换）和本地 TOTP 密钥（`~/.pi/web-chat/2fa.secret`，
> 默认开启 2FA；可用 `PI_WEB_2FA=off` 关闭）。
> 在网页上用「令牌 + 认证器 App 生成的当前 2FA 验证码」登录
> （首次 2FA 设置在登录页扫描二维码完成注册）。

### 其他运行方式

```bash
# 独立 CLI（不在 pi 会话内）
pi-web-chat
# HOST=0.0.0.0 pi-web-chat   # 通过环境变量绑定局域网

# 在 pi 会话内
/web                    # 启动（默认端口 3141，绑定 127.0.0.1）
/web 3200               # 自定义端口
/web --lan              # 绑定 0.0.0.0
/web --host 0.0.0.0     # 显式绑定地址
/web status
/web stop
/web restart
```

状态文件：`~/.pi/web-chat/pi-web-chat.pid`、`pi-web-chat.port`、`pi-web-chat.host`、`pi-web-chat.log`

> `pi install` 只安装生产依赖。前端以构建产物形式随 `dist/public` 发布，终端用户无需安装 Vite/React。

## 开发

```bash
npm install

# 开发（server:3141 + vite:5173，代理 /api 与 /ws）
npm run dev
# → http://localhost:5173

# 生产构建 + 运行
npm run build
npm start
# → http://localhost:3141
```

### 打包检查

```bash
npm run pack:check   # 构建 + npm pack --dry-run
npm pack             # 生成 pi-web-chat-*.tgz
pi install ./pi-web-chat-0.1.1.tgz
# 或直接从目录安装
pi install .
```

本地快速加载扩展：

```bash
npm run build
pi -e .
# 然后在会话中执行 /web
```

### GitHub Actions 发布

仓库中：**Actions → Release → Run workflow**

| 输入 | 说明 |
|---|---|
| `mode` | `release`（升版本 + 打 tag + 发布）或 `publish-only`（用当前 `package.json` 版本直接发布 npm，不改 git） |
| `bump` | `patch` / `minor` / `major`（仅 `release` 模式） |
| `publish_npm` | 打 tag 后发布到 npm（`release` 模式；`publish-only` 始终开启） |
| `dry_run` | 跳过 git push + `npm publish --dry-run` |

**release** 流程：`npm ci` → `typecheck` → `build` → pack check → `npm version <bump>` → push commit/tag → `npm publish`
**publish-only** 流程：`npm ci` → `typecheck` → `build` → pack check → `npm publish`（不升版本、不 push）

当 git tag 已存在但 npm 发布失败时，使用 `publish-only`。

所需密钥：

- `NPM_TOKEN` — npm 自动化令牌（发布步骤）

## 环境变量

- `PORT` — 服务器端口（默认 `3141`）
- `HOST` — 绑定地址（默认 `127.0.0.1`）。仅在可信网络使用 `0.0.0.0`。通过扩展启动时优先用 `pi --web --lan` / `pi --web --host 0.0.0.0`
- `PI_WEB_TOKEN` — 访问令牌（默认自动生成到 `~/.pi/web-chat/token`）
- `PI_WEB_2FA` — 设为 `off` 关闭 TOTP 二次验证（默认开启）
- `PI_WEB_CWD` — 代理工作/会话目录（默认 `~/.pi/web-chat`，不存在则自动创建）

LLM API 认证与 pi CLI 相同，使用 `~/.pi/agent/auth.json`。请先配置好 pi（登录 / API 密钥）。

> **安全：** 应用强制令牌 + 2FA 认证，但 HTTPS 由你负责。
> 远程访问时请放在反向代理（Caddy/nginx）或隧道（Tailscale Serve）后面终结 TLS——
> 切勿在公共网络上以明文 HTTP 发送令牌。

## 技术栈

- **服务端：** Node + [pi SDK](https://pi.dev)（`@earendil-works/pi-coding-agent`）+ WebSocket（`ws`）
- **前端：** React 19 + TanStack Router / Query + Base UI + Tailwind CSS v4 + Vite

## 目录结构

```
bin/pi-web-chat.mjs       CLI 入口（运行 dist/index.js）
extensions/pi-web-chat.ts pi 包扩展（/web、--web）
scripts/build.mjs         vite 前端 + esbuild 服务端打包
server/                   服务端源码
shared/protocol.ts        服务端/客户端共享类型
src/                      前端源码
dist/index.js             构建后的服务端（随包发布）
dist/public/              构建后的前端（随包发布）
```

## 功能特性

- 实时流式输出（文本 / thinking 增量）
- **流式 Markdown 渲染**（Streamdown + Shiki 语法高亮）
- 工具调用展示（bash、edit、read 等），结果可展开；edit 以 git diff 样式呈现
- 会话列表 / 切换 / 新建（可与 pi CLI 会话共享）
- **每会话独立 URL**（`/s/:sessionId`）：每个浏览器标签/设备驱动自己的会话；打开同一 URL 实时同步。`/` 开启新会话
- **会话 fork**：从设置菜单按用户消息分叉
- 模型切换 + **thinking 级别**
- **自定义模型管理**：在设置菜单中直接编辑 `~/.pi/agent/models.json` 添加/编辑自定义提供商与模型（Ollama、LM Studio、vLLM、代理等）
- **图片附件**（文件选择 / 剪贴板粘贴）
- **设置菜单：** 主题（system/light/dark）、语言、模型管理、会话 fork、扩展列表、输入框透明度
- 流式期间发送 → 自动 steering（转向）
- 中止（Abort）
- 移动端：安全区适配、`dvh` 布局、会话抽屉
