# 会话项目目录树 + Composer @ 文件引用 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在 Web UI 头部（"+"左侧）提供项目文件树入口（桌面右侧 docked 面板 / 移动右侧抽屉），并在 Composer 支持 `@` 模糊搜索引用项目文件（插入 `@相对路径`）。

**架构：** 服务端新增 `server/files.ts`（目录列举 + 文件搜索，共享 gitignore 过滤）与两个 REST 端点（`/api/tree`、`/api/files/search`，cwd 限定已知项目集合）；前端新增右侧文件面板（`FileTreePanel` 内容组件 + `FilesSidebar`/`FilesDrawer` 双宿主）与 Composer mention 弹层（镜像现有 CommandPalette 交互）；文本注入复用并扩展现有 `injectText` 通道（新增 insert 模式）。

**技术栈：** Node（node:test 单测）、React 19 + TanStack Query + Tailwind 4、base-ui Dialog、`ignore` 包（新依赖）、TypeScript strict + `verbatimModuleSyntax`（类型导入必须 `import type`）。

**规格：** `docs/superpowers/specs/2026-08-13-session-project-tree-design.md`（决策与边界以规格为准）。

---

## 前置条件（执行前必读）

- **工作区在途改动（WIP）**：执行开始时若 `git status` 仍有未提交改动（0.1.64–0.1.66 断线修复系列，涉及 `src/lib/chat.ts`、`src/components/Composer.tsx`、`server/index.ts`、`shared/protocol.ts` 等——与本计划修改同一批文件），**必须先由用户确认：提交 WIP 或 stash**，再开始任务 1。本计划所有"修改现有文件"的锚点代码块基于已提交状态书写；行号可能漂移，以代码块内容定位。
- 全程遵守仓库规则（AGENTS.md）：任务 9 统一做 patch 版本 +1 与 `release-notes.json`。
- commit 信息沿用仓库中文 Conventional Commits 风格（如 `feat(文件树): …`）。
- 每任务结束后运行 `npm run typecheck`（涉及 TS 改动时）。

## 文件结构

| 文件 | 职责 | 任务 |
|------|------|------|
| `server/files.ts` | 创建：目录列举 `listDir`、遍历索引 `walkProject`/`buildFileIndex`、匹配排序 `rankMatches`、`searchFiles`；gitignore/硬排除过滤、路径逃逸防护 | 1, 2 |
| `tests/files.test.ts` | 创建：上述服务端逻辑的 node:test 单测 | 1, 2 |
| `shared/protocol.ts` | 修改：`UITreeNode`/`UITreeResponse`/`UIFileMatch`/`UIFileSearchResponse` | 3 |
| `server/index.ts` | 修改：两个 GET 端点 + `knownProjectRoots()` 校验 + `shortenHome()` | 3 |
| `src/lib/chat.ts` | 修改：`injectText` 改为 `{ text, mode }`、新增 `insertComposerText`（client + workspace 透传） | 4 |
| `src/components/Composer.tsx` | 修改：inject 消费支持 insert 模式（任务 4）；mention 状态机与键盘（任务 8） | 4, 8 |
| `src/lib/api.ts` | 修改：`useTree`/`useInvalidateTree`（任务 5）、`useFileSearch`（任务 8） | 5, 8 |
| `src/lib/filetree.ts` | 创建：面板开关 + 按 cwd 的目录展开态（localStorage，仿 `sidebar.ts`） | 5 |
| `src/lib/drawer.ts` | 修改：新增 files 抽屉打开事件总线 | 5 |
| `src/lib/useEdgeSwipe.ts` | 修改：泛化出 `useRightEdgeSwipe` | 5 |
| `src/components/FileTreePanel.tsx` | 创建：树内容组件 + `FilesSidebar` + `FilesDrawer` | 6 |
| `src/components/ChatPage.tsx` | 修改：头部树按钮（"+"左侧）、宿主挂载、右缘手势 | 6 |
| `src/lib/mention.ts` | 创建：`extractMentionQuery`/`replaceMentionToken` 纯函数 | 7 |
| `tests/mention.test.ts` | 创建：mention 纯函数单测 | 7 |
| `src/components/FileMentionPalette.tsx` | 创建：mention 弹层组件 | 8 |
| `src/i18n/{en,zh,ko,ja}.ts` | 修改：树与 mention 新键（`Messages` 类型在 en.ts，四语言必须同步，否则 typecheck 失败） | 6, 8 |
| `package.json` / `package-lock.json` / `release-notes.json` | 修改：新依赖 `ignore`（任务 1）；版本 +1 与发布说明（任务 9） | 1, 9 |

---

### 任务 1：`server/files.ts` —— 目录列举（listDir）

**文件：**
- 创建：`server/files.ts`
- 测试：`tests/files.test.ts`
- 修改：`package.json`、`package-lock.json`（新增 `ignore` 依赖）

- [ ] **步骤 1：安装 `ignore` 依赖**

```bash
npm install ignore@^7
```

预期：`package.json` dependencies 出现 `"ignore": "^7.x.y"`；构建管线 `packages: "external"` 无需额外配置。

- [ ] **步骤 2：编写失败的测试（过滤、排序、逃逸、符号链接、截断、EACCES）**

创建 `tests/files.test.ts`：

```ts
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { listDir, PathEscapeError } from "../server/files.ts";

const root = "/tmp/pi-files-test";

function fixture() {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, ".git"), { recursive: true });
  mkdirSync(join(root, "node_modules", "dep"), { recursive: true });
  mkdirSync(join(root, "dist"), { recursive: true });
  mkdirSync(join(root, "src", "deep"), { recursive: true });
  mkdirSync(join(root, "empty"), { recursive: true });
  writeFileSync(join(root, "node_modules", "dep", "x.js"), "");
  writeFileSync(join(root, "dist", "bundle.js"), "");
  writeFileSync(join(root, "src", "b.ts"), "");
  writeFileSync(join(root, "src", "a.ts"), "");
  writeFileSync(join(root, "src", "deep", "c.ts"), "");
  writeFileSync(join(root, "README.md"), "");
  writeFileSync(join(root, ".env"), "");
  writeFileSync(join(root, "secret.txt"), "");
  writeFileSync(join(root, ".gitignore"), "dist/\nsecret.txt\n");
  symlinkSync(join(root, "src"), join(root, "linkdir"));
}

test("listDir: dirs first, case-insensitive sort, hard excludes + root .gitignore applied", () => {
  fixture();
  const { nodes, truncated } = listDir(root, "");
  assert.equal(truncated, false);
  const names = nodes.map((n) => n.name);
  // hard excludes + gitignore hits are absent
  for (const excluded of [".git", "node_modules", "dist", "secret.txt"]) {
    assert.ok(!names.includes(excluded), `${excluded} must be excluded`);
  }
  // dirs first
  assert.equal(nodes[0]!.type, "dir");
  const dirNames = nodes.filter((n) => n.type === "dir").map((n) => n.name);
  const fileNames = nodes.filter((n) => n.type === "file").map((n) => n.name);
  assert.deepEqual(dirNames, ["empty", "src"]);
  // dotfiles shown; symlinked dir appears as a file; case-insensitive alpha
  assert.deepEqual(fileNames, [".env", ".gitignore", "linkdir", "README.md"]);
});

test("listDir: hasChildren reflects filtered content", () => {
  fixture();
  const { nodes } = listDir(root, "");
  const src = nodes.find((n) => n.name === "src");
  const empty = nodes.find((n) => n.name === "empty");
  assert.equal(src?.hasChildren, true);
  assert.equal(empty?.hasChildren, false);
});

test("listDir: nested listing uses relative paths", () => {
  fixture();
  const { nodes } = listDir(root, "src");
  assert.deepEqual(
    nodes.map((n) => `${n.type}:${n.path}`),
    ["dir:src/deep", "file:src/a.ts", "file:src/b.ts"],
  );
});

test("listDir: path escape and absolute rel are rejected", () => {
  fixture();
  assert.throws(() => listDir(root, "../outside"), PathEscapeError);
  assert.throws(() => listDir(root, "/etc"), PathEscapeError);
});

test("listDir: truncates at 1000 entries", () => {
  fixture();
  const big = join(root, "big");
  mkdirSync(big);
  for (let i = 0; i < 1005; i++) writeFileSync(join(big, `f${String(i).padStart(4, "0")}.txt`), "");
  const { nodes, truncated } = listDir(root, "big");
  assert.equal(nodes.length, 1000);
  assert.equal(truncated, true);
});

test("listDir: unreadable dir is marked inaccessible (skipped for root user)", () => {
  fixture();
  if (typeof process.getuid === "function" && process.getuid() === 0) return;
  const locked = join(root, "locked");
  mkdirSync(locked);
  writeFileSync(join(locked, "x.txt"), "");
  chmodSync(locked, 0o000);
  try {
    const { nodes } = listDir(root, "");
    const node = nodes.find((n) => n.name === "locked");
    assert.equal(node?.inaccessible, true);
    assert.equal(node?.hasChildren, false);
  } finally {
    chmodSync(locked, 0o755);
  }
});
```

