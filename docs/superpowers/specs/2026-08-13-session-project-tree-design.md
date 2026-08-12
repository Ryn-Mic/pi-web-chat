# 会话项目目录树设计（2026-08-13）

## 目标

在 Web UI 中展示**当前打开会话所处项目**的目录树：侧栏新增"文件"标签页，懒加载浏览项目目录，点击文件把相对路径插入输入框（Composer），便于在对话中引用文件。

## 决策（默认值，用户未提出异议）

| 决策点 | 选择 | 备选（未采用原因） |
|--------|------|---------------------|
| 布局 | 侧栏 `会话 \| 文件` 标签页（桌面 pinned 侧栏与移动抽屉共用 `SessionsPanel`） | 右侧独立面板（工作量约 2 倍，移动端需单独抽屉）；ProjectBadge 弹出（空间局促） |
| 点击文件 | 相对路径插入 Composer 光标处并聚焦 | 纯浏览（价值低）；文件预览（范围大，后续迭代） |
| 目录过滤 | 硬排除 `.git`/`node_modules` + 根 `.gitignore`（新增 `ignore` 依赖） | 仅硬编码（误显被忽略文件）；不解析嵌套 .gitignore（YAGNI） |
| 加载方式 | 单层懒加载（展开目录时拉取） | 全量树（大项目 payload 不可控） |
| 刷新 | 手动刷新按钮 + 面板激活时拉取 | FS 监听自动刷新（复杂度高，YAGNI） |
| 隐藏文件 | 显示（开发者工具，同 VS Code 默认） | — |
| 符号链接目录 | 不穿透，不可展开（防环） | — |

## 架构与组件

### 服务端

**`server/tree.ts`（新，可独立测试）**

```
listDir(root: string, rel: string) → UITreeNode[] + truncated 标记
```

- 排序：目录优先，同类按 name 大小写不敏感排序。
- 过滤：`.git`、`node_modules` 硬排除；root 存在 `.gitignore` 时用 `ignore` 包编译并应用（仅根级，不递归嵌套）。
- 安全：`resolve(root, rel)` 结果必须等于 root 或位于 root 内（`startsWith(root + sep)`），否则抛 `PathEscapeError`；拒绝绝对路径形式的 rel。
- 符号链接：`lstat`，链接目录标记为文件、不下钻。
- 上限：单目录最多 1000 条，超出截断并返回 `truncated: true`。
- 单目录 EACCES：该目录节点 `hasChildren: false` 并带 `inaccessible: true`（UI 显示"无法访问"），不使整个请求失败。

**`server/index.ts`（新增端点，约 40 行）**

```
GET /api/tree?cwd=<项目路径>&path=<相对路径>
→ UITreeResponse { root, path, nodes, truncated? }
```

- 走既有 `/api/*` token 鉴权。
- **cwd 校验（防任意读盘）**：cwd（展开 `~` 后）必须命中已知项目集合——已加载 entry 的 `runtime.cwd` ∪ `SessionManager.listAll()` 返回的会话 cwd ∪ `AGENT_CWD`；不命中 → 403。
- root 不存在/非目录 → 404（`{ error }`）；path 逃逸 → 400；rel 指向文件 → 400。
- `listAll()` 结果按 3 秒 TTL 缓存（沿用 `gitBranchCache` 的模式），避免每次展开都扫会话目录。

**`shared/protocol.ts`（+~15 行）**

```ts
export interface UITreeNode {
  name: string;
  /** 相对项目根的路径（POSIX 分隔符） */
  path: string;
  type: "dir" | "file";
  /** 目录是否含可展示的子项（决定是否渲染展开箭头） */
  hasChildren?: boolean;
  /** 无权限访问的目录 */
  inaccessible?: boolean;
}

export interface UITreeResponse {
  /** 项目根，~-缩写（展示用） */
  root: string;
  /** 本次返回的相对目录（"" = 根） */
  path: string;
  nodes: UITreeNode[];
  truncated?: boolean;
}
```

### 前端

**侧栏标签切换（`SessionsDrawer.tsx` 内 `SessionsPanel`）**
- 头部标题区改为 `会话 | 文件` 分段切换；选中态存 localStorage（沿用 `src/lib/sidebar.ts` 的 useSyncExternalStore 模式）。
- 桌面 docked 侧栏与移动抽屉共用此面板 → 两端自动获得能力，移动端行高沿用现有 ≥40px 触摸目标。

