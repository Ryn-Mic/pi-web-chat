# Agent Note: File Viewer 运行资产单副本分发

Status: implemented

## Problem

`@ryn-mic/web-chat` 曾在构建时把 `file-viewer-copy-assets` 的完整离线运行时复制到 `dist/public/file-viewer/`，而 `@file-viewer/react-full` 又依赖同一份 `file-viewer-copy-assets@2.2.8`。npm 安装因此同时下载主包内的复制品与依赖包原件，并在磁盘保留两套几乎完全相同的 Worker、WASM、字体和 vendor 资源。

已发布 `0.1.108` 的主 tarball 为 62.41 MiB，改动前 `0.1.111` dry-run 为 62.43 MiB packed、173.13 MiB unpacked、3105 个文件；其中 `dist/public/file-viewer/` 占 152.30 MiB unpacked。完整格式支持本身仍需要一份大型离线资产，但主包没有理由再携带第二份。

## Decision

将精确版本的 `file-viewer-copy-assets@2.2.8` 声明为直接运行时依赖，作为完整预览资产的唯一权威副本。`@file-viewer/core`、`@file-viewer/react-full` 与 `@file-viewer/vite-plugin` 仅用于构建前端，全部移入 devDependencies 并精确锁定为 `2.2.8`；发布给用户的前端 bundle 与唯一资产依赖因此保持同版，生产安装不再解析未被运行时源码直接加载的 renderer package tree。

Vite 保留 full preset 的 lazy renderer 图，但关闭 `copyAssets`，不再向 `public/file-viewer/` 或 `dist/public/file-viewer/` 复制资源。二进制 PPT 的 module、Worker、WASM 与 CJK font URL 显式指向 `/file-viewer/vendor/ppt/`；presentation renderer 的构建期 `@file-viewer/ppt` fallback 被 scoped virtual stub 取代，避免同一份 16 MiB 字体与 WASM 又进入前端 bundle，并在未来漏配 URL 时给出确定性错误。该 stub 沿用 `file-viewer-*` chunk 命名，因此仍处于既有懒加载和 PWA 非预缓存边界内。

服务端通过包导出的 `file-viewer-copy-assets/package.json` 解析安装位置，并把其 `viewer/` 子目录只读映射到原有 `/file-viewer/*` URL。该路由独立于 `dist/public` 是否存在，因此生产构建和 Vite 开发代理使用同一资产源。

构建门禁改为验证依赖资产树中的 PDF、Office、CAD、通用 WASM、PPT runtime 与嵌入许可证，并拒绝构建目录中的重复资产。仅供构建图校验、且包含构建机模块路径的 inventory 会在断言结束后删除；打包门禁拒绝它和任何 `dist/public/file-viewer` 条目，并将主包上限收紧为 10 MiB packed、30 MiB unpacked。

## Key mechanisms

- 运行时资源根使用 `createRequire(import.meta.url).resolve("file-viewer-copy-assets/package.json")`，不假设 npm 全局、局部、Pi package 或去重后的 `node_modules` 布局。
- `/file-viewer/` 只接受 GET/HEAD。origin-form 与 absolute-form 请求均在任何 API 分发前按原始 path 解码，编码 namespace、dot segment 与反斜杠别名不能被 WHATWG URL 规范化绕过；随后同时执行词法根目录与真实路径约束。畸形编码或 NUL 返回 400，逃逸与 symlink 越界返回 403，缺失资源返回 404，根路径不落入 SPA fallback。
- 静态响应继续复用现有 MIME、ETag、HEAD、`nosniff`、same-origin 与 `Cache-Control: public, max-age=3600, must-revalidate` 语义。
- Vite 开发服务把 `/file-viewer` 代理到同一个 Node 服务。迁移插件只会清理带上游 `flyfish-viewer-assets.json` 标记的旧 `public/file-viewer/`，遇到未知同名目录会拒绝删除。
- 构建同时验证四个 File Viewer 根包声明为精确版本、实际安装版本一致且彼此同版；pack 检查在体积判断前先执行重复资产负向门禁。

## Alternatives considered

- **从 full preset 删除 CAD、3D、Typst、Draw.io、归档或旧 Office 格式** — 能进一步降低总安装体积，但会破坏已经发布的完整格式能力；本次优化不改变产品契约。
- **把重资产改为 CDN 或首次使用时下载** — 能降低初始 npm 安装体积，但引入运行时网络、供应链、离线失败与内网部署问题，不符合现有同源自托管边界。
- **继续把资产复制进主包，只删除已知重复 WASM** — 只能局部节省体积，无法解决两套完整资产同时下载和落盘的问题。
- **保留 `@file-viewer/react-full` 的 caret runtime dependency，再固定一份直接资产依赖** — 用户安装可能把 react-full 解析到另一版本并额外嵌套同版资产，而服务端仍命中根资产，既恢复双份下载又制造 bundle/asset 版本错配。
- **在 postinstall 阶段复制或建立符号链接** — 仍会制造重复文件或依赖平台特定链接行为，并增加全局安装、副本升级和只读环境中的失败面。

## Consequences

`0.1.112` 的实际 npm 清单为 6.78 MiB packed、20.62 MiB unpacked、223 个文件；相对改动前分别下降约 89%、88% 与 93%。主 tarball 不再包含 `dist/public/file-viewer/`，也不再重复打包二进制 PPT 的 CJK 字体与 WASM。

PDF、Office、CAD、3D、Typst、Draw.io、归档等现有能力和 `/file-viewer/*` URL 均保持不变，且仍支持离线、同源和内网部署。完整安装仍需下载一份约 55.63 MiB packed 的 File Viewer 资产依赖；这次收益是消除第二份下载、约 152 MiB 的重复解压占用和无用生产 renderer 依赖树，而不是删除全格式运行时本身。

上游若改变资产布局、package export 或版本关系，构建与真实 tarball 验证会在发布前失败。本应用必须继续为所有 File Viewer 实例传入记录在 options 中的 `/file-viewer/vendor/ppt/` URL；若遗漏，scoped fallback stub 会明确报错，单元测试与构建负向门禁还会拒绝重资产或裸包导入重新进入产物。

## Verification

- `npm run typecheck`、`npm run notes:check` 与 `git diff --check` 通过。
- File Viewer 根解析、路径逃逸、symlink 越界、NUL、GET/HEAD/POST、MIME、缓存、PPT runtime URL 与 pack 负向门禁聚焦测试通过；`npm test` 完整测试 311/311 通过。
- `npm run build` 验证四个 File Viewer 根包同为 `2.2.8`、代表性离线资产与许可证存在、`dist/public/file-viewer/` 和 bundle 内 PPT 重资产均不存在、lazy graph 与 PWA precache 边界保持不变。
- Playwright 文件预览回归 6/6 通过，覆盖桌面、移动 iframe、消息文件链接、Git surface 与主动内容隔离。
- `npm run pack:check` 与独立 `npm pack --dry-run --json --ignore-scripts` 通过：7,113,428 bytes packed、21,616,446 bytes unpacked、223 个文件，没有重复资产前缀或 build-only inventory。
- 实际 `0.1.112` tarball 在空目录安装后，`pi-web-chat --version` 返回 `0.1.112`；隔离服务在随机端口启动，health 返回目标版本，资产清单、PPT ESM module 与 PPT WASM 均返回 HTTP 200。
- 未安装全局包、未修改或重启受保护的 3141 服务；tarball smoke 的临时安装目录已删除。