- [ ] **步骤 3：运行测试验证失败**

运行：`node --import tsx --test tests/files.test.ts`
预期：FAIL，报错 `Cannot find module '../server/files.ts'`（或导出不存在的 TypeError）。

- [ ] **步骤 4：实现 `server/files.ts`（listDir 部分）**

```ts
/** Project directory listing & file search with shared ignore filtering. */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import ignore, { type Ignore } from "ignore";
import type { UITreeNode } from "../shared/protocol.ts";

/** Always excluded, at any depth (huge or internal) */
const HARD_EXCLUDES = new Set([".git", "node_modules"]);
/** Max entries returned for one directory */
const MAX_DIR_ENTRIES = 1000;
/** Root .gitignore re-read interval */
const IGNORE_TTL_MS = 10_000;

export class PathEscapeError extends Error {}

/** Resolve rel against root, rejecting escapes and absolute paths. Returns abs. */
export function assertInsideRoot(root: string, rel: string): string {
  if (rel.startsWith("/") || /^[A-Za-z]:[\\/]/.test(rel)) throw new PathEscapeError(rel);
  const abs = resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + sep)) throw new PathEscapeError(rel);
  return abs;
}

const ignoreCache = new Map<string, { at: number; ig: Ignore | null }>();

/** Root-level .gitignore compiled rules (null when absent/unreadable). Nested .gitignore files are out of scope. */
function loadRootIgnore(root: string): Ignore | null {
  const hit = ignoreCache.get(root);
  if (hit && Date.now() - hit.at < IGNORE_TTL_MS) return hit.ig;
  let ig: Ignore | null = null;
  try {
    const file = join(root, ".gitignore");
    if (existsSync(file)) ig = ignore().add(readFileSync(file, "utf8"));
  } catch {
    ig = null;
  }
  ignoreCache.set(root, { at: Date.now(), ig });
  return ig;
}

function isExcluded(rel: string, isDir: boolean, ig: Ignore | null): boolean {
  if (rel.split("/").some((segment) => HARD_EXCLUDES.has(segment))) return true;
  if (!ig) return false;
  // `foo/` patterns only match directories — test both forms for dirs
  return ig.ignores(rel) || (isDir && ig.ignores(rel + "/"));
}

/** Peek a dir's children (filtered) to decide chevron rendering; EACCES → inaccessible. */
function probeDir(abs: string, rel: string, ig: Ignore | null): { hasChildren: boolean; inaccessible: boolean } {
  let dirents;
  try {
    dirents = readdirSync(abs, { withFileTypes: true });
  } catch {
    return { hasChildren: false, inaccessible: true };
  }
  for (const ent of dirents) {
    const childRel = `${rel}/${ent.name}`;
    if (!isExcluded(childRel, ent.isDirectory(), ig)) return { hasChildren: true, inaccessible: false };
  }
  return { hasChildren: false, inaccessible: false };
}

function byTypeThenName(a: UITreeNode, b: UITreeNode): number {
  if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
  return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
}

/** Single-level listing. rel "" = root. Symlinked dirs show as files (no traversal). */
export function listDir(root: string, rel: string): { nodes: UITreeNode[]; truncated: boolean } {
  const abs = assertInsideRoot(root, rel);
  const ig = loadRootIgnore(root);
  const kept: UITreeNode[] = [];
  for (const ent of readdirSync(abs, { withFileTypes: true })) {
    // Dirent is lstat semantics: symlinked dirs report isDirectory() === false
    const isDir = ent.isDirectory();
    const childRel = rel ? `${rel}/${ent.name}` : ent.name;
    if (isExcluded(childRel, isDir, ig)) continue;
    const node: UITreeNode = { name: ent.name, path: childRel, type: isDir ? "dir" : "file" };
    if (isDir) {
      const probe = probeDir(join(abs, ent.name), childRel, ig);
      node.hasChildren = probe.hasChildren;
      if (probe.inaccessible) node.inaccessible = true;
    }
    kept.push(node);
  }
  kept.sort(byTypeThenName);
  return { nodes: kept.slice(0, MAX_DIR_ENTRIES), truncated: kept.length > MAX_DIR_ENTRIES };
}
```

注意：任务 3 才会把 `UITreeNode` 加进 `shared/protocol.ts`。本任务的 import 暂会报类型缺失——**把任务 3 步骤 1 的 protocol 类型提前到本任务步骤 4 之前加入**（类型先行，端点后做；不算跨任务污染，protocol.ts 只增不改）。

- [ ] **步骤 5：运行测试验证通过**

运行：`node --import tsx --test tests/files.test.ts && npm run typecheck`
预期：6 个测试全 PASS；typecheck 无错。

- [ ] **步骤 6：Commit**

```bash
git add package.json package-lock.json server/files.ts tests/files.test.ts shared/protocol.ts
git commit -m "feat(文件树): 服务端目录列举（过滤/排序/截断/逃逸防护）"
```

---

### 任务 2：`server/files.ts` —— 文件搜索（searchFiles）

**文件：**
- 修改：`server/files.ts`
- 测试：`tests/files.test.ts`（追加）

- [ ] **步骤 1：编写失败的测试（排序层级、limit、空 query、partial、索引过滤一致性）**

在 `tests/files.test.ts` 追加（复用任务 1 的 fixture，先补两个条目：在 `fixture()` 里加 `mkdirSync(join(root, "utils"))`、`writeFileSync(join(root, "utils", "helper.ts"), "")`、`writeFileSync(join(root, "src", "utils.ts"), "")`）：