**`src/components/FileTreePanel.tsx`（新，~200 行）**
- 根行：项目路径（`snapshot.cwd`，~-缩写展示）+ 刷新按钮（使该项目的全部 tree query 失效）。
- 目录行：chevron + 名称；点击展开/折叠。展开时 React Query 拉取 `["tree", cwd, path]`（`staleTime: 0`）。
- 展开集合按项目（cwd）持久化到 localStorage（新 `src/lib/filetree.ts`，沿用 sidebar.ts 模式），重开面板恢复展开状态。
- 文件行：点击 → 经 `composer-insert.ts` 把相对路径插入 Composer 并聚焦。
- 内联状态：加载中骨架行、空目录提示、加载失败可重试、`truncated` 时末尾提示"仅显示前 1000 条"、`inaccessible` 目录置灰。

**`src/lib/composer-insert.ts`（新）+ `Composer.tsx`（小改）**
- 极简发布订阅（仿 `src/lib/drawer.ts`）：`requestComposerInsert(text)`。
- Composer 监听：在当前 tab 草稿文本的光标处插入（无光标则追加末尾，必要时补空格分隔），写入 per-tab 草稿（`composer-drafts.ts`），随后聚焦（复用 `requestComposerFocus`）。

**`src/lib/api.ts`**
- `useTree(cwd: string | undefined, path: string, enabled)` React Query hook；`useInvalidateTree()` 供刷新按钮按 cwd 前缀失效。

**i18n**：`en/zh/ko/ja` 四语言新增键：`files`（文件）、`refreshTree`、`emptyDirectory`、`treeLoadError`、`treeTruncated`、`inaccessible`、`insertFilePath` 等。

## 数据流

1. ChatPage 已有 `snapshot.cwd`（WS 连接即推送；草稿会话同样具备——entry 创建时 runtime 即绑定 cwd）。
2. 用户切到"文件"标签 → FileTreePanel 以 `snapshot.cwd` 为 root 拉取根层。
3. 展开目录 → `GET /api/tree?cwd=…&path=<rel>` → 服务端校验 cwd ∈ 已知项目 → `listDir` 返回单层节点。
4. 点击文件 → `requestComposerInsert(relPath)` → Composer 插入并聚焦。

会话切换（`snapshot.cwd` 变化）→ 面板自动换根（query key 含 cwd）。

## 错误处理

| 场景 | 行为 |
|------|------|
| cwd 不在已知项目集合 | 403 → 面板空态（正常不会发生，客户端只传 snapshot.cwd） |
| 项目目录被删 / 不存在 | 404 → 面板空态 + 重试按钮 |
| 展开瞬间目录被删 | 404 → 该节点下内联错误行，可重试 |
| 子目录无权限 | 节点 `inaccessible`，置灰不可展开 |
| root 无权限 | 403 → 面板错误态 |

## 边界情况

- 草稿会话（未发布）：`snapshot.cwd` 存在（`AGENT_CWD` 或建会话时指定的项目目录），功能可用。
- 非 git 项目：无根 `.gitignore` → 仅应用硬排除。
- 超长文件名/深层缩进：CSS truncate；面板内横向滚动兜底。
- 符号链接成环：不穿透，天然规避。
- 同名大小写文件：排序稳定即可，服务端不做合并。

## 测试

- **`tests/tree.test.ts`（新，node:test + 临时目录 fixture）**：目录优先排序、大小写不敏感、硬排除 `.git`/`node_modules`、根 `.gitignore` 规则生效（含目录型模式）、`truncated` 上限、rel 逃逸抛错、绝对路径 rel 拒绝、符号链接目录不下钻、EACCES 节点标记。
- 端点冒烟：未知 cwd → 403；已知 cwd 根层 200。
- 回归：`npm run typecheck`、`npm run test`、`npm run build`。

## 版本

- 实现完成前：patch +1（当前工作区 0.1.66 → 0.1.67；若实现时工作区版本已变，按当时 +1），同步 `package.json`、`package-lock.json`，并在 `release-notes.json` 对应版本键下加一条用户向描述。

## 明确不做（本期）

- 文件内容预览 / 右键菜单 / 复制路径按钮
- 嵌套 `.gitignore`、全局 gitignore、`core.excludesFile`
- FS 监听自动刷新
- 目录树的创建/重命名/删除等写操作
