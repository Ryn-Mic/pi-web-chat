# 会话项目文件预览实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在现有会话项目文件树上增加安全的只读文件预览：桌面端使用多文件 tabs 原生挂载 File Viewer，移动端使用独立同源 iframe 全屏预览。

**架构：** 服务端以 `resolvePreviewFile` 统一路径、过滤、symlink、大小和 TOCTOU 校验，并分别提供 Bearer 鉴权的桌面内容 API 与短时 opaque capability 的移动内容 API。前端以按聊天 tab 隔离的内存 store 管理桌面预览 tabs，File Viewer 通过单一 lazy 适配层挂载；移动端由父页创建 capability，独立 Vite 入口只持有 capability 并请求固定 content URL。

**技术栈：** Node 20 + node:test、React 19、TypeScript strict + `verbatimModuleSyntax`、Tailwind 4、base-ui Dialog、Vite 7 + vite-plugin-pwa、`@file-viewer/react-full@^2.2.8`、`@file-viewer/core@^2.2.8`、`@file-viewer/vite-plugin@^2.2.8`、Playwright Chromium。

**规格：** `docs/superpowers/specs/2026-08-13-file-preview-design.md`。规格中的安全边界、数值、交互和发布规则优先于本计划中的示例。

---

## 全局约束

- 只在隔离 worktree `/Users/ryn/Documents/tmp/pi-web-chat/.worktrees/file-preview`、分支 `feature/file-preview` 上实现；起点为 `36c7077`，功能基线为 `5cbb090`。
- 严格 TDD：每个生产行为先写测试并观察预期失败，再写最少实现。配置、许可证文本和生成入口可与首次消费它们的行为一起交付。
- 每个 TypeScript 任务结束后运行 `npm run typecheck`。每任务提交一次中文 Conventional Commit，不跨任务捎带重构。
- 不改动现有长期 session token 模型，不把 session token/cwd/path 放入 iframe URL，不允许 iframe 覆盖 capability 绑定的路径。
- 文件上限固定 `100 * 1024 * 1024` bytes；等于上限允许，大于上限返回 413。
- 桌面预览每聊天 tab 最多 8 个文件 tabs；移动端一次只挂载一个 iframe；所有 viewer 下载、打印、HTML 导出均关闭。
- 文件树、搜索与预览共享 `.git`/`node_modules`/root `.gitignore` 语义。最终 symlink 仅在 symlink 和真实目标均位于 root 内且目标为未过滤普通文件时允许。
- 任何未知 `/api/*` 和缺失 `/file-viewer/**` 必须返回 JSON/静态 404/405，不能落入 SPA fallback 200。
- 不采用 ui-ux-pro-max 给出的营销页视觉主题；沿用现有聊天应用的 token、字体、圆角和图标。只采用其通用可访问性、焦点、紧凑密度和 375/768/1440 响应式检查。
- 最终版本从实际当前版本 patch +1；当前基线为 `0.1.68`，预计发布 `0.1.69`。同步 `package.json`、`package-lock.json` 和 `release-notes.json`。

## 文件结构

| 文件 | 职责 | 任务 |
|---|---|---|
| `server/files.ts` | 共享过滤、`resolvePreviewFile`、metadata/ETag、已校验 fd 流 | 1 |
| `server/file-content.ts` | 桌面 HEAD/GET 响应、统一 headers/错误映射、静态 MIME/流式 helper | 2 |
| `server/preview-context.ts` | opaque capability store、TTL/FIFO/session 指纹清理 | 3 |
| `server/index.ts` | desktop/context 路由顺序、known cwd、logout hook、静态 fallback | 2, 3 |
| `tests/files.test.ts` | 文件解析、过滤、symlink、大小和 fd 一致性 | 1 |
| `tests/server-files-api.test.ts` | 真实服务器 desktop/context/static API 合约 | 2, 3 |
| `tests/preview-context.test.ts` | capability store 确定性时间/并发/FIFO 测试 | 3 |
| `src/lib/file-preview.ts` | 桌面 preview reducer/store、tab key merge/cleanup | 4 |
| `src/lib/session-workspace.ts` | tab close/duplicate-bound 生命周期 hook | 4 |
| `src/lib/chat.ts` | 将 workspace 生命周期接到 preview store | 4 |
| `tests/file-preview.test.ts` | reducer、per-tab、LRU、close/merge 测试 | 4 |
| `tests/session-workspace.test.ts` | close/duplicate-bound hook 契约 | 4 |
| `src/lib/file-viewer-options.ts` | theme/locale/density/toolbar 唯一 options builder | 5 |
| `src/components/FileViewerSurface.tsx` | `React.lazy` 的第三方 viewer 唯一适配层 | 5 |
| `vite.config.ts` | viewer assets、Workbox 排除、multi-entry | 5, 8 |
| `scripts/build.mjs` | 构建资产/manifest/lazy chunk 契约验证 | 5, 8 |
| `THIRD_PARTY_NOTICES.md`、`third-party-licenses/Apache-2.0.txt` | 第三方归属与许可证 | 5 |
| `src/lib/file-preview-api.ts` | 桌面 HEAD→If-Match GET、一次 409 重试、错误分类 | 6 |
| `src/components/FilePreviewPane.tsx` | fetch/precheck/loading/error/viewer 生命周期 | 6 |
| `src/components/FileWorkspaceTabs.tsx` | 可访问桌面 tablist 与键盘行为 | 7 |
| `src/components/FileWorkspaceSidebar.tsx` | Files 固定 tab + active viewer 宿主 | 7 |
| `src/components/FileTreePanel.tsx` | 文件主按钮预览、独立 `@` 按钮、移动回调 | 7, 8 |
| `src/components/ChatPage.tsx` | desktop workspace 与 mobile overlay 接线 | 7, 8 |
| `src/lib/file-preview-frame.ts` | capability URL、fragment 消费、postMessage guard | 8 |
| `src/file-preview-main.tsx`、`file-preview.html` | 无 AuthGate/chat router 的移动 iframe 入口 | 8 |
| `src/components/MobileFilePreview.tsx` | 父页 context 创建、history、全屏 shell/iframe | 8 |
| `src/i18n/{en,zh,ja,ko}.ts` | 规格列出的完整预览文案 | 6-8 |
| `playwright.config.ts`、`tests/e2e/file-preview.spec.ts` | 真实登录、桌面/移动/资源/主动内容 E2E | 9 |
| `scripts/check-pack-size.mjs` | npm tarball/unpacked 体积硬门限 | 10 |
| `package.json`、`package-lock.json`、`release-notes.json` | 依赖、脚本、版本和发布说明 | 5, 9, 10 |