```ts
import { searchFiles, walkProject } from "../server/files.ts";

test("walkProject: respects the same filters as listDir", () => {
  fixture();
  const { entries, partial } = walkProject(root, 100_000);
  assert.equal(partial, false);
  const paths = entries.map((e) => e.path);
  for (const excluded of ["node_modules/dep/x.js", "dist/bundle.js", "secret.txt", ".git"]) {
    assert.ok(!paths.some((p) => p === excluded || p.startsWith(excluded + "/")), excluded);
  }
  // symlinked dir is not traversed nor indexed
  assert.ok(!paths.includes("linkdir"));
  assert.ok(paths.includes("src/deep/c.ts"));
});

test("walkProject: cap marks partial", () => {
  fixture();
  const { entries, partial } = walkProject(root, 5);
  assert.equal(partial, true);
  assert.equal(entries.length, 5);
});

test("searchFiles: ranking tiers — basename prefix > basename substring > path substring", () => {
  fixture();
  const { matches } = searchFiles(root, "utils", 50);
  // tier 0: dir "utils" (path shorter) then file "utils.ts"; tier 2: "src/utils.ts"? no — name hit already tier 0
  assert.deepEqual(matches.map((m) => m.path), ["utils", "src/utils.ts"]);
});

test("searchFiles: path-substring tier ranks after name tiers", () => {
  fixture();
  const { matches } = searchFiles(root, "deep", 50);
  assert.equal(matches[0]!.path, "src/deep"); // dir name hit (tier 0)
  assert.deepEqual(matches.map((m) => m.path).slice(1), ["src/deep/c.ts"]); // path hit (tier 2)
});

test("searchFiles: empty query degrades to root-level, dirs first, cap 20", () => {
  fixture();
  const { matches } = searchFiles(root, "", 50);
  assert.ok(matches.length > 0 && matches.length <= 20);
  assert.ok(matches.every((m) => !m.path.includes("/")));
  assert.equal(matches[0]!.type, "dir");
});

test("searchFiles: limit clamps results", () => {
  fixture();
  const { matches } = searchFiles(root, "ts", 2);
  assert.equal(matches.length, 2);
});
```

注意：`fixture()` 更新后，任务 1 的排序断言受影响（root 多出 `utils` 目录与 `src/utils.ts` 文件）——同步更新任务 1 的 `deepEqual` 期望：`dirNames` 变为 `["empty", "src", "utils"]`，`"src"` 子层期望变为 `["dir:src/deep", "file:src/a.ts", "file:src/b.ts", "file:src/utils.ts"]`。

- [ ] **步骤 2：运行测试验证失败**

运行：`node --import tsx --test tests/files.test.ts`
预期：FAIL，`searchFiles is not exported` / `walkProject is not exported`。

- [ ] **步骤 3：实现搜索（追加到 `server/files.ts`）**

```ts
import { statSync } from "node:fs";
import type { UIFileMatch } from "../shared/protocol.ts";

export interface FileIndexEntry {
  name: string;
  path: string;
  type: "dir" | "file";
}

/** Safety cap for the full-project walk */
const WALK_CAP = 100_000;
const SEARCH_CACHE_TTL_MS = 5_000;
const EMPTY_QUERY_CAP = 20;
const MAX_LIMIT = 200;

/** Uncached full-project walk (exported for tests with a custom cap). */
export function walkProject(root: string, cap: number): { entries: FileIndexEntry[]; partial: boolean } {
  const ig = loadRootIgnore(root);
  const entries: FileIndexEntry[] = [];
  let partial = false;
  const walk = (abs: string, rel: string) => {
    if (partial) return;
    let dirents;
    try {
      dirents = readdirSync(abs, { withFileTypes: true });
    } catch {
      return; // unreadable dir — skip, don't fail the whole search
    }
    for (const ent of dirents) {
      if (entries.length >= cap) {
        partial = true;
        return;
      }
      const isDir = ent.isDirectory();
      if (ent.isSymbolicLink()) {
        // Symlinked dirs: never traverse, never index (cycle guard). Stat to tell them apart.
        try {
          if (statSync(join(abs, ent.name)).isDirectory()) continue;
        } catch {
          continue; // broken symlink
        }
      }
      const childRel = rel ? `${rel}/${ent.name}` : ent.name;
      if (isExcluded(childRel, isDir, ig)) continue;
      entries.push({ name: ent.name, path: childRel, type: isDir ? "dir" : "file" });
      if (isDir) walk(join(abs, ent.name), childRel);
    }
  };
  walk(root, "");
  return { entries, partial };
}

const indexCache = new Map<string, { at: number; entries: FileIndexEntry[]; partial: boolean }>();

/** Cached project index (5s TTL — keystrokes hit cache, new files appear after expiry). */
export function buildFileIndex(root: string): { entries: FileIndexEntry[]; partial: boolean } {
  const hit = indexCache.get(root);
  if (hit && Date.now() - hit.at < SEARCH_CACHE_TTL_MS) return hit;
  const { entries, partial } = walkProject(root, WALK_CAP);
  const result = { at: Date.now(), entries, partial };
  indexCache.set(root, result);
  return result;
}

/** Case-insensitive tiers: basename prefix > basename substring > path substring; shorter path wins ties. */
export function rankMatches(entries: FileIndexEntry[], query: string): FileIndexEntry[] {
  const q = query.toLowerCase();
  const scored: { entry: FileIndexEntry; tier: number }[] = [];
  for (const entry of entries) {
    const name = entry.name.toLowerCase();
    const path = entry.path.toLowerCase();
    const tier = name.startsWith(q) ? 0 : name.includes(q) ? 1 : path.includes(q) ? 2 : -1;
    if (tier >= 0) scored.push({ entry, tier });
  }
  scored.sort(
    (a, b) =>
      a.tier - b.tier ||
      a.entry.path.length - b.entry.path.length ||
      a.entry.path.localeCompare(b.entry.path),
  );
  return scored.map((s) => s.entry);
}

export function searchFiles(root: string, query: string, limit = 50): { matches: UIFileMatch[]; partial: boolean } {
  const { entries, partial } = buildFileIndex(root);
  const clamped = Math.max(1, Math.min(Math.trunc(limit) || 50, MAX_LIMIT));
  const q = query.trim();
  if (!q) {
    const top = entries
      .filter((e) => !e.path.includes("/"))
      .sort((a, b) =>
        a.type !== b.type
          ? a.type === "dir" ? -1 : 1
          : a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
      );
    return { matches: top.slice(0, EMPTY_QUERY_CAP), partial };
  }
  return { matches: rankMatches(entries, q).slice(0, clamped), partial };
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`node --import tsx --test tests/files.test.ts && npm run typecheck`
预期：全部 PASS。

- [ ] **步骤 5：Commit**

```bash
git add server/files.ts tests/files.test.ts
git commit -m "feat(文件树): 服务端文件搜索（遍历索引 + 分级排序 + 5s 缓存）"
```

---

### 任务 3：协议类型 + REST 端点

**文件：**
- 修改：`shared/protocol.ts`
- 修改：`server/index.ts`

- [ ] **步骤 1：protocol 类型（若任务 1 已加则跳过 `UITreeNode`/`UITreeResponse`）**

在 `shared/protocol.ts` 的 `UIForkPoint` 之后追加：

```ts
/** One entry in a project directory listing (single level). */
export interface UITreeNode {
  name: string;
  /** Path relative to the project root (POSIX separators) */
  path: string;
  type: "dir" | "file";
  /** Whether a dir has displayable children (drives the expand chevron) */
  hasChildren?: boolean;
  /** Dir exists but is unreadable (EACCES) */
  inaccessible?: boolean;
}

export interface UITreeResponse {
  /** Project root, ~-shortened for display */
  root: string;
  /** The listed directory, relative ("" = root) */
  path: string;
  nodes: UITreeNode[];
  truncated?: boolean;
}

/** A file/dir hit from project-wide search. */
export interface UIFileMatch {
  name: string;
  path: string;
  type: "dir" | "file";
}

