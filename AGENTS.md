# pi-web-chat Agent Guide

## 项目范围

- 本项目为 pi 与 Codex coding agent 提供移动端友好的 Web UI。
- 运行栈为 Node.js 22.19+、pi SDK、HTTP/WebSocket、React 19、TanStack Router/Query、Tailwind CSS、Vite 与 PWA。
- `dist/index.js`、`dist/cli.js` 和 `dist/public/` 是 `npm run build` 生成的发布产物，禁止直接编辑。
- 本文件是 Agent 与贡献者的强制工程规范；完整文档分类与权威性见 [文档索引](docs/README.md)。

## 文档入口

- [README.md](README.md)：默认且唯一权威的中文用户文档。
- [docs/README.md](docs/README.md)：文档总索引、权威性和维护规则。
- [docs/iconography.md](docs/iconography.md)：GrokBot 与 Morphicons 视觉标准。
- [release-notes.json](release-notes.json)：版本对应的用户可见变更。
- [write-notes-like-deepseek](.agents/skills/write-notes-like-deepseek/SKILL.md)：决策记录格式与生命周期。
- `.github/workflows/ci.yml`、`.github/workflows/release.yml`：CI 与发布行为的事实源。

## 架构地图

- `bin/pi-web-chat.mjs`、`cli/`：独立 npm 命令、Agent CLI 探测与输出适配。
- `extensions/daemon-manager.ts`：独立 CLI 与 Pi 兼容入口共享的托管 daemon 生命周期及状态文件。
- `extensions/pi-web-chat.ts`：pi package 兼容入口；实现 `pi --web` 与 `/web`。
- `server/index.ts`：HTTP API、WebSocket、认证、会话 runtime、静态资源与优雅退出。
- `server/session-*.ts`、`server/serialize.ts`：JSONL 索引、活动分支分页/同步与 UI 序列化。
- `server/files.ts`、`server/file-content.ts`、`server/git.ts`：受 cwd 约束的文件、预览与 Git API。
- `shared/protocol.ts`、`shared/snapshot.ts`：服务端与客户端的权威协议、快照增量语义。
- `src/lib/chat.ts`：连接、重连/重放、会话状态、历史分页与命令传输。
- `src/components/`：界面组件；`ChatPage.tsx` 组合会话、消息、输入框、文件与 Git 表面。
- `src/main.tsx`：认证入口及 `/`、`/s/:sessionId` 路由。
- `tests/`：Node 测试；`tests/e2e/`：Playwright 浏览器覆盖。

## 不可破坏的不变量

- 协议变更必须原子完成：同步更新 `shared/protocol.ts`、生产者、消费者、重连/完整快照路径及测试。
- 会话彼此独立。必须保留各自的 cwd、runtime、socket generation、history cursor、optimistic state 与 preview workspace；会话工具不得回退到 Web 服务器进程 cwd。
- JSONL 会话有分支且可能很大。只操作活动分支，保留 tool-call/result 配对并分页读取；日常 UI 操作不得全量重解析 transcript。
- `isStreaming` 只是提示。停止任务前必须结合 session API、JSONL 事件/mtime、进程状态和上游错误诊断。
- 所有 API 与 WebSocket 路由必须保留认证及 cwd/path 授权。不得打印、提交或返回 access token、TOTP secret、API key 与会话凭据。
- 仅独立 `pi-web-chat` CLI 或 Pi 兼容入口启动的托管 daemon 可更新 `~/.pi/web-chat/pi-web-chat.{pid,port,host,instance}`；调试服务不得写入托管状态。
- 必须保持 PWA、文件预览隔离、缓存和懒加载边界；构建仍须通过 `scripts/build.mjs` 的门禁。

## Git 与版本交付

- **禁止直接向 `main` push，也禁止在本地合并后再推送 `main`；所有改动必须通过远程 Pull Request 合并。**
- 新需求开始前，先检查工作区并刷新 `origin/main`，再从最新 `origin/main` 创建唯一的版本分支 `v<semver>`，例如 `v1.0.7`。创建前必须确认本地与远程均未占用该版本。
- 一个版本分支只承载一次边界清晰的交付，不得复用已发布版本或把无关改动混入同一版本。
- 每次交付都必须递增 patch 版本；同步 `package.json`、`package-lock.json` 顶层与根 package 两处版本，并在 `release-notes.json` 添加同版本用户可见说明。
- 完成实现、决策记录和必要验证后，提交并 push 版本分支到远程仓库。新需求本身授权这一分支交付步骤，但不自动授权合并、打 tag 或发布。
- 需要合并时，必须创建 PR、等待远程检查成功，再通过 PR 合入 `main`；需要发布时，tag 只能指向已合入 `main` 的提交。
- commit、版本分支 push、PR 和 `main` 合并都不是发布触发器。只有 push `v*` tag，或手动运行 Release workflow 并指定已有 tag，才会重新打包并创建 GitHub Release/npm 发布。
- 某次提交不需要重新打包或发布时，不创建/推送 tag，也不手动运行 Release workflow。`npm run pack:check` 与 CI 中的 `npm pack --dry-run` 只是验证，不会上传产物或发布 npm。
- 版本分支与发布 tag 同名时，合并后先删除远程版本分支再创建 tag；若短暂共存，Git 命令必须显式使用 `refs/heads/...` 或 `refs/tags/...`，避免 ref 歧义。