---

### 任务 1：建立安全文件预览解析原语

**文件：**
- 修改：`server/files.ts`
- 修改：`tests/files.test.ts`

- [ ] **步骤 1：编写 `resolvePreviewFile` 失败测试**

在 `tests/files.test.ts` 增加真实临时文件测试：

```ts
import { closeSync, ftruncateSync, openSync } from "node:fs";
import {
  openResolvedPreviewFile,
  PreviewTooLargeError,
  resolvePreviewFile,
} from "../server/files.ts";

test("resolvePreviewFile: returns normalized metadata and a stable weak ETag", () => {
  fixture();
  writeFileSync(join(root, "hello.md"), "hello");
  const meta = resolvePreviewFile(root, "hello.md");
  assert.equal(meta.path, "hello.md");
  assert.equal(meta.name, "hello.md");
  assert.equal(meta.size, 5);
  assert.equal(meta.mimeType, "text/markdown");
  assert.match(meta.etag, /^W\/"[^"]+"$/);
});

test("resolvePreviewFile: allows an in-root file symlink but rejects outside and directory targets", () => {
  fixture();
  writeFileSync(join(root, "target.txt"), "ok");
  symlinkSync("target.txt", join(root, "alias.txt"));
  assert.equal(resolvePreviewFile(root, "alias.txt").name, "alias.txt");

  outsideRoot = mkdtempSync(join(tmpdir(), "pi-preview-outside-"));
  writeFileSync(join(outsideRoot, "secret.txt"), "secret");
  symlinkSync(join(outsideRoot, "secret.txt"), join(root, "outside.txt"));
  assert.throws(() => resolvePreviewFile(root, "outside.txt"), PathEscapeError);

  symlinkSync("src", join(root, "dir-link"));
  assert.throws(() => resolvePreviewFile(root, "dir-link"), PathEscapeError);
});

test("resolvePreviewFile: hides ignored files and enforces the 100 MiB boundary", () => {
  fixture();
  assert.throws(() => resolvePreviewFile(root, "secret.txt"), { code: "ENOENT" });

  const fd = openSync(join(root, "large.bin"), "w");
  try {
    ftruncateSync(fd, 100 * 1024 * 1024);
  } finally {
    closeSync(fd);
  }
  assert.equal(resolvePreviewFile(root, "large.bin").size, 100 * 1024 * 1024);

  const tooLargeFd = openSync(join(root, "too-large.bin"), "w");
  try {
    ftruncateSync(tooLargeFd, 100 * 1024 * 1024 + 1);
  } finally {
    closeSync(tooLargeFd);
  }
  assert.throws(() => resolvePreviewFile(root, "too-large.bin"), PreviewTooLargeError);
});

test("openResolvedPreviewFile: rejects a file replaced after metadata resolution", () => {
  fixture();
  writeFileSync(join(root, "race.txt"), "before");
  const meta = resolvePreviewFile(root, "race.txt");
  writeFileSync(join(root, "race.txt"), "after-change");
  assert.throws(() => openResolvedPreviewFile(meta), { code: "ESTALE" });
});
```

该测试抓住的破坏：路径逃逸、ignore 绕过、symlink 越 root、100 MiB 比较符写错、metadata 后文件替换仍被读取。

- [ ] **步骤 2：运行测试确认红灯**

运行：`node --import tsx --test tests/files.test.ts`

预期：FAIL，缺少 `resolvePreviewFile`、`openResolvedPreviewFile` 和 `PreviewTooLargeError` 导出。

- [ ] **步骤 3：实现最小解析与 fd 一致性校验**

在 `server/files.ts` 增加：

```ts
export const MAX_PREVIEW_BYTES = 100 * 1024 * 1024;

export class PreviewTooLargeError extends Error {}

export interface ResolvedPreviewFile {
  abs: string;
  realAbs: string;
  path: string;
  name: string;
  size: number;
  mimeType: string;
  mtimeMs: number;
  dev: number;
  ino: number;
  etag: string;
}

export interface OpenResolvedPreviewFileResult {
  fd: number;
  stream: import("node:fs").ReadStream;
}

export function resolvePreviewFile(root: string, rel: string): ResolvedPreviewFile;
export function openResolvedPreviewFile(meta: ResolvedPreviewFile): OpenResolvedPreviewFileResult;
```

实现要求：复用 `assertInsideRoot`、`loadRootIgnore`、`isExcluded`；POSIX 化 relative path；最终 symlink 使用 `realpathSync` 并再次校验 root/过滤；`lstat/stat` 只接受普通文件；ETag 至少包含 `dev/ino/size/mtimeMs`；fd 以只读打开后 `fstatSync` 比较同一组字段，失配关闭 fd 并抛出带 `code="ESTALE"` 的错误；stream 使用 `createReadStream(undefined, { fd, autoClose: true })`。

- [ ] **步骤 4：运行定向测试和 typecheck**

```bash
node --import tsx --test tests/files.test.ts
npm run typecheck
```

预期：全部 PASS，输出无 warning。

- [ ] **步骤 5：提交**

```bash
git add server/files.ts tests/files.test.ts
git commit -m "feat(文件预览): 建立安全文件解析边界"
```

---

### 任务 2：提供桌面内容 API 与安全静态响应

**文件：**
- 创建：`server/file-content.ts`
- 修改：`server/index.ts`
- 创建：`tests/file-content.test.ts`
- 修改：`tests/server-files-api.test.ts`

- [ ] **步骤 1：扩展真实服务器集成测试并观察失败**

在现有真实登录流程中加入：

```ts
const contentUrl = `${baseUrl}/api/files/content?cwd=${encodeURIComponent(root)}&path=${encodeURIComponent("README.md")}`;
const head = await fetch(contentUrl, {
  method: "HEAD",
  headers: { authorization: `Bearer ${sessionToken}` },
});
assert.equal(head.status, 200);
assert.equal(await head.text(), "");
assert.equal(head.headers.get("content-length"), "5");
assert.equal(head.headers.get("cache-control"), "private, no-store");
const etag = head.headers.get("etag");
assert.ok(etag);

const body = await fetch(contentUrl, {
  headers: { authorization: `Bearer ${sessionToken}`, "if-match": etag },
});
assert.equal(body.status, 200);
assert.equal(await body.text(), "hello");

writeFileSync(join(root, "README.md"), "changed");
const changed = await fetch(contentUrl, {
  headers: { authorization: `Bearer ${sessionToken}`, "if-match": etag },
});
assert.equal(changed.status, 409);
```