export interface UIFileSearchResponse {
  root: string;
  query: string;
  matches: UIFileMatch[];
  /** Walk hit its safety cap — results may be incomplete */
  partial?: boolean;
}
```

- [ ] **步骤 2：服务端端点 + cwd 校验**

在 `server/index.ts`：

a) 顶部 import 追加：

```ts
import { listDir, searchFiles, PathEscapeError } from "./files.ts";
```

b) 在 `gitBranchAt` 附近（工具函数区）新增：

```ts
/** ~-shorten an absolute path for display */
function shortenHome(p: string): string {
  return p === HOME ? "~" : p.startsWith(HOME + "/") ? "~" + p.slice(HOME.length) : p;
}

// Known-project cache for file API authorization (anti arbitrary-read).
const KNOWN_ROOTS_TTL_MS = 3_000;
let knownRootsCache: { at: number; roots: Set<string> } | null = null;

/** Roots the file APIs may serve: loaded runtimes + sessions' cwds + the chat workspace. */
async function knownProjectRoots(): Promise<Set<string>> {
  if (knownRootsCache && Date.now() - knownRootsCache.at < KNOWN_ROOTS_TTL_MS) {
    return knownRootsCache.roots;
  }
  const roots = new Set<string>([AGENT_CWD]);
  for (const entry of entries.values()) roots.add(entry.runtime.cwd);
  try {
    for (const s of await SessionManager.listAll()) if (s.cwd) roots.add(s.cwd);
  } catch {
    /* keep the entry/AGENT_CWD roots */
  }
  knownRootsCache = { at: Date.now(), roots };
  return roots;
}
```

c) 在 HTTP handler 的 `/api/fork-points` 分支之后新增：

```ts
    // Project file browsing (tree + @-mention search). cwd must be a known project root.
    if (url.pathname === "/api/tree" || url.pathname === "/api/files/search") {
      const root = expandHome(url.searchParams.get("cwd") ?? "");
      if (!root || !(await knownProjectRoots()).has(root)) {
        res.writeHead(403, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unknown project cwd" }));
        return;
      }
      try {
        if (!statSync(root).isDirectory()) throw Object.assign(new Error("not a directory"), { code: "ENOENT" });
        if (url.pathname === "/api/tree") {
          const rel = url.searchParams.get("path") ?? "";
          const { nodes, truncated } = listDir(root, rel);
          const body: UITreeResponse = { root: shortenHome(root), path: rel, nodes, ...(truncated ? { truncated } : {}) };
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(body));
          return;
        }
        const q = url.searchParams.get("q") ?? "";
        const limitParam = Number(url.searchParams.get("limit") ?? "50");
        const { matches, partial } = searchFiles(root, q, Number.isFinite(limitParam) ? limitParam : 50);
        const body: UIFileSearchResponse = { root: shortenHome(root), query: q, matches, ...(partial ? { partial } : {}) };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
        return;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        const status =
          err instanceof PathEscapeError || code === "ENOTDIR" ? 400
          : code === "ENOENT" ? 404
          : code === "EACCES" ? 403
          : 500;
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        return;
      }
    }
```

d) `protocol.ts` 的类型 import 补充到 `server/index.ts` 顶部既有 import 块（`UITreeResponse`、`UIFileSearchResponse`）。`statSync` 并入 `node:fs` 既有 import。

- [ ] **步骤 3：typecheck + 既有测试回归**

运行：`npm run typecheck && npm test`
预期：全绿。

- [ ] **步骤 4：手动冒烟（curl）**

```bash
npm run dev:server   # 另开终端；token 见 ~/.pi/web-chat/token
TOKEN=$(cat ~/.pi/web-chat/token)
# 已知项目（用本仓库或 ~/.pi/web-chat）：
curl -s "http://127.0.0.1:3141/api/tree?cwd=$(pwd)&path=&token=$TOKEN" | head -c 400
curl -s "http://127.0.0.1:3141/api/files/search?cwd=$(pwd)&q=chat&token=$TOKEN" | head -c 400
# 反例：
curl -s -o /dev/null -w "%{http_code}\n" "http://127.0.0.1:3141/api/tree?cwd=/etc&token=$TOKEN"   # 预期 403
curl -s -o /dev/null -w "%{http_code}\n" "http://127.0.0.1:3141/api/tree?cwd=$(pwd)&path=../..&token=$TOKEN"  # 预期 400
```

预期：两个正向请求返回 JSON（`root` 为 `~` 缩写）；反例分别为 403/400。

- [ ] **步骤 5：Commit**

```bash
git add shared/protocol.ts server/index.ts
git commit -m "feat(文件树): /api/tree 与 /api/files/search 端点（cwd 白名单校验）"
```

---

### 任务 4：inject 机制扩展（insert 模式）

**文件：**
- 修改：`src/lib/chat.ts`
- 修改：`src/components/Composer.tsx`

- [ ] **步骤 1：`chat.ts` 类型与 API**

a) `ChatState.injectText` 改为：

```ts
  /** Text to inject into the composer (fork refill = replace; file reference = insert) — cleared after consumption */
  injectText: { text: string; mode: "replace" | "insert" } | null;
```

`createInitialState` 保持 `injectText: null`。

b) `forked` 事件分支改为 `this.update({ injectText: { text: event.selectedText, mode: "replace" } })`。

c) `ChatClient.refillComposer` 改为 `this.update({ injectText: { text, mode: "replace" } })`；紧挨它新增：

```ts
  /** Insert text at the composer caret (file references from the tree panel). */
  insertComposerText(text: string) {
    this.update({ injectText: { text, mode: "insert" } });
  }
```

d) `ChatWorkspaceClient`（`refillComposer` 透传旁）新增：

```ts
  insertComposerText(text: string) {
    this.workspace.getActiveClient()?.insertComposerText(text);
  }
```

- [ ] **步骤 2：Composer 消费端**

把现有 inject 消费 effect（`if (injectText !== null) { setText(injectText); … }`）替换为：

```tsx
  // Inject text into the composer: "replace" refills (fork, reuse), "insert"
  // splices at the caret (file reference from the tree panel).
  useEffect(() => {
    if (injectText === null) return;
    chatClient.consumeInjectText();
    const el = textareaRef.current;
    if (injectText.mode === "replace" || !el) {
      setText(injectText.text);
      el?.focus();
      return;
    }
    const start = el.selectionStart ?? text.length;
    const end = el.selectionEnd ?? text.length;
    setText((prev) => prev.slice(0, start) + injectText.text + prev.slice(end));
    const caret = start + injectText.text.length;
    el.focus();
    requestAnimationFrame(() => {
      el.selectionStart = el.selectionEnd = caret;
    });
  }, [injectText]);
```

注意：effect 闭包里的 `text` 不参与计算（用函数式 `setText`），仅作无 textarea 时的兜底——保持依赖数组 `[injectText]` 不变。

- [ ] **步骤 3：验证**

运行：`npm run typecheck && npm test`
预期：全绿（fork 的 replace 语义不变——`MessageList` 的 `onReuse` 路径不受影响）。

- [ ] **步骤 4：Commit**

```bash
git add src/lib/chat.ts src/components/Composer.tsx
git commit -m "feat(文件引用): injectText 支持光标处插入模式"
```

---

### 任务 5：树客户端基础设施

**文件：**
- 修改：`src/lib/api.ts`
- 创建：`src/lib/filetree.ts`
- 修改：`src/lib/drawer.ts`
- 修改：`src/lib/useEdgeSwipe.ts`

- [ ] **步骤 1：`api.ts` 增加 tree hooks（`UITreeResponse` 加入顶部 import type 列表）**

```ts
export function useTree(cwd: string | undefined, path: string, enabled = true) {
  return useQuery({
    queryKey: ["tree", cwd, path],
    queryFn: () =>
      fetchJson<UITreeResponse>(
        `/api/tree?cwd=${encodeURIComponent(cwd ?? "")}&path=${encodeURIComponent(path)}`,
      ),
    enabled: enabled && !!cwd,
    staleTime: 0,
  });
}

