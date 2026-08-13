# 会话项目文件预览设计（2026-08-13）

## 目标

在已经实现的会话项目文件树上增加只读文件预览：

1. 桌面端把右侧文件区域升级为多文件 tab 工作区，直接嵌入 `@file-viewer/react-full`。
2. 移动端点击文件后关闭文件树抽屉，以同源全屏 iframe 展示专用预览页面。
3. 文件树单击主操作改为预览；`@相对路径` 引用保留为文件行尾的独立按钮。
4. 预览始终跟随当前聊天 tab 的项目，不能读取任意本地路径。

## 已批准决策

| 决策点 | 选择 | 说明 |
|---|---|---|
| 第三方库 | `@file-viewer/react-full@^2.2.8` + `@file-viewer/core@^2.2.8` + `@file-viewer/vite-plugin@^2.2.8` | React full package 内置 `preset-all`；core 的 `headless` 子路径提供 precheck；均为 Apache-2.0 |
| 桌面形态 | 固定 Files tab + 多文件预览 tabs | 每个打开文件形成可关闭 tab |
| 移动形态 | 全屏覆盖页中的同源 iframe | 不是抽屉内替换，也不新开浏览器窗口 |
| 文件行主操作 | 单击预览 | 行尾独立 `@` 按钮插入 Composer |
| 文件大小 | 服务端统一 100 MiB 上限 | 超限返回 413，不把任意大文件读入浏览器 |
| tab 资源策略 | 每个聊天 tab 最多 8 个文件 tab；仅激活项挂载 viewer | 打开第 9 个时淘汰最久未激活且非当前的文件 tab |
| 桌面密度 | viewer 默认 `comfortable` | 不传 `ui.density`，跟随库默认值 |
| 移动密度 | `ui.density: "compact"` | 工具栏、列表和小按钮使用紧凑密度 |
| 自适应 | 使用 viewer 内建首次适配与容器 resize 适配 | 不传不存在的 `fit: "auto"` 配置 |
| viewer 输入 | 宿主鉴权 fetch 后构造具名 `File` | 文件名扩展名用于 renderer 选型；不把 Authorization header 交给第三方内部 fetch |

## 第三方能力与约束

调研以官方仓库、npm 包和官方文档为准：

- 仓库：<https://github.com/flyfish-dev/file-viewer>
- React Full：<https://www.npmjs.com/package/@file-viewer/react-full>
- Vite plugin：<https://www.npmjs.com/package/@file-viewer/vite-plugin>
- API 文档：<https://doc.file-viewer.app/guide/usage>
- 资产部署：<https://doc.file-viewer.app/guide/distribution>

当前官方版本 `2.2.8`：

- full package 支持 25 条预览 pipeline、208 个扩展名，renderer 按需加载。
- React 组件接受 `url`、`file`、`buffer`、`name`、`filename`、`type`、`size` 和 `options`。
- `ui.density` 只有 `comfortable | compact`，默认 `comfortable`。
- full package 默认从 deployment base 下的 `/file-viewer/` 加载 Worker、WASM、PDF、Office、CAD、字体和 vendor 资产。
- Vite 项目必须注册 `fileViewerRenderers({ copyAssets: true })`；不能再安装或传入另一份 `preset-all`。
- viewer 主题支持 `light | dark | system`；内置 locale 精确为 `zh-CN | en-US | ja-JP`。本项目 zh/en/ja 显式映射，ko 固定 fallback `en-US`，外围 shell 仍使用本项目韩语。
- `precheckFileViewerSource` 只从 `@file-viewer/core/headless` 导出，`react-full` 不重导出；因此 core 必须是直接 dependency，不能依赖 npm hoist 偶然可解析。
- 这些依赖均为 Apache-2.0。最终 npm 包必须包含第三方声明与许可证副本。

## 信息架构

### 桌面右侧工作区