同时断言：GET 无 `If-Match` 为 409；POST 为 405；未知 cwd 403；ignore/missing 404；101 MiB sparse file 413；未知 `/api/nope` 为 JSON 404；缺失 `/file-viewer/nope.wasm` 为 404 而非 index HTML。另建 `tests/file-content.test.ts` 直接运行 `staticMimeType()`，断言 `.wasm/.mjs/.woff/.ttf/.data` 及未知后缀的字面 MIME。

运行：`node --import tsx --test tests/server-files-api.test.ts`

预期：FAIL，`/api/files/content` 当前落入未知 API/SPA 行为。

- [ ] **步骤 2：创建可测试的文件响应模块**

创建 `server/file-content.ts`，导出：

```ts
export interface PreviewRequestDeps {
  knownProjectRoots(): Promise<Set<string>>;
  expandHome(path: string): string;
}

export async function handleDesktopFileContent(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: PreviewRequestDeps,
): Promise<boolean>;

export function staticMimeType(pathname: string): string;
export function streamStaticFile(
  req: IncomingMessage,
  res: ServerResponse,
  filePath: string,
): void;
```

`handleDesktopFileContent` 只匹配固定 pathname；HEAD 返回相同 metadata headers 且无 body；GET 强制 `If-Match`；打开 fd 后再写 200 headers；请求 aborted/response close 时销毁 stream。统一 headers 必须包含规格中的六项。错误映射固定为 400/403/404/409/413/405。

- [ ] **步骤 3：在 `server/index.ts` 接线并收紧 fallback**

在 Bearer gate 后、tree/search 之前调用 desktop handler。API 路由结束后增加未匹配 `/api/*` JSON 404/405。静态分发改用 `resolve(DIST_DIR, "." + pathname)` 与 root 前缀校验；`/file-viewer/**` 缺失直接 404；HTML SPA fallback 仅用于非 API、非 viewer asset 的导航；静态文件使用 `streamStaticFile`。`file-viewer/**` 设置 `max-age=3600, must-revalidate` + ETag，HTML `no-cache`。

- [ ] **步骤 4：运行集成测试和 typecheck**

```bash
node --import tsx --test tests/file-content.test.ts tests/server-files-api.test.ts
npm run typecheck
```

预期：全部 PASS；测试结束后子服务器和临时 HOME 均清理。

- [ ] **步骤 5：提交**

```bash
git add server/file-content.ts server/index.ts tests/file-content.test.ts tests/server-files-api.test.ts
git commit -m "feat(文件预览): 提供受保护的文件内容接口"
```

---

### 任务 3：实现移动 preview capability 与路由顺序

**文件：**
- 创建：`server/preview-context.ts`
- 创建：`tests/preview-context.test.ts`
- 修改：`server/index.ts`
- 修改：`src/lib/auth.ts`
- 创建：`tests/auth.test.ts`
- 修改：`tests/server-files-api.test.ts`

- [ ] **步骤 1：为纯 context store 写确定性红灯测试**

测试使用注入时钟和固定 ID，不 sleep：

```ts
const clock = { now: 1_000 };
const store = new PreviewContextStore({
  now: () => clock.now,
  createId: () => "raw-capability-id",
});
const created = store.create({
  sessionToken: "session-a",
  root,
  path: "README.md",
  metadata: resolvePreviewFile(root, "README.md"),
  theme: "dark",
  locale: "en-US",
});
assert.equal(created.id, "raw-capability-id");
assert.equal(store.consume("raw-capability-id").theme, "dark");
clock.now += 10 * 60_000 + 1;
assert.throws(() => store.consume("raw-capability-id"), PreviewContextExpiredError);
```

另写测试覆盖：5 分钟首次 TTL、首次成功后 10 分钟、两个同步 consume 都成功、每 session 第 17 个淘汰最早、不同 session 不互相淘汰、`deleteBySessionToken` 清理。raw capability 不作为 Map key 是代码审查项，生产类不得为此暴露测试专用 introspection 方法。

运行：`node --import tsx --test tests/preview-context.test.ts`

预期：FAIL，模块不存在。

- [ ] **步骤 2：实现 `PreviewContextStore`**

```ts
export type PreviewTheme = "light" | "dark";
export type PreviewLocale = "en-US" | "zh-CN" | "ja-JP";

export interface PreviewContextRecord {
  root: string;
  path: string;
  name: string;
  size: number;
  mtimeMs: number;
  dev: number;
  ino: number;
  mimeType: string;
  theme: PreviewTheme;
  locale: PreviewLocale;
  sessionFingerprint: string;
  createdAt: number;
  firstUsedAt: number | null;
}

export class PreviewContextStore {
  create(input: CreatePreviewContextInput): { id: string; expiresAt: string };
  consume(rawId: string): PreviewContextRecord;
  deleteBySessionToken(sessionToken: string): number;
  cleanup(): number;
  get size(): number;
}
```

ID 默认 `randomBytes(16).toString("base64url")`；Map key 为 SHA-256(raw ID)，session 指纹也为 SHA-256；每 fingerprint 16 条 FIFO；interval 由 `server/index.ts` 持有并 `.unref()`，store 本身不启动后台 timer。

- [ ] **步骤 3：增加真实 HTTP capability 测试并观察失败**

```ts
const created = await fetch(`${baseUrl}/api/files/preview-context`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${sessionToken}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({ cwd: root, path: "README.md", theme: "dark", locale: "ko" }),
});
assert.equal(created.status, 200);
const { id } = await created.json() as { id: string };
const preview = await fetch(`${baseUrl}/api/files/preview-content`, {
  headers: { authorization: `Preview ${id}` },
});
assert.equal(preview.status, 200);
assert.equal(preview.headers.get("x-preview-theme"), "dark");
assert.equal(preview.headers.get("x-preview-locale"), "en-US");
assert.equal(await preview.text(), "hello");
```