/** Refresh every fetched level of a project's tree (refresh button) */
export function useInvalidateTree() {
  const qc = useQueryClient();
  return (cwd: string) => qc.invalidateQueries({ queryKey: ["tree", cwd] });
}
```

- [ ] **步骤 2：创建 `src/lib/filetree.ts`（仿 `sidebar.ts` 的 useSyncExternalStore + localStorage 模式）**

```ts
import { useSyncExternalStore } from "react";

const PANEL_KEY = "pi-web-chat:files-panel-open";
/** cwd → expanded relative dir paths */
const EXPANDED_KEY = "pi-web-chat:files-tree-expanded";
const listeners = new Set<() => void>();

function readPanelOpen(): boolean {
  try {
    return localStorage.getItem(PANEL_KEY) === "1";
  } catch {
    return false;
  }
}

function readExpanded(): Record<string, string[]> {
  try {
    const raw = localStorage.getItem(EXPANDED_KEY);
    return raw ? (JSON.parse(raw) as Record<string, string[]>) : {};
  } catch {
    return {};
  }
}

let panelOpen = typeof window !== "undefined" ? readPanelOpen() : false;
let expandedByCwd = typeof window !== "undefined" ? readExpanded() : {};

function emit() {
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useFilesPanelOpen(): boolean {
  return useSyncExternalStore(subscribe, () => panelOpen, () => false);
}

export function setFilesPanelOpen(open: boolean) {
  panelOpen = open;
  try {
    localStorage.setItem(PANEL_KEY, open ? "1" : "0");
  } catch {
    /* ignore */
  }
  emit();
}

export function isTreeDirExpanded(cwd: string, path: string): boolean {
  return (expandedByCwd[cwd] ?? []).includes(path);
}

export function toggleTreeDirExpanded(cwd: string, path: string) {
  const current = expandedByCwd[cwd] ?? [];
  const next = current.includes(path) ? current.filter((p) => p !== path) : [...current, path];
  expandedByCwd = { ...expandedByCwd, [cwd]: next };
  try {
    localStorage.setItem(EXPANDED_KEY, JSON.stringify(expandedByCwd));
  } catch {
    /* ignore */
  }
  emit();
}

export function useTreeDirExpanded(cwd: string, path: string): boolean {
  return useSyncExternalStore(subscribe, () => isTreeDirExpanded(cwd, path), () => false);
}
```

- [ ] **步骤 3：`drawer.ts` 增加 files 通道**

文件头注释改为 `Drawer open-request event buses (sessions + files).`，追加：

```ts
const filesListeners = new Set<() => void>();

/** Request the files drawer to open (header button on mobile, right-edge swipe) */
export function requestOpenFilesDrawer() {
  for (const l of filesListeners) l();
}

/** Subscribe to files-drawer open requests. Returns a cleanup function. */
export function onRequestOpenFilesDrawer(listener: () => void) {
  filesListeners.add(listener);
  return () => {
    filesListeners.delete(listener);
  };
}
```

- [ ] **步骤 4：`useEdgeSwipe.ts` 泛化出右缘变体**

保留 `useLeftEdgeSwipe` 签名不变（内部委托），新增：

```ts
/**
 * Detects a swipe left from the right edge of the screen.
 * Used to open the mobile files drawer.
 */
export function useRightEdgeSwipe({
  enabled = true,
  edgeSize = 28,
  threshold = 60,
  onSwipeLeft,
}: {
  enabled?: boolean;
  edgeSize?: number;
  threshold?: number;
  onSwipeLeft: () => void;
}) {
  useEffect(() => {
    if (!enabled) return;
    let startX = 0;
    let startY = 0;
    let tracking = false;
    let fired = false;

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) {
        tracking = false;
        return;
      }
      const t = e.touches[0];
      if (t.clientX >= window.innerWidth - edgeSize) {
        startX = t.clientX;
        startY = t.clientY;
        tracking = true;
        fired = false;
      } else {
        tracking = false;
      }
    };

    const onTouchMove = (e: TouchEvent) => {
      if (!tracking || fired) return;
      const t = e.touches[0];
      const dx = t.clientX - startX;
      const dy = t.clientY - startY;
      if (-dx >= threshold && Math.abs(dx) > Math.abs(dy) * 1.2) {
        fired = true;
        tracking = false;
        onSwipeLeft();
      } else if (Math.abs(dy) > Math.abs(dx) * 1.5) {
        tracking = false;
      }
    };

    const onTouchEnd = () => {
      tracking = false;
      fired = false;
    };

    document.addEventListener("touchstart", onTouchStart, { passive: true });
    document.addEventListener("touchmove", onTouchMove, { passive: true });
    document.addEventListener("touchend", onTouchEnd, { passive: true });
    document.addEventListener("touchcancel", onTouchEnd, { passive: true });
    return () => {
      document.removeEventListener("touchstart", onTouchStart);
      document.removeEventListener("touchmove", onTouchMove);
      document.removeEventListener("touchend", onTouchEnd);
      document.removeEventListener("touchcancel", onTouchEnd);
    };
  }, [enabled, edgeSize, threshold, onSwipeLeft]);
}
```

- [ ] **步骤 5：验证 + Commit**

运行：`npm run typecheck`
预期：无错。

```bash
git add src/lib/api.ts src/lib/filetree.ts src/lib/drawer.ts src/lib/useEdgeSwipe.ts
git commit -m "feat(文件树): 客户端基础设施（tree hooks/面板状态/抽屉总线/右缘手势）"
```

---

### 任务 6：FileTreePanel + 双宿主 + ChatPage 接线

**文件：**
- 创建：`src/components/FileTreePanel.tsx`
- 修改：`src/components/ChatPage.tsx`
- 修改：`src/i18n/en.ts`、`src/i18n/zh.ts`、`src/i18n/ko.ts`、`src/i18n/ja.ts`

- [ ] **步骤 1：i18n 键（先加，组件引用才能过 typecheck）**

`en.ts` 的 `Messages` 类型与 `en` 对象同步加（zh/ko/ja 同键）：

| key | en | zh | ko | ja |
|-----|----|----|----|----|
| `files` | Files | 文件 | 파일 | ファイル |
| `closeFiles` | Close files | 关闭文件面板 | 파일 패널 닫기 | ファイルパネルを閉じる |
| `refreshTree` | Refresh | 刷新 | 새로고침 | 更新 |
| `emptyDirectory` | Empty directory | 空目录 | 빈 디렉터리 | 空のディレクトリ |
| `treeLoadError` | Failed to load — tap to retry | 加载失败，点击重试 | 불러오기 실패 — 탭하여 재시도 | 読み込み失敗 — タップで再試行 |
| `treeTruncated` | Showing the first 1000 entries | 仅显示前 1000 条 | 처음 1000개만 표시 중 | 最初の1000件を表示中 |
| `inaccessible` | No access | 无访问权限 | 접근 권한 없음 | アクセス権なし |

- [ ] **步骤 2：创建 `src/components/FileTreePanel.tsx`**

```tsx
import { Dialog } from "@base-ui-components/react/dialog";
import { useEffect, useState } from "react";
import type { UITreeNode } from "../../shared/protocol";
import { useInvalidateTree, useTree } from "../lib/api";
import { chatClient, useChat } from "../lib/chat";
import { onRequestOpenFilesDrawer } from "../lib/drawer";
import {
  setFilesPanelOpen,
  toggleTreeDirExpanded,
  useFilesPanelOpen,
  useTreeDirExpanded,
} from "../lib/filetree";
import { useT } from "../lib/i18n";

function ChevronIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={`size-3 shrink-0 fill-none stroke-current stroke-2 transition-transform ${expanded ? "rotate-90" : ""}`}
      aria-hidden
    >
      <path d="m9 6 6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function TreeNodeRow({
  cwd,
  node,
  depth,
  onPickFile,
}: {
  cwd: string;
  node: UITreeNode;
  depth: number;
  onPickFile?: () => void;
}) {
  const t = useT();
  const expanded = useTreeDirExpanded(cwd, node.path);
  const indent = { paddingLeft: `${depth * 14 + 10}px` };

  if (node.type === "dir") {
    return (
      <div>
        <button
          type="button"
          style={indent}
          disabled={node.inaccessible}
          onClick={() => toggleTreeDirExpanded(cwd, node.path)}
          title={node.inaccessible ? t("inaccessible") : node.path}
          aria-expanded={node.inaccessible ? undefined : expanded}
          className={`flex w-full min-w-0 items-center gap-1.5 rounded-md py-1.5 pr-2 text-left text-[13px] transition-colors ${
            node.inaccessible ? "cursor-not-allowed text-faint" : "text-muted hover:bg-hover hover:text-ink"
          }`}
        >
          {node.inaccessible ? <span className="size-3 shrink-0" aria-hidden /> : <ChevronIcon expanded={expanded} />}
          {/* nf-fa-folder_o / folder_open_o */}
          <span className="shrink-0 font-mono text-[12px] text-faint" aria-hidden>
            {expanded ? "\uf115" : "\uf114"}
          </span>
          <span className="truncate">{node.name}</span>
        </button>
        {expanded && !node.inaccessible && <TreeDir cwd={cwd} path={node.path} depth={depth + 1} onPickFile={onPickFile} />}
      </div>
    );
  }

  return (
    <button
      type="button"
      style={indent}
      onClick={() => {
        chatClient.insertComposerText(`@${node.path} `);
        onPickFile?.();
      }}
      title={node.path}
      className="flex w-full min-w-0 items-center gap-1.5 rounded-md py-1.5 pr-2 text-left text-[13px] text-muted transition-colors hover:bg-hover hover:text-ink"
    >
      <span className="size-3 shrink-0" aria-hidden />
      {/* nf-fa-file_o */}
      <span className="shrink-0 font-mono text-[12px] text-faint" aria-hidden>
        {"\uf016"}
      </span>
      <span className="truncate">{node.name}</span>
    </button>
  );
}

function TreeDir({
  cwd,
  path,
  depth,
  onPickFile,
}: {
  cwd: string;
  path: string;
  depth: number;
  onPickFile?: () => void;
}) {
  const t = useT();
  const { data, isPending, isError, refetch } = useTree(cwd, path);
  const indent = { paddingLeft: `${depth * 14 + 10}px` };

  if (isPending) {
    return (
      <div style={indent} className="py-1.5 text-[12px] text-faint" aria-busy>
        …
      </div>
    );
  }
  if (isError) {
    return (
      <button
        type="button"
        style={indent}
        onClick={() => void refetch()}
        className="py-1.5 text-[12px] text-faint transition-colors hover:text-ink"
      >
        {t("treeLoadError")}
      </button>
    );
  }
  if (data.nodes.length === 0) {
    return (
      <div style={indent} className="py-1.5 text-[12px] text-faint">
        {t("emptyDirectory")}
      </div>
    );
  }
  return (
    <>
      {data.nodes.map((node) => (
        <TreeNodeRow key={node.path} cwd={cwd} node={node} depth={depth} onPickFile={onPickFile} />
      ))}
      {data.truncated && (
        <div style={indent} className="py-1.5 text-[11px] text-faint">
          {t("treeTruncated")}
        </div>
      )}
    </>
  );
}

/** Shared tree content (desktop sidebar + mobile drawer), rooted at the active tab's cwd. */
export function FileTreePanel({ onClose, onPickFile }: { onClose?: () => void; onPickFile?: () => void }) {
  const t = useT();
  const { snapshot } = useChat();
  const cwd = snapshot?.cwd;
  const invalidateTree = useInvalidateTree();
  const rootQuery = useTree(cwd, "", !!cwd);

  return (
    <>
      <div className="flex items-center justify-between gap-1 px-3 py-2.5 pt-[calc(0.75rem+env(safe-area-inset-top))] md:pt-2.5">
        <h2 className="min-w-0 flex-1 truncate px-1 text-[15px] font-semibold tracking-tight text-ink" title={cwd}>
          {rootQuery.data?.root ?? t("files")}
        </h2>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={() => cwd && invalidateTree(cwd)}
            title={t("refreshTree")}
            aria-label={t("refreshTree")}
            className="flex size-8 items-center justify-center rounded-lg text-faint transition-colors hover:bg-hover hover:text-ink"
          >
            <svg viewBox="0 0 24 24" className="size-4 fill-none stroke-current stroke-[1.8]" aria-hidden>
              <path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              title={t("closeFiles")}
              aria-label={t("closeFiles")}
              className="flex size-8 items-center justify-center rounded-lg text-faint transition-colors hover:bg-hover hover:text-ink"
            >
              <svg viewBox="0 0 24 24" className="size-4 fill-none stroke-current stroke-2" aria-hidden>
                <path d="M18 6 6 18M6 6l12 12" strokeLinecap="round" />
              </svg>
            </button>
          )}
        </div>
      </div>
      <div className="thin-scroll flex-1 overflow-y-auto px-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))]">
        {cwd ? (
          <TreeDir cwd={cwd} path="" depth={0} onPickFile={onPickFile} />
        ) : (
          <div className="px-4 py-8 text-center text-sm text-faint">{t("emptyDirectory")}</div>
        )}
      </div>
    </>
  );
}

/** Desktop docked right panel (md+), controlled by the header toggle. */
export function FilesSidebar() {
  const open = useFilesPanelOpen();
  if (!open) return null;
  return (
    <aside className="hidden h-full min-h-0 w-64 shrink-0 flex-col overflow-hidden bg-sidebar md:flex">
      <FileTreePanel onClose={() => setFilesPanelOpen(false)} />
    </aside>
  );
}

