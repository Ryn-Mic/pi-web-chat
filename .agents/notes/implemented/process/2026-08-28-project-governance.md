# Agent Note: 版本分支、决策留痕与界面资产规范

Status: implemented

## Problem

项目已有版本同步、验证矩阵和生产端口保护规则，但缺少不可绕过的远程分支交付约束、重要决定的可追溯记录，以及统一的表情与操作图标来源。文档入口也分散在根目录与 `docs/`，Agent 难以快速判断规范、设计记录和交付材料各自的权威位置。

## Decision

项目将每项新需求放在与交付版本一致的 `v<semver>` 分支中，禁止直接向 `main` 推送；完成验证后提交并推送版本分支，代码只通过 Pull Request 合并。版本分支与发布 tag 同名时，合并后删除远程分支再创建 tag，短暂共存时使用完整 ref 名称消除歧义。

代码合并与发布相互独立。commit、版本分支 push、Pull Request 和 `main` 合并都不会触发发布；只有 push `v*` tag，或手动运行 Release workflow 并指定已有 tag，才会重新打包并创建 GitHub Release/npm 发布。不需要发布的提交不创建 tag，也不手动 dispatch Release。`pack:check` 和 `npm pack --dry-run` 保留为 CI 验证，不代表产生或上传发布产物。

`AGENTS.md` 只保留必须执行的项目、架构、Git、版本、决策、视觉、验证和端口规则。`docs/README.md` 是唯一文档总索引，按权威文档、工程决策、历史设计和兼容资料分类；`docs/iconography.md` 承载可独立维护的视觉细则。

项目在 `.agents/skills/write-notes-like-deepseek/` 固定决策记录 skill，并由 `skills-lock.json` 记录来源。重要行为、架构、契约、流程、落盘格式及动手前的选型必须先写 `proposed`，落地时与实现同批更新为 `implemented`，值得保留的否决写入 `rejected`。每篇 Note 必须包含 `## Alternatives considered`。`npm run notes:check` 校验结构与格式，Pull Request CI 执行同一门禁。

界面情绪与 Agent 状态只使用现有 GrokBot 表情系统表达；通用操作、导航、切换与反馈图标使用 Morphicons，并通过项目级路径和语义组件集中复用。品牌/PWA 图标、用户内容、文件预览和第三方嵌入内容保留明确例外。LaoA-GrokBot 的 MIT 许可证随包分发，构建门禁检查该文件存在且非空。

## Alternatives considered

- **继续使用任意功能分支名** — 无法从分支名直接确认交付版本，也容易遗漏版本文件与发布说明同步。
- **把所有背景与索引都塞进 `AGENTS.md`** — 单文件会持续膨胀，降低规则的可扫描性；全局规则应精简，详细资料通过索引分流。
- **只在提交完成后补写决策说明** — 容易丢失未采用方案和选型理由，也无法在动手前暴露错误方向。
- **允许任意 emoji 或图标库** — 会造成状态语义、笔画风格和可访问性处理不一致；GrokBot 与 Morphicons 已是项目现有能力，统一成本最低。
- **使用 `[skip release]` 提交标记控制发布** — 发布本来就由 tag 或手动 dispatch 显式触发；再增加隐式标记会形成第二套状态，并可能被拼写或 squash 丢失。

## Consequences

版本号、分支、发布说明和 PR 范围现在可以直接互相核对，`main` 不再接受直接交付。发布必须经过显式 tag 或手动 dispatch，因此文档、流程或中间修正提交可以合并而不误发包；代价是发布者必须主动完成 tag 步骤。并行工作仍需提前协调版本号，而且同名分支与 tag 的操作必须遵守删除顺序或使用完整 ref。

重要决定具备可检索的理由、备选与代价，CI 能阻止生命周期或格式漂移；代价是非平凡改动多一份必须与实现同步的 Note。文档索引降低旧翻译和历史计划被误当成现行规则的风险，但维护者新增文档时必须同时登记其权威性。

GrokBot 与 Morphicons 形成清晰的视觉职责和无障碍基线。存量裸 SVG 与 emoji 采用触达时迁移，避免一次性改造风险，但在迁移完成前仍存在局部视觉差异。

## Verification

- `.github/workflows/release.yml` 的触发器仅包含 `push.tags: v*` 与带既有 tag 输入的 `workflow_dispatch`；普通分支和 `main` push 不在发布触发范围内。
- `git check-ignore` 确认 `.idea/.gitignore` 与 `.idea/workspace.xml` 均由根 `.gitignore` 的 `.idea/` 规则排除。
- `npm run notes:check` 通过 1 篇 Note 的 tree 与 format 校验。
- `npm run typecheck` 与 `npm test` 通过；测试结果为 274/274。
- `npm run build` 通过，并确认 `third-party-licenses/LaoA-GrokBot-MIT.txt` 的构建门禁。
- 使用隔离 npm cache 的 `npm run pack:check` 通过：62.42 MiB packed、173.07 MiB unpacked、3102 files。
- `npm pack --dry-run --json --ignore-scripts` 生成 `ryn-mic-web-chat-0.1.109.tgz` 元数据，并确认 tarball 包含 GrokBot 许可证与第三方声明。
