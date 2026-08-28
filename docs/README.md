# pi-web-chat 文档索引

本页是仓库文档的统一入口。规则、用户说明、版本事实和历史设计记录各有唯一职责；遇到冲突时，应优先核对当前源码、协议、测试和 Workflow，而不是沿用旧计划中的描述。

## 权威文档

| 文档 | 主要读者 | 用途与权威性 |
|---|---|---|
| [`README.md`](../README.md) | 用户、首次贡献者 | 默认且唯一权威的中文安装、使用、功能与安全说明 |
| [`AGENTS.md`](../AGENTS.md) | Agent、贡献者 | 必须执行的工程、Git、版本、决策、视觉、验证与端口规范 |
| [`release-notes.json`](../release-notes.json) | 用户、发布者 | package 版本对应的用户可见变更事实源 |
| [`package.json`](../package.json) | 开发者、发布者 | 当前包名、版本、入口、脚本、依赖和 npm 发布元数据 |
| [CI Workflow](../.github/workflows/ci.yml) | 贡献者 | Pull Request 与 `main` 的实际持续集成门禁 |
| [Release Workflow](../.github/workflows/release.yml) | 发布者 | tag 校验、打包、GitHub Release 与 npm 发布的实际流程 |
| [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md) | 发布者、合规检查 | 随包分发的第三方组件、视觉资产、来源及许可证 |

## 工程规范与决策

| 路径 | 用途 |
|---|---|
| [`docs/iconography.md`](iconography.md) | GrokBot 表情、Morphicons、动效、可访问性、例外与迁移标准 |
| [`write-notes-like-deepseek`](../.agents/skills/write-notes-like-deepseek/SKILL.md) | 重要决定的生命周期、分类、格式与校验方法 |
| [`.agents/notes/`](../.agents/notes/) | 决策记录；按 lifecycle/class 目录和仓库搜索发现，不维护集中 Note 索引 |

## 设计与研究资料

| 路径 | 状态 | 用途 |
|---|---|---|
| [`docs/superpowers/specs/`](superpowers/specs/) | 历史设计输入 | 记录特定功能当时的设计边界；当前源码、协议和 Agent Note 优先 |
| [`docs/superpowers/plans/`](superpowers/plans/) | 历史实施记录 | 记录当时的实现步骤，不作为当前操作手册 |
| [`docs/dsh-comparison-report.md`](dsh-comparison-report.md) | 非规范性研究 | pi-web-chat 与 DeepSeek Harness 的阶段性对比和候选方向 |
| [`docs/images/`](images/) | 文档资产 | README 与仓库文档引用的截图和图片 |

## 兼容与历史文档

- [`README.zh.md`](../README.zh.md) 与 [`README.ko.md`](../README.ko.md) 是兼容性翻译，可能滞后；默认中文 [`README.md`](../README.md) 才是当前用户文档。
- [`HANDOFF.md`](../HANDOFF.md) 是早期交接快照，不是当前启动、发布或安全规则的事实源。执行操作前必须回到 `AGENTS.md`、当前源码与 Workflow 核对。

## 维护规则

- 用户安装、启动、功能或安全边界变化时，更新 `README.md`。
- 每次交付同步 package 版本、lockfile 与 `release-notes.json`；不可通过改写历史版本说明复用版本号。
- 行为、架构、契约、流程或落盘格式的非平凡决定，遵循项目内 skill，并在同一版本分支提交对应 Agent Note。
- 新的视觉资产或图标规则先更新 `docs/iconography.md`；派生或引入第三方资产时同步第三方声明与许可证。
- 历史 spec/plan 保持当时语境，不用事后改写成当前事实；由新的 Agent Note 或权威文档接管变化。
- 不创建第二份总索引；新增文档时在本页登记其读者、用途和权威性。