/** Mobile right-edge overlay drawer. */
export function FilesDrawer() {
  const [open, setOpen] = useState(false);
  useEffect(() => onRequestOpenFilesDrawer(() => setOpen(true)), []);
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 bg-black/40 transition-opacity data-[starting-style]:opacity-0 data-[ending-style]:opacity-0" />
        <Dialog.Popup className="fixed inset-y-0 right-0 flex w-[82vw] max-w-xs flex-col bg-sidebar shadow-2xl outline-none transition-transform data-[starting-style]:translate-x-full data-[ending-style]:translate-x-full">
          <FileTreePanel onClose={() => setOpen(false)} onPickFile={() => setOpen(false)} />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
```

- [ ] **步骤 3：`ChatPage.tsx` 接线**

a) import 追加：

```tsx
import { FilesDrawer, FilesSidebar } from "./FileTreePanel";
import { requestOpenFilesDrawer } from "../lib/drawer";
import { setFilesPanelOpen, useFilesPanelOpen } from "../lib/filetree";
import { useRightEdgeSwipe } from "../lib/useEdgeSwipe";
```

b) 组件内（`sidebarPinned` 声明旁）：

```tsx
const filesPanelOpen = useFilesPanelOpen();
// Right edge → left swipe opens the files drawer (mirrors the sessions gesture)
useRightEdgeSwipe({ enabled: !filesPanelOpen, onSwipeLeft: requestOpenFilesDrawer });
```

c) 头部 "+" 按钮**左侧**插入切换按钮（folder 图标样式对齐 "+" 按钮）：

```tsx
          <button
            type="button"
            onClick={() => {
              // Desktop toggles the docked panel; mobile opens the overlay drawer
              if (window.matchMedia("(min-width: 768px)").matches) {
                setFilesPanelOpen(!filesPanelOpen);
              } else {
                requestOpenFilesDrawer();
              }
            }}
            aria-label={t("files")}
            title={t("files")}
            aria-pressed={filesPanelOpen}
            className="flex size-9 shrink-0 items-center justify-center rounded-lg text-faint transition-colors hover:bg-hover hover:text-ink"
          >
            <svg viewBox="0 0 24 24" className="size-5 fill-none stroke-current stroke-[1.8]" aria-hidden>
              <path
                d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6Z"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
```

d) 根布局挂载宿主（主聊天 `div` 之后）：

```tsx
      <FilesSidebar />
      <FilesDrawer />
```

- [ ] **步骤 4：验证**

运行：`npm run typecheck && npm run build`
预期：全绿。手动冒烟（`npm run dev`）：桌面点头部 folder 按钮 → 右侧面板开合、刷新、展开/折叠持久化、点文件插入 `@path `；移动视口 → 按钮开右侧抽屉、右缘左滑开抽屉、点文件插入后抽屉关闭；切换会话 tab → 树换根。

- [ ] **步骤 5：Commit**

```bash
git add src/components/FileTreePanel.tsx src/components/ChatPage.tsx src/i18n/
git commit -m "feat(文件树): 头部入口 + 右侧文件面板（桌面 docked / 移动抽屉）"
```

---

### 任务 7：`src/lib/mention.ts` 纯函数

**文件：**
- 创建：`src/lib/mention.ts`
- 测试：`tests/mention.test.ts`

- [ ] **步骤 1：编写失败的测试**

创建 `tests/mention.test.ts`：

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { extractMentionQuery, replaceMentionToken } from "../src/lib/mention.ts";

test("extractMentionQuery: @ at text start with empty query", () => {
  assert.deepEqual(extractMentionQuery("@", 1), { start: 0, query: "" });
});

test("extractMentionQuery: query is the fragment between @ and caret", () => {
  assert.deepEqual(extractMentionQuery("@cha", 4), { start: 0, query: "cha" });
  assert.deepEqual(extractMentionQuery("look at @src/com", 16), { start: 8, query: "src/com" });
});

test("extractMentionQuery: caret before token end uses prefix up to caret", () => {
  // caret right after @ inside "@chat" (caret = 2)
  assert.deepEqual(extractMentionQuery("@chat", 2), { start: 0, query: "c" });
});

test("extractMentionQuery: email-like text does not trigger", () => {
  assert.equal(extractMentionQuery("a@b", 3), null);
  assert.equal(extractMentionQuery("mail a@b.com", 12), null);
});

test("extractMentionQuery: caret past the token (after whitespace) does not trigger", () => {
  assert.equal(extractMentionQuery("@foo bar", 8), null);
  assert.equal(extractMentionQuery("@foo ", 5), null);
});

test("replaceMentionToken: splices insert over [start, caret) and reports new caret", () => {
  const { next, caret } = replaceMentionToken("see @cha please", 4, 8, "@src/chat.ts ");
  assert.equal(next, "see @src/chat.ts please");
  assert.equal(caret, 4 + "@src/chat.ts ".length);
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --import tsx --test tests/mention.test.ts`
预期：FAIL，`Cannot find module '../src/lib/mention.ts'`。

- [ ] **步骤 3：实现 `src/lib/mention.ts`**

```ts
/** Composer @-mention parsing (pure, unit-testable). */

export interface MentionQuery {
  /** Index of the "@" in text */
  start: number;
  /** Text between "@" and the caret */
  query: string;
}

/**
 * The caret sits inside an `@token` → its query, else null.
 * A token starts at the beginning of the text or after whitespace,
 * so email-like "a@b" never triggers.
 */
export function extractMentionQuery(text: string, caret: number): MentionQuery | null {
  let i = caret - 1;
  while (i >= 0 && !/\s/.test(text[i]!)) i--;
  const start = i + 1;
  if (text[start] !== "@") return null;
  return { start, query: text.slice(start + 1, caret) };
}

/** Replace [start, caret) with insert and report the caret position after it. */
export function replaceMentionToken(
  text: string,
  start: number,
  caret: number,
  insert: string,
): { next: string; caret: number } {
  return { next: text.slice(0, start) + insert + text.slice(caret), caret: start + insert.length };
}
```

- [ ] **步骤 4：运行测试验证通过 + Commit**

运行：`node --import tsx --test tests/mention.test.ts && npm run typecheck`
预期：6 个测试全 PASS。

```bash
git add src/lib/mention.ts tests/mention.test.ts
git commit -m "feat(文件引用): mention 触发解析与替换纯函数"
```

---

### 任务 8：FileMentionPalette + Composer 接线

**文件：**
- 创建：`src/components/FileMentionPalette.tsx`
- 修改：`src/components/Composer.tsx`
- 修改：`src/lib/api.ts`
- 修改：`src/i18n/en.ts`、`src/i18n/zh.ts`、`src/i18n/ko.ts`、`src/i18n/ja.ts`

- [ ] **步骤 1：i18n 键**

| key | en | zh | ko | ja |
|-----|----|----|----|----|
| `mentionNoFiles` | No matching files | 无匹配文件 | 일치하는 파일 없음 | 一致するファイルなし |
| `mentionPartial` | Results may be incomplete — keep typing | 结果可能不全，请继续输入 | 결과가 불완전할 수 있음 — 계속 입력 | 結果が不完全な可能性があります — 続けて入力 |

- [ ] **步骤 2：`api.ts` 增加 `useFileSearch`（`UIFileSearchResponse` 加入 import type 列表）**

```ts
export function useFileSearch(cwd: string | undefined, query: string, enabled = true) {
  return useQuery({
    queryKey: ["file-search", cwd, query],
    queryFn: () =>
      fetchJson<UIFileSearchResponse>(
        `/api/files/search?cwd=${encodeURIComponent(cwd ?? "")}&q=${encodeURIComponent(query)}`,
      ),
    enabled: enabled && !!cwd,
    staleTime: 2_000,
    // Keep previous results while the next keystroke's request is in flight
    placeholderData: (prev) => prev,
  });
}
```

- [ ] **步骤 3：创建 `src/components/FileMentionPalette.tsx`（交互/样式镜像 `CommandPalette`）**

```tsx
import type { UIFileMatch } from "../../shared/protocol";
import { useT } from "../lib/i18n";

const POPUP_CLASS =
  "absolute right-0 bottom-[calc(100%+0.5rem)] left-0 z-20 rounded-lg border border-line bg-card shadow-lg";

export function FileMentionPalette({
  matches,
  activeIndex,
  partial,
  onSelect,
}: {
  matches: UIFileMatch[];
  activeIndex: number;
  partial?: boolean;
  onSelect: (match: UIFileMatch) => void;
}) {
  const t = useT();
  if (matches.length === 0) {
    return <div className={`${POPUP_CLASS} px-3 py-3 text-sm text-faint`}>{t("mentionNoFiles")}</div>;
  }
  return (
    <div className={`${POPUP_CLASS} max-h-72 overflow-y-auto py-1`} role="listbox" aria-label={t("files")}>
      {matches.map((match, index) => (
        <button
          key={match.path}
          type="button"
          role="option"
          aria-selected={index === activeIndex}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onSelect(match)}
          className={`flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left transition-colors ${
            index === activeIndex ? "bg-hover" : "hover:bg-hover"
          }`}
        >
          <span className="shrink-0 font-mono text-[12px] text-faint" aria-hidden>
            {match.type === "dir" ? "\uf114" : "\uf016"}
          </span>
          <span className="shrink-0 font-mono text-[13px] text-ink">
            {match.name}
            {match.type === "dir" ? "/" : ""}
          </span>
          <span className="min-w-0 flex-1 truncate text-xs text-faint">{match.path}</span>
        </button>
      ))}
      {partial && <div className="px-3 py-1 text-[10px] text-faint">{t("mentionPartial")}</div>}
    </div>
  );
}
```

- [ ] **步骤 4：`Composer.tsx` 接线**

a) import 追加：