再断言：content 无 authorization、Bearer、query `id` 均 401；POST path override 不影响 content；文件变化 409；logout 后 410；POST unknown cwd/escape/too-large 正确映射；content 在全局 Bearer gate 前可访问。新增 `tests/auth.test.ts`，用注入 fetch 或临时覆盖 `globalThis.fetch` 断言 `logout()` 在清本地 token 前把旧 token写入 `Authorization: Bearer <old>`；该测试应先因当前 `authHeaders()` 读到 null 而失败。

- [ ] **步骤 4：接入 context 路由和 logout hook**

`HEAD/GET /api/files/preview-content` 在 auth API 后、全局 `/api/*` Bearer gate 前精确处理。`POST /api/files/preview-context` 在 Bearer gate 后；创建时先 `resolvePreviewFile`。content 每次重新 resolve 并比较 `dev/ino/size/mtimeMs`；读取通过任务 2 的统一文件响应 helper。前端 `logout()` 先捕获旧 token，用显式 `Authorization: Bearer ${token}` 发请求，再清 local state；服务端 logout handler 先取 token、`deleteBySessionToken(token)`，再 `auth.logout(token)`。

- [ ] **步骤 5：运行测试和 typecheck**

```bash
node --import tsx --test tests/auth.test.ts tests/preview-context.test.ts tests/server-files-api.test.ts
npm run typecheck
```

- [ ] **步骤 6：提交**

```bash
git add server/preview-context.ts server/index.ts src/lib/auth.ts tests/auth.test.ts tests/preview-context.test.ts tests/server-files-api.test.ts
git commit -m "feat(文件预览): 增加移动端短时预览凭证"
```

---

### 任务 4：建立按聊天 tab 隔离的预览状态

**文件：**
- 创建：`src/lib/file-preview.ts`
- 创建：`tests/file-preview.test.ts`
- 修改：`src/lib/session-workspace.ts`
- 修改：`src/lib/chat.ts`
- 修改：`tests/session-workspace.test.ts`

- [ ] **步骤 1：编写 reducer/store 红灯测试**

```ts
test("openPreview deduplicates by cwd/path and evicts the least recently active ninth tab", () => {
  let state = createPreviewWorkspaceState();
  for (let i = 0; i < 8; i++) {
    state = reducePreviewWorkspace(state, {
      type: "open",
      tab: { cwd: "/p", path: `f${i}.txt`, name: `f${i}.txt`, lastActiveAt: i },
    });
  }
  state = reducePreviewWorkspace(state, {
    type: "open",
    tab: { cwd: "/p", path: "f8.txt", name: "f8.txt", lastActiveAt: 8 },
  });
  assert.deepEqual(
    state.tabs.map((tab) => tab.path),
    ["f1.txt", "f2.txt", "f3.txt", "f4.txt", "f5.txt", "f6.txt", "f7.txt", "f8.txt"],
  );
  assert.equal(state.active, previewIdentity("/p", "f8.txt"));
});
```

增加独立测试：重复选择只更新时间/激活；时间相同淘汰最左；关闭激活项选左邻；最后一项关闭回 Files；Files 不可关闭；不同 chat tab 隔离；regular close 清理；duplicate-bound losing→surviving 去重/LRU 合并。

运行：`node --import tsx --test tests/file-preview.test.ts`

预期：FAIL，模块不存在。

- [ ] **步骤 2：实现纯 reducer 与外部 store**

```ts
export interface PreviewTab {
  cwd: string;
  path: string;
  name: string;
  lastActiveAt: number;
}

export interface PreviewWorkspaceState {
  active: "files" | string;
  tabs: PreviewTab[];
}

export function previewIdentity(cwd: string, path: string): string;
export function createPreviewWorkspaceState(): PreviewWorkspaceState;
export function reducePreviewWorkspace(
  state: PreviewWorkspaceState,
  action: PreviewWorkspaceAction,
): PreviewWorkspaceState;
export function openPreview(
  tabKey: string,
  cwd: string,
  path: string,
  name: string,
  at?: number,
): void;
export function activatePreview(tabKey: string, identity: string): void;
export function closePreview(tabKey: string, identity: string): void;
export function showFilesTab(tabKey: string): void;
export function clearPreviewWorkspace(tabKey: string): void;
export function mergePreviewWorkspace(
  losingKey: string,
  survivingKey: string,
): void;
export function usePreviewWorkspace(tabKey: string): PreviewWorkspaceState;
```

store 仅内存 Map；server snapshot 使用稳定空对象；合并按 identity 去重，保留两边最近 `lastActiveAt`，然后按相同 LRU 规则截到 8 项。

- [ ] **步骤 3：先写 SessionWorkspace 生命周期红灯测试**

```ts
const events: string[] = [];
const workspace = new SessionWorkspace(factory, undefined, {
  onTabClosed: (key) => events.push(`closed:${key}`),
  onTabsMerged: (losing, surviving) => events.push(`merged:${losing}->${surviving}`),
});
```

断言 regular close 触发 closed；draft 绑定到已打开 session 时先 merged 再移除 client，且不对 losing key 再触发 closed，merge callback 负责迁移和清理。

- [ ] **步骤 4：实现 hooks 并接入 `chat.ts`**

```ts
export interface SessionWorkspaceLifecycle {
  onTabClosed?(key: string): void;
  onTabsMerged?(losingKey: string, survivingKey: string): void;
}
```

`ChatWorkspaceClient` 构造 `SessionWorkspace` 时传 `clearPreviewWorkspace` 和 `mergePreviewWorkspace`。不得改变现有 draft key stable 行为。

- [ ] **步骤 5：运行测试、全量 node:test 和 typecheck**

```bash
node --import tsx --test tests/file-preview.test.ts tests/session-workspace.test.ts
npm test
npm run typecheck
```

- [ ] **步骤 6：提交**

```bash
git add src/lib/file-preview.ts src/lib/session-workspace.ts src/lib/chat.ts tests/file-preview.test.ts tests/session-workspace.test.ts
git commit -m "feat(文件预览): 隔离多会话预览标签状态"
```

---

### 任务 5：集成 File Viewer 适配层与自托管资产