右侧区域仍是 `ChatPage` 根 flex 的兄弟列，但从单一 `FilesSidebar` 升级为 `FileWorkspaceSidebar`：

```text
┌──────────── Chat ────────────┬────────── Right workspace ──────────┐
│                              │ [Files] [report.pdf ×] [model.step ×]│
│                              ├──────────────────────────────────────┤
│                              │ Files: 目录树 + 每行 @ 按钮          │
│                              │ File: 当前激活文件的 viewer          │
└──────────────────────────────┴──────────────────────────────────────┘
```

- `Files` 是固定首 tab，不可关闭。
- 文件 tab identity 为规范化 `(cwd, relativePath)`；同一路径重复选择只激活，不新建。
- 文件 tab 标签显示 basename，`title` 显示完整相对路径；相同 basename 仍以完整 identity 区分。
- 每个聊天 workspace tab 最多保留 8 个文件 tab。打开第 9 个时淘汰 `lastActiveAt` 最小且不是当前激活项的 tab；若时间相同，淘汰 tabs 数组中最靠左者，保证测试确定性。
- 仅激活文件挂载 viewer。切换、关闭或切换聊天 tab 时 abort 当前 fetch 并卸载 viewer。
- 关闭激活 tab 后激活左邻文件；无文件 tab 时回到 `Files`。
- 再次点击当前激活文件不重载；刷新按钮只刷新当前文件。
- Files tab 保持当前 `w-64`。文件预览激活时右侧宽度为 `22rem`（md）、`min(46vw, 48rem)`（lg+）。聊天主列保持 `min-w-0` 并至少保留 Composer 的 20rem 可操作宽度；左右 dock 同时打开且 viewport 不足时，右侧保持 22rem、聊天内部正常截断/滚动，不覆盖内容。
- 桌面头部文件按钮继续控制整个右侧工作区显示/隐藏；隐藏不清空 per-tab 预览列表。

### 移动全屏预览

- `FilesDrawer` 仍只显示目录树。
- 点击文件后关闭 drawer，打开 `MobileFilePreview`，覆盖聊天内容区。
- 顶部紧凑工具栏包含：返回文件树、截断文件名、关闭。触控目标至少 44px。
- “返回文件树”关闭预览并重新打开右侧文件抽屉；“关闭”只回到聊天。
- 下方 iframe 填满剩余高度，使用 `100dvh` 与 top/bottom safe-area，不遮挡工具栏和系统手势区。
- iframe 指向同源 `/file-preview.html#context=<opaque-id>`。capability 放在 fragment 中，不进入初始 HTML 请求、服务端访问日志或 Referer；URL 不携带绝对 cwd、相对路径或长期 session token。
- iframe 使用 `sandbox="allow-scripts allow-same-origin"`；viewer 下载/打印/export 均禁用，因此不授予 `allow-downloads`。`allow-scripts + allow-same-origin` 只提供运行与布局隔离，不被视为恶意内容安全沙箱。
- 浏览器后退键优先退出移动预览。实现使用 history state：打开时 push 一层，关闭时消费该层；直接进入 `/file-preview` 的 iframe 文档不进入主聊天路由历史。
- 移动端一次只打开一个文件，不保留多文件 tab。重新打开同一文件也创建新的短时上下文。

## 状态模型与组件边界

### `src/lib/file-preview.ts`

提供纯 reducer 和外部 store：

```ts
interface PreviewTab {
  cwd: string;
  path: string;
  name: string;
  lastActiveAt: number;
}

interface PreviewWorkspaceState {
  active: "files" | string; // string = cwd/path identity
  tabs: PreviewTab[];
}
```