```tsx
import { FileMentionPalette } from "./FileMentionPalette";
import { extractMentionQuery, replaceMentionToken } from "../lib/mention";
import { useFileSearch } from "../lib/api";
```

b) state 区（`commandPaletteDismissed` 旁）追加：

```tsx
  const [caret, setCaret] = useState(0);
  const [mentionDismissed, setMentionDismissed] = useState(false);
  const [activeMentionIndex, setActiveMentionIndex] = useState(0);
  const [debouncedMentionQuery, setDebouncedMentionQuery] = useState("");
```

c) mention 派生态（`commandPaletteOpen` 计算之后）：

```tsx
  const mention = useMemo(() => extractMentionQuery(text, caret), [text, caret]);
  // Mention wins over the command palette: caret context beats whole-text context
  const mentionMode = mention !== null && !mentionDismissed && !commandPaletteOpen;

  useEffect(() => {
    const id = window.setTimeout(() => setDebouncedMentionQuery(mention?.query ?? ""), 150);
    return () => window.clearTimeout(id);
  }, [mention?.query]);

  const { data: mentionData } = useFileSearch(snapshot?.cwd, debouncedMentionQuery, mentionMode);
  const mentionMatches = useMemo(
    () => (mentionMode ? (mentionData?.matches ?? []) : []),
    [mentionMode, mentionData],
  );

  useEffect(() => {
    setActiveMentionIndex(0);
  }, [mention?.query]);

  const completeMention = (match: { path: string; type: "dir" | "file" }) => {
    if (!mention) return;
    const insert = `@${match.path}${match.type === "dir" ? "/" : ""} `;
    const { next, caret: nextCaret } = replaceMentionToken(text, mention.start, caret, insert);
    setText(next);
    setMentionDismissed(true);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.selectionStart = el.selectionEnd = nextCaret;
    });
  };
```

d) textarea 追踪 caret：`onChange` 内 `setText(e.target.value);` 后加 `setCaret(e.target.selectionStart ?? 0); setMentionDismissed(false);`（与既有 `setCommandPaletteDismissed(false)` 并列）；textarea 加 `onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}`。

e) 渲染：`CommandPalette` 渲染块旁（同一 `relative` 容器内）：

```tsx
        {mentionMode && (
          <FileMentionPalette
            matches={mentionMatches}
            activeIndex={Math.min(activeMentionIndex, Math.max(0, mentionMatches.length - 1))}
            partial={mentionData?.partial}
            onSelect={completeMention}
          />
        )}
```

f) 键盘：既有 `onKeyDown` 的 command-palette 分支**之前**插入 mention 分支（Enter/Tab 都选中——mention 开着时 Enter 不得发送）：

```tsx
              if (mentionMode && !e.nativeEvent.isComposing) {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setActiveMentionIndex((index) => Math.min(index + 1, Math.max(0, mentionMatches.length - 1)));
                  return;
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setActiveMentionIndex((index) => Math.max(index - 1, 0));
                  return;
                }
                if ((e.key === "Tab" || e.key === "Enter") && mentionMatches[activeMentionIndex]) {
                  e.preventDefault();
                  completeMention(mentionMatches[activeMentionIndex]!);
                  return;
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  setMentionDismissed(true);
                  return;
                }
              }
```

说明：发送后 `text` 清空 → `mention` 为 null → 弹层自闭；tab 切换时 Composer 按 `tabKey` 重挂载 → state 自动复位。

- [ ] **步骤 5：验证**

运行：`npm run typecheck && npm test && npm run build`
预期：全绿。手动冒烟：输入 `@` → 根层建议；继续输入 → 模糊过滤；↑↓/Enter/Tab/Esc/点击行为正确；选中后 `@path ` 落位且光标在其后；`a@b` 不触发；mention 开启时 Enter 不发送。

- [ ] **步骤 6：Commit**

```bash
git add src/components/FileMentionPalette.tsx src/components/Composer.tsx src/lib/api.ts src/i18n/
git commit -m "feat(文件引用): Composer @ 模糊搜索引用项目文件"
```

---

### 任务 9：版本 + 发布说明 + 全量回归

**文件：**
- 修改：`package.json`、`package-lock.json`、`release-notes.json`

- [ ] **步骤 1：版本 +1（同步 package.json 与 package-lock.json）**

```bash
npm version patch --no-git-tag-version
```

- [ ] **步骤 2：`release-notes.json` 顶部（`{` 之后）加入新版本键**

若步骤 1 后版本为 `0.1.67`（以实际为准）：

```json
  "0.1.67": [
    "新增项目文件树：会话页右上角入口，可浏览当前会话项目的目录，点击文件将其 @ 引用插入输入框。",
    "输入框支持 @ 模糊搜索项目文件并快速引用（对齐 pi TUI 的 @ 约定）。"
  ],
```

- [ ] **步骤 3：全量回归**

运行：`npm run typecheck && npm test && npm run build`
预期：全绿。

- [ ] **步骤 4：Commit**

```bash
git add package.json package-lock.json release-notes.json
git commit -m "chore(发布): 0.1.67 文件树与 @ 文件引用"
```

---

## 自检结果（编写者已执行）

**规格覆盖度**：决策表（布局/多 tab/点击行为/过滤/加载/刷新/隐藏文件/符号链接/引用格式）→ 任务 1–6、8；服务端 files.ts → 任务 1–2；端点与 cwd 校验 → 任务 3；protocol → 任务 1（类型先行）/3；头部入口与双宿主 → 任务 6；FileTreePanel → 任务 6；Composer @ → 任务 7–8；inject 扩展 → 任务 4；api hooks → 任务 5/8；i18n → 任务 6/8；错误处理 → 任务 3（状态码映射）+ 任务 6/8（UI 态）；测试 → 任务 1/2/7（自动）+ 任务 3（curl 冒烟）+ 任务 9（回归）；版本 → 任务 9。规格"多 tab 架构事实"为机制说明，无独立任务，由任务 6 手动冒烟覆盖（切 tab 换根）。

**占位符扫描**：无 TODO/待定；所有代码步骤含完整代码块。

**类型一致性**：`UITreeNode/UIFileMatch`（protocol）↔ `listDir/searchFiles`（files.ts）↔ `useTree/useFileSearch`（api.ts）↔ 组件消费，命名一致；`insertComposerText`（chat client + workspace 透传 + Composer 消费 + FileTreePanel 调用）一致；`extractMentionQuery/replaceMentionToken`（mention.ts ↔ Composer）一致；`useFilesPanelOpen/setFilesPanelOpen/useTreeDirExpanded/toggleTreeDirExpanded`（filetree.ts ↔ 组件）一致；`requestOpenFilesDrawer/onRequestOpenFilesDrawer`（drawer.ts ↔ ChatPage/FilesDrawer）一致；`useRightEdgeSwipe` 参数 `onSwipeLeft` 定义与调用一致。