**文件：**
- 创建：`src/lib/file-viewer-options.ts`
- 创建：`src/components/FileViewerSurface.tsx`
- 创建：`tests/file-viewer-options.test.ts`
- 创建：`THIRD_PARTY_NOTICES.md`
- 创建：`third-party-licenses/Apache-2.0.txt`
- 修改：`package.json`、`package-lock.json`
- 修改：`vite.config.ts`
- 修改：`scripts/build.mjs`

- [ ] **步骤 1：安装锁定范围的依赖**

```bash
npm install @file-viewer/react-full@^2.2.8 @file-viewer/core@^2.2.8
npm install -D @file-viewer/vite-plugin@^2.2.8
```

预期：三者解析为同一 `2.2.x` 系列；不直接安装 `@file-viewer/preset-all`。

- [ ] **步骤 2：编写 options 红灯测试**

```ts
test("desktop options keep comfortable default and disable exfiltration operations", () => {
  const options = createFileViewerOptions({ mobile: false, theme: "dark", locale: "ko" });
  assert.equal(options.theme, "dark");
  assert.equal(options.locale, "en-US");
  assert.equal(options.ui, undefined);
  assert.deepEqual(options.toolbar, {
    position: "bottom-right",
    download: false,
    print: false,
    exportHtml: false,
    zoom: true,
    permissions: {
      download: false,
      print: false,
      "export-html": false,
    },
  });
  assert.deepEqual(options.archive, { entryActions: { download: false } });
  assert.equal("fit" in options, false);
});

test("mobile options use compact density and map supported locales", () => {
  assert.deepEqual(
    createFileViewerOptions({ mobile: true, theme: "light", locale: "zh" }).ui,
    { density: "compact" },
  );
  assert.equal(
    createFileViewerOptions({ mobile: true, theme: "light", locale: "ja" }).locale,
    "ja-JP",
  );
});
```

运行：`node --import tsx --test tests/file-viewer-options.test.ts`

预期：FAIL，模块不存在。

- [ ] **步骤 3：实现 options 与 lazy surface**

`createFileViewerOptions` 的 locale 输入使用本项目 `Locale`，返回类型使用 `ViewerOptions` type-only import。第三方动态导入必须只出现在 `FileViewerSurface.tsx`：

```tsx
const LazyFileViewer = lazy(async () => {
  const mod = await import("@file-viewer/react-full");
  mod.setDefaultFullAssetBaseUrl("/file-viewer/");
  return { default: mod.FileViewer };
});

export function FileViewerSurface({
  file,
  mobile,
  theme,
  locale,
  onReady,
  onError,
}: {
  file: File;
  mobile: boolean;
  theme: Theme;
  locale: Locale;
  onReady?: () => void;
  onError?: (error: unknown) => void;
}) {
  const options = useMemo(
    () => createFileViewerOptions({ mobile, theme, locale }),
    [mobile, theme, locale],
  );
  return (
    <Suspense fallback={<div className="h-full min-h-0 w-full" aria-busy="true" />}>
      <LazyFileViewer
        file={file}
        options={options}
        className="h-full min-h-0 w-full"
        onStateChange={(state) => {
          if (state.error) onError?.(state.error);
          else if (state.ready) onReady?.();
        }}
      />
    </Suspense>
  );
}
```

- [ ] **步骤 4：配置 assets、PWA 和构建契约**

`vite.config.ts` 注册 `fileViewerRenderers({ copyAssets: true, inject: false })`，只复制 assets，不向聊天或 iframe HTML 注入 virtual renderer module；显式设置 `build.manifest: true`；删除 `build.modulePreload: false`；Workbox `globIgnores` 精确设置为 `["file-viewer/**", "assets/file-viewer-*.js"]`。`scripts/build.mjs` 在 Vite 后检查：`dist/public/file-viewer`、manifest、至少 PDF worker、Office worker、CAD WASM、任一通用 WASM 存在；解析 Vite manifest，确认聊天入口的静态 imports 不含 `react-full`/`preset-all` chunk。任务 5 尚无组件实际消费 `FileViewerSurface`，因此本步骤只验证 static graph clean，不要求 lazy dynamic chunk 中必须发现 full/preset。

- [ ] **步骤 5：加入许可证文件和 package files**

`THIRD_PARTY_NOTICES.md` 记录 File Viewer root packages 及完整 runtime 中各组件的名称、版本、许可证、来源 URL 和对应本地 license/notice 文件（包括 Apache-2.0、AGPL-3.0-only、GPL-3.0-only、LGPL-2.1、OFL-1.1、`@file-viewer/ppt` 的 SEE LICENSE 等）；复制上游真实 license/notice 文本到 `third-party-licenses/`；`package.json.files` 包含 `THIRD_PARTY_NOTICES.md` 与 `third-party-licenses/`。`scripts/build.mjs` 增加 `assertThirdPartyNotices`：检查 root license set 存在且非空，并在 Vite 复制资产后检查 `dist/public/file-viewer/` 中关键 embedded notices（`vendor/ppt/LICENSE+NOTICE`、`wasm/model/LICENSE.occt-import-js.txt`、`vendor/pdf/cmaps/LICENSE`、`vendor/drawio/LICENSE`）存在且非空。

- [ ] **步骤 6：运行测试、typecheck 和生产 build**

```bash
node --import tsx --test tests/file-viewer-options.test.ts
npm run typecheck
npm run build
```

预期：viewer assets 被复制（40/40 代表四类 asset），service worker precache 不包含 `file-viewer/` 与 `assets/file-viewer-*.js`，HTML 不含 plugin 注入的 virtual renderer script，聊天主入口 static graph 不含 `react-full`/`preset-all`。

- [ ] **步骤 7：提交**

```bash
git add package.json package-lock.json vite.config.ts scripts/build.mjs src/lib/file-viewer-options.ts src/components/FileViewerSurface.tsx tests/file-viewer-options.test.ts THIRD_PARTY_NOTICES.md third-party-licenses/Apache-2.0.txt
git commit -m "feat(文件预览): 集成 File Viewer 自托管运行时"
```

---

### 任务 6：实现桌面文件加载与预览面板

**文件：**
- 创建：`src/lib/file-preview-api.ts`
- 创建：`src/components/FilePreviewPane.tsx`
- 创建：`tests/file-preview-api.test.ts`
- 修改：`src/i18n/en.ts`、`src/i18n/zh.ts`、`src/i18n/ja.ts`、`src/i18n/ko.ts`

- [ ] **步骤 1：为 HEAD→GET loader 写红灯测试**