- 状态按 `chatClient.activeTabKey` 隔离。正常 `session_bound` 会保持 draft key 稳定，因此首次发送不丢预览状态。若绑定目标 session 已在另一 tab 打开，`SessionWorkspace.handleBound` 会丢弃重复 draft client；该分支必须把 losing key 的预览 tabs 去重/LRU 合并到 surviving key，再清理 losing key。
- 只保存在内存，不写 localStorage：文件可能已移动，跨浏览器重启恢复旧预览没有可靠价值。
- `openPreview(tabKey, cwd, path)`、`activatePreview`、`closePreview`、`showFilesTab`、`clearPreviewWorkspace` 都通过纯 reducer 更新，方便 node:test。
- 聊天 tab 被关闭时清理对应预览状态；当前 `SessionWorkspace.close` 后增加显式清理接线，避免内存残留。
- 移动 overlay open/context 状态不进入该桌面 reducer；由 `MobileFilePreview` 宿主局部维护。

### 组件职责

- `FileTreePanel`：只渲染树；文件行调用 `onPreviewFile({cwd,path,name})`，行尾 `@` 按钮调用 `chatClient.insertComposerText`。`@` 按钮必须 `stopPropagation`，不能同时打开预览。
- `FileWorkspaceTabs`：桌面 tablist、关闭/激活键盘语义、横向滚动。
- `FileWorkspaceSidebar`：读取 active chat tab 的 preview store，渲染 Files 或 `FilePreviewPane`。
- `FilePreviewPane`：fetch metadata/content、构造 `File`、调用 precheck、挂载 viewer、管理 abort/loading/error/retry。
- `MobileFilePreview`：创建 preview context、管理全屏 shell 与 iframe，不直接挂载 viewer。
- `src/file-preview-main.tsx`：专用 Vite 第二入口，不导入 `ChatPage`、`ChatClient`、AuthGate 或聊天 router；读取 opaque context ID，兑换 metadata/content，构造 `File`，以 compact options 挂载同一 `FileViewerSurface`。
- `FileViewerSurface`：唯一第三方适配层，收敛主题、locale、toolbar、density、事件和错误转换。通过 `React.lazy(() => import("@file-viewer/react-full"))` 或等价动态 import 只在首次预览时加载；聊天初始 bundle 不得静态包含 full preset。业务组件不得散落第三方 options。

## 服务端文件边界

### 共享解析原语

在 `server/files.ts` 增加 `resolvePreviewFile(root, rel)`，供所有预览端点复用：

1. 调用现有 `assertInsideRoot`，拒绝绝对路径、`..` 逃逸和任何 symlink directory segment。
2. 使用 `lstat` 检查最终节点。目录、socket、device、FIFO 均拒绝。为保持现有文件树语义，最终节点若是 symlink 可在以下条件下预览：symlink 本身位于 root 内、`realpath` 目标仍位于同一 root 内、目标是普通文件、目标路径同样不命中硬排除或 root `.gitignore`。指向 root 外、目录或特殊节点的 symlink 拒绝。
3. 把相对路径规范为 POSIX 分隔符后，应用与目录树一致的硬排除 `.git`/`node_modules` 和 root `.gitignore`。被排除路径返回 404，避免泄露其存在性。
4. `stat.size > 100 * 1024 * 1024` 返回专用 `PreviewTooLargeError`。
5. 返回 `{ abs, realAbs, path, name, size, mimeType, mtimeMs, etag }`。MIME 按用户可见路径扩展名映射，未知类型使用 `application/octet-stream`；ETag 由 size + mtimeMs + 文件标识生成弱 ETag。
6. 打开响应流时先以只读 fd 打开，再 `fstat` 确认仍是普通文件且 size/mtime/文件标识与 metadata 一致；流从该 fd 创建，减少检查到使用间的替换窗口。

### 桌面文件 API

```http
HEAD /api/files/content?cwd=<root>&path=<relative>
GET  /api/files/content?cwd=<root>&path=<relative>
```

