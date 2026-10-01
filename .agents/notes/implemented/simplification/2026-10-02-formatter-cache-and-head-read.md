# Agent Note: 去掉每行的格式化器构造与每快照的 git 进程

Status: implemented

## Problem

两处按“行/快照”频率重复的固定开销，都是测量出来的、与业务无关的成本：

1. **`Intl` 格式化器按行构造**：`SessionsDrawer` 的行元数据用 `Date#toLocaleDateString` + `toLocaleTimeString`（各自内部新建一个 `Intl.DateTimeFormat`），`formatGitTimestamp` 每次调用 `new Intl.DateTimeFormat(...)`，全量大纲每行的 `title` 每次 `toLocaleString`。本机基准：一对日期+时间 ≈ **36.4µs**，单个时间戳 ≈ **17.6µs**；缓存后分别 ≈ **0.7µs** / **0.4µs**。会话抽屉可以在一次搜索/轮询/切会话里重渲染数百行。
2. **每个快照同步 spawn 一次 git**：`buildSnapshot` 里的 `gitBranchAt` 用 `execFileSync("git", ["branch","--show-current"])`，实测 **5.72ms/次**，且是同步阻塞事件循环；3 秒 TTL 意味着一个持续输出的 turn 里每 3 秒阻塞一次。同机上直接读 `.git/HEAD` 只需 **0.01ms**。

## Decision

- 新增 `src/lib/datetime-format.ts`：`cachedDateTimeFormat(locale, options)` 按 `(locale, options)` 复用实例，并提供 `formatRowDateTime`（列表行）与 `formatFullDateTime`（title 属性）。`SessionsDrawer`、`formatGitTimestamp`、刻度大纲 title 三处改为使用它。
- 新增 `branchFromHeadFile(cwd)`（`server/git.ts`）：直接读 `.git/HEAD`，支持 `.git` 为 gitfile 的 worktree/submodule 形态（`gitdir:` 相对或绝对路径）；返回 `null` 表示脱离分支（与 `--show-current` 的语义一致），返回 `undefined` 表示无法直接读取（裸仓库、非常规布局），由 `gitBranchAt` 回退到原来的 `execFileSync` 分支。

## Alternatives considered

- **保留 `execFileSync`，只把 TTL 拉长** — 否决：TTL 拉长会推迟外部 `git checkout` 的可见时间，而且阻塞仍在（每 3 秒 5.7ms 的同步停顿会推迟同进程内其他会话的事件）。
- **把 `gitBranchAt` 改成异步** — 否决：`buildSnapshot` 是同步函数，被大量事件处理路径同步调用；异步化需要把整条快照链路改成 Promise，收益（10µs）不成比例。
- **只在必要时 spawn git（每次快照读 `.git/HEAD` 已足够便宜）** — 采纳的方向即此项：HEAD 读取 ≈ 10µs，因此常见的仓库布局完全不 spawn。
- **字体子集化（`public/fonts/JetBrainsMonoNerdFont-Medium.woff2`，987KB，占 PWA 预缓存 2.34MiB 的 42%）** — 实测否决：字体共 11,756 个字形，其中 **10,396 个（88%）是 PUA 图标平面**（Plane15 6,896 + BMP PUA 3,500），文件体积由图标而非文字覆盖决定；只裁剪非图标部分几乎不减小体积，而裁掉图标区会让 agent/用户输出里的 Nerd Font 图标变成豆腐块。维持现状，不接线需要 Python `fonttools` 的子集化步骤（会让构建依赖本机工具链）。
- **缓存 `index.html`（每个页面请求 `readFileSync`）** — 实测否决：10.5µs/次，且仅发生在页面加载时（用 mtime 校验只省约 9µs），不值得为此增加状态。

## Consequences

- **收益**：列表行与时间戳渲染不再构造 `Intl` 实例；快照构建不再同步 spawn git，事件循环不再被 5.7ms 的进程启动打断。
- **代价**：`branchFromHeadFile` 需要理解 gitfile/worktree 布局，因此必须保留 git 回退路径与等价性测试；格式化器缓存是进程级无上限 Map，键为 `(locale, options)`，调用点数量固定（3 处、少量选项组合），无需淘汰。
- **验证**：`tests/git.test.ts` 新增 `branchFromHeadFile` 与 `git branch --show-current` 的等价性测试（普通仓库 / worktree / 脱离 HEAD / 非仓库目录，最后一项断言返回 `undefined` 以触发回退）；`tests/datetime-format.test.ts` 断言同键复用同一实例、不同 locale/选项不复用、以及无效输入原样返回；`npm test` 431 项、`npx playwright test` 44 项、`npm run typecheck`、`npm run notes:check`、`npm run pack:check`、`git diff --check` 通过。基准数据由 `node`/`node --import tsx` 一次性脚本测得（同一台机器，非 CI 门禁）。