loader 接受注入 fetch，fake fetch 根据 URL/method/If-Match 返回真实 `Response`，断言 loader 的可观察结果和请求序列：

```ts
const file = await loadDesktopPreviewFile({
  cwd: "/p",
  path: "docs/a.md",
  fetchImpl,
});
assert.equal(file.name, "a.md");
assert.equal(file.type, "text/markdown");
assert.equal(await file.text(), "hello");
assert.deepEqual(
  requests.map((request) => [request.method, request.ifMatch]),
  [["HEAD", null], ["GET", 'W/"v1"']],
);
```

增加独立测试：409 后只重试一次 HEAD→GET；413 在 HEAD 阶段停止不发 GET；AbortSignal 透传；401 调用既有 `setAuthStatus("unauthenticated")`。

运行：`node --import tsx --test tests/file-preview-api.test.ts`

预期：FAIL，模块不存在。

- [ ] **步骤 2：实现 loader 与错误类型**

```ts
export type PreviewErrorCode =
  | "unsupported"
  | "malformed"
  | "too-large"
  | "forbidden"
  | "missing"
  | "changed"
  | "expired"
  | "failed";

export class FilePreviewError extends Error {
  constructor(readonly code: PreviewErrorCode, message: string) {
    super(message);
  }
}

export async function loadDesktopPreviewFile(input: {
  cwd: string;
  path: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<File>;
```

filename 优先解析 `Content-Disposition filename*`，失败用 path basename；响应 body Blob 后构造 `new File([blob], name, { type })`。最多自动重试一次 409。

- [ ] **步骤 3：实现 `FilePreviewPane` 状态机**

组件只接受 `{ cwd, path, name, refreshToken }`。effect 创建 AbortController；loader 成功后调用 `precheckFileViewerSource(file)`：`previewable=false` 映射 unsupported，`valid=false` 映射 malformed；只在通过时挂 `FileViewerSurface`。切 tab/unmount abort。刷新通过上层增加 `refreshToken` 重新执行，不跨 tab 缓存 Blob。

- [ ] **步骤 4：增加四语言完整错误/操作文案**

在 `Messages` 和四 catalog 一次加入规格列出的全部 key。普通错误不显示 absolute cwd；路径只可用于 title/debug。

- [ ] **步骤 5：运行定向测试、全量测试和 typecheck**

```bash
node --import tsx --test tests/file-preview-api.test.ts tests/file-viewer-options.test.ts
npm test
npm run typecheck
```

- [ ] **步骤 6：提交**

```bash
git add src/lib/file-preview-api.ts src/components/FilePreviewPane.tsx tests/file-preview-api.test.ts src/i18n/en.ts src/i18n/zh.ts src/i18n/ja.ts src/i18n/ko.ts
git commit -m "feat(文件预览): 加载并渲染桌面文件内容"
```

---

### 任务 7：升级桌面文件区为可访问多标签工作区

**文件：**
- 创建：`src/components/FileWorkspaceTabs.tsx`
- 创建：`src/components/FileWorkspaceSidebar.tsx`
- 创建：`src/lib/file-workspace-tabs.ts`
- 创建：`tests/file-workspace-tabs.test.ts`
- 修改：`src/components/FileTreePanel.tsx`
- 修改：`src/components/ChatPage.tsx`
- 修改：`scripts/build.mjs`

- [ ] **步骤 1：为 tab 键盘纯逻辑写红灯测试**

```ts
export function nextWorkspaceTabId(
  ids: string[],
  current: string,
  key: "ArrowLeft" | "ArrowRight" | "Home" | "End",
): string;
export function shouldCloseWorkspaceTab(key: string): boolean;
```

测试 wrap 左右、Home/End、Delete/Backspace，且 Files ID 不可关闭。运行：`node --import tsx --test tests/file-workspace-tabs.test.ts`，预期 FAIL。

- [ ] **步骤 2：实现 tabs 和 sidebar**

`FileWorkspaceTabs` 使用 `role=tablist/tab`、roving tabindex、`aria-selected/controls`；Files 固定首项；close button 独立 aria-label，pointer down stopPropagation；tab strip 横向滚动且标签 truncate/title full path。`FileWorkspaceSidebar` 根据 active chat tab key 读取 store，active files 时复用 `FileTreePanel`，active file 时只挂一个 `FilePreviewPane`。刷新只增加当前 identity 的 refresh token。

- [ ] **步骤 3：拆分文件行 preview 与引用操作**

`FileTreePanel` props 改为：

```ts
export interface PreviewFileSelection {
  cwd: string;
  path: string;
  name: string;
}

onPreviewFile?(file: PreviewFileSelection): void;
selectedFileIdentity?: string;
```

文件行必须是两个兄弟 button：主按钮调用 `onPreviewFile`；行尾 `@` 按钮 `stopPropagation()` 后调用 `chatClient.insertComposerText(`@${node.path} `)`。桌面选中行 `aria-current="true"` 且图标/背景共同标识；移动命中区域至少 44px。

- [ ] **步骤 4：替换 ChatPage desktop 宿主**

移除 `FilesSidebar`，挂 `FileWorkspaceSidebar` 作为根 flex 直接子级；desktop 打开文件时确保 files panel open。宽度：Files `w-64`；文件预览 md `w-[22rem]`，lg `w-[min(46vw,48rem)]`；聊天列 `min-w-0`，Composer 不被覆盖。隐藏 panel 不清空 store。

- [ ] **步骤 5：运行测试、typecheck 和 build**

```bash
node --import tsx --test tests/file-workspace-tabs.test.ts tests/file-preview.test.ts
npm run typecheck
npm run build
```

扩展 `scripts/build.mjs` 验证：解析 Vite manifest，确认 `FilePreviewPane`/`FileViewerSurface` 的 lazy dynamic chunk 中必须存在 `react-full`/`preset-all`，且聊天主入口 static graph 仍不含 `react-full`/`preset-all`；解析生成的 `sw.js`（或 Workbox precache manifest）确认 `file-viewer/` 运行时资产树与 viewer dynamic chunk 均未被 precache。

- [ ] **步骤 6：提交**

```bash
git add src/components/FileWorkspaceTabs.tsx src/components/FileWorkspaceSidebar.tsx src/lib/file-workspace-tabs.ts tests/file-workspace-tabs.test.ts src/components/FileTreePanel.tsx src/components/ChatPage.tsx scripts/build.mjs
git commit -m "feat(文件预览): 构建桌面多文件标签工作区"
```