- 位于既有 `/api/*` session token 校验之后。
- cwd 必须命中 `knownProjectRoots()`；不命中 403。
- `HEAD` 返回 metadata headers 和 `ETag`，不返回 body；桌面随后发送 `GET` + `If-Match: <etag>`。文件变化或条件不匹配返回 409，客户端重新 HEAD 后再重试。`GET` 从已校验 fd 创建 stream，不把 100 MiB 文件整体读入 Node 内存。
- 首期不实现 Range。viewer 宿主完整 fetch blob 后构造 `File`；媒体文件也受相同 100 MiB 限制。100 MiB 是传输上限，不是浏览器峰值内存承诺；renderer 可能复制/解压数据，移动端出现内存或兼容错误时立即终止，不后台重试多实例。
- 响应 headers：
  - `Content-Type`
  - `Content-Length`
  - `Content-Disposition: inline; filename*=UTF-8''...`
  - `X-Content-Type-Options: nosniff`
  - `Cache-Control: private, no-store`
  - `Cross-Origin-Resource-Policy: same-origin`
- 错误映射：逃逸/非普通文件 400；未知 cwd/权限 403；不存在/被 ignore 404；超限 413；方法不允许 405。

### 移动 preview context API

```http
POST /api/files/preview-context
Authorization: Bearer <session-token>
Content-Type: application/json

{ "cwd": "...", "path": "...", "theme": "light|dark", "locale": "en|zh|ja|ko" }

→ { "id": "<128-bit opaque base64url>", "expiresAt": "..." }

HEAD /api/files/preview-content
Authorization: Preview <opaque-id>

GET  /api/files/preview-content
Authorization: Preview <opaque-id>
```

- `POST /api/files/preview-context` 位于现有全局 `/api/*` bearer gate 之后；创建时执行与桌面 API 完全相同的 cwd/path/filter/symlink/size 校验。
- `HEAD/GET /api/files/preview-content` 必须在 `server/index.ts` 的全局 `/api/*` bearer gate **之前**精确匹配并分发；它只接受 `Authorization: Preview <opaque-id>`，不接受 Bearer、query ID、cwd 或 path。其余 `/api/*` 路由顺序不变。
- ID 使用 `randomBytes(16)` 生成 base64url，不可枚举。服务端只保存 ID 的 SHA-256 hash，原始 capability 只在创建响应中返回。记录还包含规范化 root/path、name、size、mtime、mime、theme、locale、创建认证 session token 的 SHA-256 指纹、`firstUseExpiresAt` 和 `contentExpiresAt`。
- 现有认证只有 Authorization bearer，没有 HttpOnly cookie；iframe 不读取父页 localStorage。因此 opaque ID 本身是短时 bearer capability。token 指纹用于 logout 清理和审计，不要求 iframe 重新提交长期 token。
- 首次 `HEAD` 或 `GET` 必须在创建后 5 分钟内发生；首次成功后 context 可重复读取至首次使用后 10 分钟，支持慢网加载 frame bundle、viewer metadata/content 重试和 iframe 刷新。并发 HEAD/GET 对首次使用使用同一原子状态转换，不能因竞态互相失效。
- 每次读取都重新运行 `resolvePreviewFile`，并要求 size/mtime 与创建时一致；变化则返回 409 “file changed”。
- context 到期、logout 或进程重启后返回 410；定时清理过期 Map 项。现有 Auth 不暴露 session-revocation 事件，因此本期只保证 logout HTTP handler 清理：handler 在 `auth.logout(token)` 前计算 token 指纹并调用 preview context store 删除对应项。30 天自然 session 过期不会主动扫描 contexts，但 context 自身最长 10 分钟，边界可接受。
- 单个认证 session 指纹最多 16 个活动 context；创建第 17 个时淘汰 `createdAt` 最早项，时间相同按 Map 插入顺序，防止无界增长。移动 UI 一次只存在一个 iframe，打开下一个文件前会卸载旧 iframe，因此 FIFO 不会淘汰仍在屏幕中使用的 context。
- content endpoint 只接受 Preview Authorization scheme，不接受 query/path ID 或 cwd/path override；capability 不出现在 HTTP path 和常规访问日志中。
- 返回文件 headers 与桌面 API 相同，并在 HEAD/GET 增加 `X-Preview-Theme: light|dark`、`X-Preview-Locale: en-US|zh-CN|ja-JP`。创建时 ko 已归一化为 `en-US`；frame 只接受这些枚举，未知值回退 `light`/`en-US`。