## 决策留痕

重要改动或重要决定，包括行为、架构、契约、流程、落盘格式，以及动手前的选型与否决，必须执行
[write-notes-like-deepseek](.agents/skills/write-notes-like-deepseek/SKILL.md)：

- 形成方案时先写 `proposed`；落地后最晚与代码同一次提交更新为 `implemented`。
- 值得保留以防重复踩坑的否决写为 `rejected`。
- 每篇 Note 必须包含 `## Alternatives considered`。
- 同一决定更新原 Note，不重复新建；路径使用 `.agents/notes/{lifecycle}/{class}/yyyy-mm-dd-topic.md`。
- 只改格式、无歧义重命名或错别字时不创建 Note，并在交付说明中标记 `not applicable`。
- 提交前运行 `npm run notes:check`，保证生命周期、分类、文件名与正文格式一致。

## 视觉与图标标准

- GrokBot 是 Agent 身份、表情与运行状态的唯一人格化视觉语言；统一复用 `AgentEyes`、`AgentIcon` 及现有 activity/persona/theme 映射，不得把 GrokBot 当作普通按钮图标。
- 动作、导航、切换与反馈图标统一使用 [Morphicons](https://github.com/guillermolg00/morphicons)。图形路径集中登记在 `src/lib/morph-icons.ts`，通过 `src/components/MorphIcons.tsx` 等语义组件复用。
- 新业务代码不得使用裸 `<svg>`、Unicode 或 emoji 充当功能图标；存量不要求一次性重写，触达相关组件时迁移。
- 动画必须遵循 `reducedMotion="user"`。装饰图标使用 `aria-hidden`；纯图标按钮必须提供国际化 `aria-label`，状态不得只依赖颜色、动画或表情传达。
- PWA/品牌安装资产、用户内容、文件预览及第三方品牌 Logo 属于例外，但必须保留来源、许可证与必要的可访问文本。
- 完整语义、例外与检查清单见 [视觉与图标规范](docs/iconography.md)。

## 变更纪律

- 开始时运行 `git status --short --branch` 并检查范围。保留用户已有修改；不得 reset、clean、stash、广泛 stage 或提交无关文件。
- 优先复用现有模块与测试，避免平行抽象；修复可复现缺陷时增加回归测试。
- 除版本分支的提交/push 规则外，安装依赖、停止会话、删除状态、合并、发布或修改其他远程系统仍需用户明确授权。
- 不得把编辑生成产物、vendor 资产、session JSONL 或 `~/.pi` 状态当作源码修复。

## 验证矩阵

- 决策或流程变更：`npm run notes:check`。
- TypeScript 变更：`npm run typecheck`。
- 源码行为变更：先运行聚焦测试，再运行 `npm test`。
- UI 行为变更：验证真实浏览器流程；相关时覆盖重连、会话切换与长会话，并明确未测设备边界。
- build/server/package 变更：`npm run build` 与 `git diff --check`。
- package/release 变更：再运行 `npm run pack:check` 与 `npm pack --dry-run`。
- 不得把单元测试描述为浏览器、多会话、移动设备或生产验收。

## 运行时与端口安全

- **托管 restart 必须显式写出端口：优先使用 `pi-web-chat 3141 restart`，兼容入口使用 `pi --web 3141 restart`；禁止裸执行。**
- `3141` 是受保护的生产端口。重启后必须验证：
  - `pi-web-chat status`（或兼容的 `pi --web status`）显示 `127.0.0.1:3141`；
  - `curl -fsS http://127.0.0.1:3141/api/health` 返回 HTTP 200 与目标版本；
  - `lsof -nP -iTCP:3141 -sTCP:LISTEN` 显示托管服务。
- 调试使用其他端口，例如 `PORT=3242 npm run dev:server` 与 `PI_WEB_DEV_PORT=3242 npm run dev:web`。
- 生产 3141 运行时不得执行默认 `npm run dev`。只可按已知 PID/session 停止调试进程，之后确认调试端口释放且 3141 健康。
- 本地生产交付前先构建；如用户授权刷新独立安装，安装目标 npm 包后执行 `pi-web-chat 3141 restart`。仅在继续使用 Pi 扩展安装时运行 `pi update /Users/ryn/Documents/tmp/pi-web-chat --approve --force` 与 `pi --web 3141 restart`。

## 完成定义

- 请求行为已实现，且没有混入无关改动。
- 当前分支名、package 版本、lockfile 与 release notes 一致。
- 非平凡决定已流转为 `implemented`；豁免项明确标记 `not applicable`。
- 适用的测试、类型检查、构建、Note、diff、打包及浏览器/运行时验证通过。
- 版本分支已提交并 push；`main` 未被直接推送。
- 若重启过服务，没有残留调试 listener 或过期 daemon 状态，3141 保持健康。
- 交付说明必须写清变更、验证、分支/提交/远程状态、当前运行时端口及未验证边界。