---

### 任务 8：实现移动同源 iframe 全屏预览

**文件：**
- 创建：`src/lib/file-preview-frame.ts`
- 创建：`tests/file-preview-frame.test.ts`
- 创建：`src/components/MobileFilePreview.tsx`
- 创建：`src/file-preview-main.tsx`
- 创建：`file-preview.html`
- 修改：`src/components/FileTreePanel.tsx`
- 修改：`src/components/ChatPage.tsx`
- 修改：`vite.config.ts`
- 修改：`scripts/build.mjs`

- [ ] **步骤 1：为 capability URL 与消息 guard 写红灯测试**

```ts
const src = createPreviewFrameSrc("opaque-id");
assert.equal(src, "/file-preview.html#context=opaque-id");
assert.equal(src.includes("cwd="), false);
assert.equal(src.includes("path="), false);

assert.equal(isPreviewFrameMessage(event, expectedWindow, location.origin), true);
assert.equal(isPreviewFrameMessage(wrongOrigin, expectedWindow, location.origin), false);
assert.equal(isPreviewFrameMessage(wrongSource, expectedWindow, location.origin), false);
```

另测 `consumePreviewContextFromHash` 返回 ID 并调用注入的 replaceState 清除 fragment；`loadFramePreviewFile` 的请求序列必须是固定 `/api/files/preview-content` + `Authorization: Preview <id>`，且不能出现 cwd/path/session token。

运行：`node --import tsx --test tests/file-preview-frame.test.ts`

预期：FAIL，模块不存在。

- [ ] **步骤 2：实现 frame helper 与独立 entry**

`src/file-preview-main.tsx` 只导入 React、样式、frame helper、options、`FileViewerSurface`；不得 import `main.tsx`、AuthGate、ChatPage、ChatClient、router、`authHeaders`。启动时消费 fragment，立即清 URL；HEAD/GET 固定 `/api/files/preview-content`，从 headers 得到 filename/theme/locale，构造 File、precheck、mount compact viewer；ready/error 只发规格列出的两种 postMessage。

- [ ] **步骤 3：实现父页 `MobileFilePreview`**

父页 Bearer POST context；成功后 iframe src 仅含 opaque ID。全屏 shell 使用 `fixed inset-0 h-[100dvh]` 和 safe-area；工具栏为返回文件树、截断文件名、关闭，按钮命中 ≥44px；iframe `sandbox="allow-scripts allow-same-origin"`，无 allow-downloads，有描述 title。验证 postMessage 的 origin/source/type。

history：open 时 `pushState({ filePreview: true }, "")`；popstate 关闭；按钮关闭在当前层存在时 `history.back()`，否则本地关闭，避免双退。关闭后 focus 回触发文件行；返回文件树关闭后触发 `requestOpenFilesDrawer()`。

- [ ] **步骤 4：接移动文件树与 ChatPage**

`FilesDrawer` 接收 `onPreviewFile` 并在主按钮选择后关闭 drawer；`@` 仍只引用并关闭 drawer。`ChatPage` 在移动 viewport 管理 `MobilePreviewSelection | null`。右缘 drawer 手势保持始终可用。

- [ ] **步骤 5：配置 Vite 第二入口并验证依赖图**

`build.rollupOptions.input` 同时包含 `index.html` 和 `file-preview.html`。扩展 build 验证：`dist/public/file-preview.html` 存在；frame entry 的静态 graph 不含 ChatClient/AuthGate/router；聊天 entry 仍不静态依赖 full preset。

- [ ] **步骤 6：运行测试、typecheck 和 build**

```bash
node --import tsx --test tests/file-preview-frame.test.ts
npm run typecheck
npm run build
```

- [ ] **步骤 7：提交**

```bash
git add src/lib/file-preview-frame.ts tests/file-preview-frame.test.ts src/components/MobileFilePreview.tsx src/file-preview-main.tsx file-preview.html src/components/FileTreePanel.tsx src/components/ChatPage.tsx vite.config.ts scripts/build.mjs
git commit -m "feat(文件预览): 增加移动端 iframe 预览页"
```

---

### 任务 9：增加真实浏览器回归与主动内容安全验证

**文件：**
- 创建：`playwright.config.ts`
- 创建：`tests/e2e/file-preview.spec.ts`
- 创建：`tests/e2e/fixtures/create-preview-project.mjs`
- 修改：`package.json`、`package-lock.json`
- 修改（仅当安全测试失败）：`server/files.ts`、`tests/files.test.ts`

- [ ] **步骤 1：安装 Playwright 并配置隔离生产服务器**

```bash
npm install -D @playwright/test
npx playwright install chromium
```

`playwright.config.ts` 使用 global setup 创建临时 HOME/project/port，运行 `npm run build` 后启动 `node dist/index.js`：`PI_WEB_TOKEN=e2e-token`、`PI_WEB_2FA=off`、`PI_WEB_CWD=<temp project>`、独立 `PORT`、`HOST=127.0.0.1`。测试必须通过真实 LoginPage 登录，不预写 session token，不读取用户 `~/.pi/web-chat`。

- [ ] **步骤 2：先写最小失败 E2E：文件行语义与桌面预览**

测试创建 Markdown/PNG/PDF/小 DOCX fixture。断言：单击文件主按钮打开预览 tab 且 Composer 不变；点击独立 `@` 只插入引用且不打开 tab；重复文件去重；第 9 个按 LRU 淘汰；只存在一个 viewer host；Files tab/关闭/Arrow/Home/End/Delete 工作；切聊天 tab 独立恢复。首次运行必须因真实功能缺口红灯；selector 只允许基于 role/label，不增加仅测试 data-testid。

- [ ] **步骤 3：补移动、布局、主题和语言 E2E**

在 375x667、430x932、768x1024、1440x900 覆盖 drawer→iframe、same-origin URL fragment 不含 cwd/path/token、ready 后 fragment 已清、返回文件树、关闭回聊天、浏览器后退。验证 light/dark 和 en/zh/ja/ko 外围文案；ko iframe viewer locale header 为 en-US。用 bounding boxes 断言 toolbar/iframe/safe-area 无重叠，触控按钮至少 44px。

- [ ] **步骤 4：补错误与主动内容安全 E2E**