## 前端加载数据流

### 桌面

1. 用户单击文件行。
2. `openPreview(activeTabKey, snapshot.cwd, node.path)` 去重或按 LRU 新建 tab。
3. `FilePreviewPane` 先发送 `HEAD /api/files/content` 获取 filename/size/MIME/ETag，展示 metadata 与 loading shell。
4. 发送带 Authorization 与 `If-Match` 的 `GET`，通过 `AbortController` 获取 Blob；409 时清除 metadata 并重新 HEAD，最多自动重试一次。
5. 构造 `new File([blob], name, { type: blob.type || mimeType })`。
6. 调用官方 `precheckFileViewerSource(file)`；明显不支持或损坏时显示本项目错误 UI，不挂载 viewer。
7. 挂载 `FileViewerSurface file={file}`。viewer renderer 仍是最终解析权威。
8. 切 tab、关闭 workspace 或切聊天 tab时 abort fetch 并卸载 viewer。

同一激活 tab 在一次挂载期间保留 `File`；不跨文件 tab缓存 Blob。HTTP 响应是 `no-store`，避免把项目私有文件写入浏览器持久缓存。

### 移动

1. 文件行调用父页 `openMobilePreview(cwd,path)`；drawer 关闭。
2. 父页 POST 创建 context，成功后展示全屏 shell 并设置 iframe src。
3. iframe 加载独立 `file-preview.html` 入口，不经过聊天 `AuthGate/router`，构建依赖图中不包含 ChatClient、Composer 或任意 cwd/path API。
4. frame entry 从 `location.hash` 读取 context ID，立即用 `history.replaceState` 清除 fragment，再用 `Authorization: Preview <id>` 对固定 `/api/files/preview-content` 做 HEAD/GET。它从标准 headers 读取 name/size/MIME，从受控 `X-Preview-*` headers 读取 theme/locale，构造具名 `File`，precheck 后挂载 compact `FileViewerSurface`。原始 ID只保存在该组件内存到请求结束。
5. iframe 通过 `postMessage` 只发送 `{type:"file-preview-ready"}` 或 `{type:"file-preview-error", code}`。父页验证 `event.origin === location.origin`、`event.source === iframe.contentWindow` 和已知 type。
6. 关闭父页 overlay 会卸载 iframe；服务端 context 等待过期清理。

## Viewer options

第三方配置集中在 `src/lib/file-viewer-options.ts`：

```ts
function createFileViewerOptions(input: {
  mobile: boolean;
  theme: "light" | "dark";
  locale: "en-US" | "zh-CN" | "ja-JP";
}) {
  return {
    theme: input.theme,
    locale: input.locale,
    styleIsolation: "shadow" as const,
    ...(input.mobile ? { ui: { density: "compact" as const } } : {}),
    toolbar: {
      position: "bottom-right" as const,
      download: false,
      print: false,
      exportHtml: false,
      zoom: true,
    },
  };
}
```

- 桌面不传 `ui.density`，保留 `comfortable` 默认。
- 移动显式 `compact`。
- 不传 `fit: "auto"`；各 renderer 根据初次布局与 ResizeObserver 自动适配。
- viewer 内下载/打印/export 禁用，避免绕过应用权限与把私有文件产生额外副本；本期不在外层新增下载按钮。
- theme/locale 映射以本项目状态为源：en→`en-US`、zh→`zh-CN`、ja→`ja-JP`、ko→`en-US`。外围 loading/error/toolbar 继续使用本项目四语言文案。

## 入口、构建与静态资产