运行时创建 101 MiB sparse file，断言 413 且无 GET body；删除/修改文件断言 missing/changed；unsupported/malformed 状态；网络记录中 viewer assets 无 404。恶意 fixture：HTML/XML 必须显示为文本且脚本不执行；SVG 包含 inline script、外部 image URL 和 parent/localStorage 探测，测试拦截外部请求并断言 0 次、父页 marker 未变。

若 SVG 安全测试失败：先新增失败的 `tests/files.test.ts` 断言 `.svg` 被 `resolvePreviewFile` 拒绝，再实现固定 SVG denylist 并把 UI 映射为 unsupported；不得放宽 iframe sandbox。

- [ ] **步骤 5：截图和 canvas pixel 非空验证**

对 Markdown/PDF/Office/图片保存 desktop/mobile 截图；使用 Playwright screenshot buffer 检查 viewer 内容区域非单色/非全透明，且 console/pageerror/failed request 无 renderer 资产错误。截图产物写 test output，不提交大二进制 golden。

- [ ] **步骤 6：运行 E2E、typecheck、全量测试和 build**

```bash
npm run typecheck
npm test
npm run build
npm run test:e2e
```

- [ ] **步骤 7：提交**

```bash
git add package.json package-lock.json playwright.config.ts tests/e2e/file-preview.spec.ts tests/e2e/fixtures/create-preview-project.mjs
git add server/files.ts tests/files.test.ts # 仅当 SVG 安全测试要求 denylist 时
git commit -m "test(文件预览): 覆盖桌面移动与主动内容安全"
```

- [ ] **步骤 8：确认提交范围**

运行：`git show --stat --oneline HEAD`

预期：没有 SVG denylist 时提交不包含 `server/files.ts`/`tests/files.test.ts`；测试临时 HOME、项目和截图未被加入 git。

---

### 任务 10：体积门禁、版本发布与最终验证

**文件：**
- 创建：`scripts/check-pack-size.mjs`
- 创建：`tests/check-pack-size.test.ts`
- 修改：`package.json`
- 修改：`package-lock.json`
- 修改：`release-notes.json`

- [ ] **步骤 1：先写 pack size 边界红灯测试**

```ts
import {
  assertPackSizeWithinLimits,
  MAX_PACKED_BYTES,
  MAX_UNPACKED_BYTES,
} from "../scripts/check-pack-size.mjs";

test("pack size accepts exact limits", () => {
  assert.doesNotThrow(() =>
    assertPackSizeWithinLimits({
      size: MAX_PACKED_BYTES,
      unpackedSize: MAX_UNPACKED_BYTES,
    }),
  );
});

test("pack size rejects either limit plus one byte", () => {
  assert.throws(() =>
    assertPackSizeWithinLimits({
      size: MAX_PACKED_BYTES + 1,
      unpackedSize: MAX_UNPACKED_BYTES,
    }),
  );
  assert.throws(() =>
    assertPackSizeWithinLimits({
      size: MAX_PACKED_BYTES,
      unpackedSize: MAX_UNPACKED_BYTES + 1,
    }),
  );
});
```

运行：`node --import tsx --test tests/check-pack-size.test.ts`

预期：FAIL，模块不存在。

- [ ] **步骤 2：实现体积检查并更新脚本**

`scripts/check-pack-size.mjs` 导出 `MAX_PACKED_BYTES = 150 * 1024 * 1024`、`MAX_UNPACKED_BYTES = 500 * 1024 * 1024` 和纯断言函数。CLI 入口执行 `npm pack --dry-run --json --ignore-scripts`，读取首项 `size`/`unpackedSize`，打印 MiB 和文件数，超过门限 exit 1。

`package.json`：

```json
"test:e2e": "playwright test",
"pack:check": "npm run build && node scripts/check-pack-size.mjs"
```

`--ignore-scripts` 避免 `prepack` 在 `pack:check` 内再次 build。

- [ ] **步骤 3：执行 patch 版本发布**

读取当前实际版本并 patch +1；若仍是 `0.1.68`，更新为 `0.1.69`。同步 package lock 根版本。`release-notes.json` 新键至少包含：桌面多文件 tabs、移动 iframe、File Viewer 多格式支持、100 MiB 限制与只读安全边界。

- [ ] **步骤 4：运行最终完整验证**

```bash
npm run typecheck
npm test
npm run build
npm run test:e2e
npm run pack:check
git diff --check
node -e 'const p=require("./package.json"),l=require("./package-lock.json"),r=require("./release-notes.json"); if(p.version!==l.version||p.version!==l.packages[""].version||!r[p.version]) process.exit(1); console.log(p.version)'
```

预期：全部 exit 0；Playwright 无失败请求/console error；pack 压缩 ≤150 MiB、unpacked ≤500 MiB；版本三处一致。

- [ ] **步骤 5：提交发布**

```bash
git add scripts/check-pack-size.mjs tests/check-pack-size.test.ts package.json package-lock.json release-notes.json
git commit -m "chore(发布): 0.1.69 文件预览"
```

提交信息中的版本必须使用步骤 3 得到的实际版本。

---

## 最终审查重点

- capability content 路由确实位于全局 Bearer gate 前，且只接受固定 URL + `Authorization: Preview`。
- desktop HEAD/GET 与 context GET 均从 `resolvePreviewFile` 和 fd/fstat 路径读取，不存在直接 `readFileSync` 文件内容分支。
- context Map 不保存 raw capability；5 分钟首次/10 分钟使用后 TTL、每 session 16 条 FIFO、logout 清理均有行为测试。
- Chat initial entry 和 iframe entry 都不静态包含 `react-full/preset-all`；viewer 只在预览时 lazy 加载，`file-viewer/**` 不进入 Workbox precache。
- 文件树主按钮只预览，独立 `@` 只引用；桌面 tabs、移动 history/focus、375/768/1440 布局和 safe-area 通过真实浏览器验证。
- `.html/.htm/.xml` 以文本显示；恶意 SVG 测试通过，否则服务端 deny `.svg`。
- npm package 包含运行资产、`THIRD_PARTY_NOTICES.md`、完整 root license set（`third-party-licenses/`）且保留 `dist/public/file-viewer/` 内 embedded notices；`scripts/build.mjs` 的 `assertThirdPartyNotices` 门控通过；pack size 硬门限通过。