- 保持 `src/main.tsx` 和聊天 router 不变。新增根 `file-preview.html` 与 `src/file-preview-main.tsx`，通过 Vite `build.rollupOptions.input` 构建为 `dist/public/file-preview.html`。
- frame entry 不使用 `AuthGate`，不读取长期 token；只用 context capability 鉴权。共享的 `FileViewerSurface`/options 可进入 Vite 公共 chunk，但聊天 client/router 不得进入 frame entry 的静态依赖图。
- `vite.config.ts` 注册 `fileViewerRenderers({ copyAssets: true })`，输出到 `dist/public/file-viewer/`。
- Workbox 显式设置 `globIgnores: ["file-viewer/**"]`，整个 viewer 资产树均不进入 precache，包括其中的 `.js/.css/.svg/.woff2/.png`；保留按需网络加载和浏览器普通 HTTP cache。通用 `file-preview.html` 可以随 app shell precache，因为它不含 capability 或文件数据。
- `server/index.ts` 的静态 MIME 表补充至少：`.mjs`、`.json`、`.wasm`、`.map`、`.woff`、`.ttf`、`.otf`、`.data`、常见媒体和文档 MIME。未知静态后缀保持 `application/octet-stream`。
- static handler 改为 `createReadStream`，避免大 WASM/data 资产整文件读入 Node 内存。viewer copy-assets 使用稳定路径而非 content hash，升级可能覆盖同名 Worker/WASM；因此 `file-viewer/**` 设置可重验证缓存（`Cache-Control: public, max-age=3600, must-revalidate` + ETag），不能设置一年 immutable。HTML 设置 `Cache-Control: no-cache`。
- 缺失的 `/file-viewer/**` 资产必须直接 404，不能 fallback 到 app `index.html`。所有 API 分发结束后，仍未匹配的 `/api/*` 根据方法返回 404/405 JSON，不能落到 SPA fallback 200。
- 其他静态路径的 fallback 仍限制在 `DIST_DIR` 内，不能因新增资产路径放宽。
- `scripts/build.mjs` 继续调用 Vite；build 验证必须检查 manifest 和代表性的 PDF/Office/CAD/WASM 资产存在，并检查聊天入口 chunk 不静态依赖 full preset chunk。
- `package.json` dependencies 加同版本范围的 `@file-viewer/react-full` 和 `@file-viewer/core`；devDependencies 加 `@file-viewer/vite-plugin`。不单独安装 `preset-all`。
- 新增 `THIRD_PARTY_NOTICES.md`，包含 File Viewer 名称、来源、版本、Apache-2.0 说明和许可证路径；`package.json.files` 加入该文件及 `third-party-licenses/`，保存上游 Apache-2.0 文本。
- `file-viewer-copy-assets@2.2.8` 官方 unpacked payload 约 160 MB，full assets 会显著扩大 `dist`。新增 `scripts/check-pack-size.mjs` 运行 `npm pack --dry-run --json`，记录压缩与 unpacked size并强制压缩 tarball ≤ 150 MiB、unpacked ≤ 500 MiB；`pack:check` 改为 `npm run build && node scripts/check-pack-size.mjs`。超过门限则停止交付并改用标准 package + 明确 presets，而不是静默发布超大包。

## UI 与可访问性

### 文件树行

- 文件名主按钮占剩余宽度，点击预览。
- 行尾 `@` 按钮使用清晰的引用图标/文本符号，固定 32px 可视按钮、移动命中区域至少 44px；`aria-label` 为“引用 {filename}”。
- 主按钮和引用按钮是两个兄弟 button，不嵌套；键盘 Tab 可分别聚焦。
- 当前桌面预览文件行使用 selected 背景和 `aria-current="true"`；颜色不是唯一标识，文件图标同时增强。

### 桌面 tabs

- tab strip 使用 `role="tablist"`；每项 `role="tab"`、`aria-selected`、`aria-controls`；内容 `role="tabpanel"`。
- roving tabindex 支持 ArrowLeft/ArrowRight、Home/End；Delete/Backspace 关闭文件 tab，Files tab不可关闭。
- close button 有独立 `aria-label`，mousedown 不误激活相邻 tab。
- tab strip 横向滚动，不让长路径扩大侧栏；文件名 truncate，title 提供完整路径。

### 状态

- metadata 阶段显示 skeleton；内容 fetch 显示不确定进度，不伪造百分比。
- 错误状态区分：不支持、文件损坏、超 100 MiB、无权限、已删除、已变化、context 过期、viewer renderer 失败。
- 每个错误态提供合适的“重试”“返回文件树”或 `@` 引用操作；不显示绝对 cwd。
- iframe 有描述性 `title`；loading 前保留稳定尺寸；focus 进入预览后关闭时回到触发文件行或文件树按钮。
- 官方注册表把 `.html/.htm/.xml` 分配给 text renderer，按代码文本显示，允许预览。`.svg` 分配给 image renderer并转换为 data URL 后放入 `<img>`；实现必须用专项浏览器测试证明 SVG 内脚本/外链不会执行或访问父页。若该测试失败，`resolvePreviewFile` 固定 deny `.svg` 并显示“不支持该格式”，不能依赖 iframe sandbox 兜底。
- 适配 375px 竖屏、移动横屏、768px 边界、桌面宽屏；不允许 tab、工具栏、iframe 和 safe-area 重叠。

## i18n

`en/zh/ja/ko` 四语言新增完整键：

- `filePreview`、`previewFile`、`referenceFile`
- `filesTab`、`closePreviewTab`、`refreshPreview`
- `previewLoading`、`previewUnsupported`、`previewMalformed`
- `previewTooLarge`、`previewForbidden`、`previewMissing`、`previewChanged`
- `previewExpired`、`previewFailed`、`retryPreview`
- `backToFiles`、`closePreview`

绝对路径只用于 title/debug，不进入普通用户错误文案。

## 错误映射

| 场景 | HTTP / UI |
|---|---|
| cwd 不在 known roots | 403 / 无权限 |
| rel 逃逸、最终节点为目录/特殊节点，或 symlink 指向 root 外/目录/特殊节点 | 400 / 无法预览 |
| `.git`、`node_modules`、`.gitignore` 命中 | 404 / 文件不可用 |
| 文件不存在 | 404 / 文件已删除 |
| 文件超过 100 MiB | 413 / 文件过大，不发起 body fetch |
| metadata 后 size/mtime 变化 | 409 / 文件已变化，可重试创建新请求 |
| context 未首次使用即过 5 分钟 | 410 / 预览已过期 |
| context 首次使用后过 10 分钟 | 410 / 预览已过期 |
| session 经 `/api/auth/logout` 登出 | logout handler 按 token 指纹删除对应 contexts，后续 410 |
| precheck 不支持 | 不挂载 viewer / 不支持该格式 |
| renderer 解析失败 | 卸载 viewer / 文件损坏或预览失败，可重试 |
| Worker/WASM 资产缺失 | 预览失败并记录具体资源路径；build 验证阻止缺资产交付 |

## 测试策略

### 服务端 node:test

- `resolvePreviewFile`：普通文件、path escape、绝对路径、symlink directory segment、最终 file symlink 的 root 内/外目标、目录/特殊节点、硬排除、root `.gitignore`、未知 MIME、100 MiB 边界（等于允许，大于拒绝）。
- content API：auth、`expandHome(cwd)` 后的 known root、HEAD 无 body与ETag、If-Match GET bytes/headers、403/404/409/413/405、客户端断开后 fd/stream 关闭；preview content 的 Preview scheme、固定 URL、theme/locale headers 枚举和无 Bearer/query fallback。
- context store：128-bit ID、5 分钟首次使用、并发首次 HEAD/GET、10 分钟已使用 TTL、每 session 指纹 16 个 FIFO cap、logout handler 清理、不可 override path、文件变化、过期重放。
- 静态 MIME：`.mjs/.wasm/.woff/.ttf/.data` 正确。

### 前端纯函数 node:test

- preview reducer：去重、激活、8 tab LRU 淘汰、关闭邻项、Files 固定 tab、per-chat-tab 隔离、tab close 清理。
- options：桌面不传 density、移动 compact、en/zh/ja 映射、ko→en-US、危险操作关闭、无伪造 fit 字段。
- frame src：capability 只出现在 `file-preview.html` URL fragment；不含 cwd/path/session token，frame 读取后立即清除 fragment；content fetch 使用固定 URL + Preview Authorization header。
- postMessage guard：拒绝错误 origin/source/type。

### 组件与浏览器验证

当前仓库没有 React DOM 测试基础设施。本功能引入 `@playwright/test` 作为开发验证依赖，并新增 `playwright.config.ts`、`tests/e2e/file-preview.spec.ts` 与 `test:e2e` script。配置先执行生产 build，再用临时 `HOME` 启动 `node dist/index.js`，设置固定 `PI_WEB_TOKEN=e2e-token`、`PI_WEB_2FA=off`、临时 `PI_WEB_CWD` 和独立端口；测试通过真实 LoginPage 登录，不读取开发者本机 `~/.pi/web-chat`。首次安装执行 `npx playwright install chromium`，CI 只跑 Chromium；WebKit/iOS 作为本机交付前补充冒烟。覆盖真实浏览器流程：

- 桌面：单击文件打开 tab、重复去重、8 tab LRU、关闭/键盘、Files tab、切聊天 tab 独立恢复。
- 文件行 `@` 按钮只引用不预览；主按钮只预览不引用。
- 移动：drawer → 全屏 iframe、iframe 同源且 URL 不泄漏路径/token、compact chrome、返回文件树、关闭回聊天、后退键。
- light/dark、四语言、375x667、430x932、768x1024、1440x900。
- PDF/图片/Markdown/Office 各一个小 fixture；unsupported、101 MiB sparse fixture、context 过期、文件删除/变化。101 MiB fixture 只用于服务端/E2E 413 检查，不提交真实 101 MiB 内容：测试运行时创建 sparse file 并在结束后删除。
- screenshot + canvas pixel 非空检查，确认 viewer/iframe 非空、无重叠、资源加载无 404；专项验证 `.html/.htm/.xml` 以纯文本显示，恶意 `.svg` 不执行脚本、不发外部请求且不能访问父页。

最终验证：

```bash
npm run typecheck
npm test
npm run build
npm run test:e2e
npm run pack:check
git diff --check
```

## 版本与发布

- 当前基线是 `0.1.68`。实现完成时 patch +1 到 `0.1.69`；若期间版本变化，以实际版本再 +1。
- 同步 `package.json`、`package-lock.json`，并在 `release-notes.json` 新版本键下说明桌面多文件预览、移动 iframe、支持格式和 100 MiB 限制。
- 不复用版本号。审查后的任何独立 bug fix 若形成新发布变更，再按项目规则继续 patch +1。

## 明确不做

- 编辑、保存、重命名、删除文件。
- 把预览文件内容自动附加到聊天消息；`@path` 仍是纯文本引用。
- 服务端 Office/CAD 转换或缩略图生成。
- 文件内容 Range、流式媒体播放或超过 100 MiB 的特殊通道。
- 多个 viewer 实例常驻、跨浏览器重启恢复预览 tabs、跨设备同步。
- 外部 CDN Worker/WASM；所有运行资产同源自托管。
- 暴露绝对本地路径、把长期 session token 放进 iframe URL、允许 iframe 请求任意 cwd/path。
- 自定义第三方 viewer 内部 UI、伪造 `fit: "auto"` 或覆盖 renderer 自适应算法。
