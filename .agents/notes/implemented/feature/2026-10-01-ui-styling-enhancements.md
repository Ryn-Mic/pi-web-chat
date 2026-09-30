# Agent Note: UI 样式排版优化与项目新建会话选项

Status: implemented

## Problem

pi-web-chat 在日常使用中存在两类关键体验瓶颈：

1. **视觉层次与排版色彩割裂**：
   - 深色模式下底板（`#262624`）与卡片/浮层（`#30302e`）色差不足 5%，常规阴影在暗色下失效，卡片与浮层边界模糊；
   - 内联代码（inline code）硬编码为荧光天蓝（`#62aeee`），在浅色 Warm Ivory 象牙白背景下与暖色调严重撞色；
   - 思考过程（Thinking）与工具卡片（ToolCallCard）结构过于扁平，缺乏状态指示与呼吸感；
   - 会话列表选中项缺乏鲜明的视觉指示条；
   - 文件树面板仍残留 Nerd Font Unicode 字符（`\uf016`、`\uf114`），缺乏统一矢量封装与层级垂直对齐参考线；Header 含有存量裸 `<svg>`；
   - 滚动到底部按钮原本置于右下角，带有长文字且在侧边栏或抽屉打开时容易造成视觉重叠与遮挡。
2. **新建会话丢失当前项目上下文**：
   - 顶部 Header 右上角的新建会话按钮固定调用 `chatClient.connect(null, ...)`，未传递 `cwd` 参数；
   - 当用户已处于某个工作区项目（如 `pi-web-chat`）时，点击右上角新建按钮会导致会话直接落入默认目录（`~/.pi/web-chat`），丢失当前项目的文件树与 Git 上下文，迫使去侧边栏重新定位。

## Decision

1. **右上角新建会话支持项目上下文与快捷菜单**：
   - 封装 `NewSessionButton` 组件：通过 `snapshot?.cwd` 与 `projectLabel` 判定当前是否已打开具体项目；
   - 未在项目中时保持一键直达，直接新建全局会话；
   - 已处于具体项目中时，基于 `@base-ui-components/react/menu` 提供轻量级浮层选项：
     - 首项（高亮推荐）：在当前项目新建会话，并附带项目名称胶囊，保留 `cwd: snapshot.cwd`；
     - 次项：新建全局独立会话，显式清空 `cwd`。
   - 补齐中、英、日、韩四国语言的 `newSessionDefault` 本地化文案。
2. **深色立体感与浮层微光边框**：
   - 全局弹窗与命令面板（`DIALOG_POPUP_CLASS`、`PALETTE_POPUP_CLASS`）增加 `dark:border-white/[0.08]` 与 `dark:shadow-2xl`；
   - 顶部 Header 与底部 Composer 容器升级为 `backdrop-blur-md bg-canvas/85~90`，长内容滚动与边缘更加平滑；
   - 输入面板卡片增加 `dark:border-white/[0.09]` 与深色发光阴影 `dark:shadow-[0_4px_24px_rgba(0,0,0,0.4)]`；
   - 用户消息气泡增加暗色细微轮廓 `dark:border dark:border-white/[0.06]`。
3. **内联代码与卡片状态着色调和**：
   - 移除内联代码的强制 `#62aeee` 蓝色，改为浅色模式下贴合主题的陶土橙微底（`color-mix(in srgb, var(--c-accent) 10%, transparent)`）配合深色文字，深色模式下采用淡暖色（`#e5987d`），融入全局 Warm Ivory 基调；
   - 代码块增加浅色弱边框与深色微光边框（`dark:border-white/[0.08]`）；
   - 思考块（Thinking）增加微光呼吸指示点与陶土橙半透明导引线（`border-accent/25`）；
   - 工具调用卡片（ToolCallCard）增加运行中琥珀微黄边框与失败淡红警示背景；
   - 会话抽屉列表为激活会话增加左侧 2px 陶土橙指示条（`border-accent`）。
4. **文件树视觉规范收敛与层级导引**：
   - 彻底淘汰 `FileTreePanel.tsx` 中的 Nerd Font Unicode 字符（`\uf016`、`\uf114`），在 `MorphIcons` 中新增可复用的 `FileItemIcon`（基于 24x24 矢量路径）并复用 `FolderTreeIcon`；
   - 为文件树展开目录增加左侧极细垂直缩进参考线（Indent Guides），精准对齐父级展开图标，深层嵌套目录浏览体验更清晰；
   - 将 Header 中的文件抽屉切换按钮从裸 `<svg>` 迁移为平滑展开/闭合的 `FolderTreeIcon`；
   - 空状态引导卡片（`EmptyStateHero`）增加轻微悬浮位移与深色质感层级（`hover:-translate-y-0.5 hover:shadow-xs`）。
5. **滚动到底部交互精简与避让**：
   - 按钮位置调整为底部水平居中（`left-1/2 -translate-x-1/2`），去除多余文案，改为纯圆形胶囊图标按钮；
   - 使用 Morphicons `NavigationActionIcon direction="down"` 矢量标准图标；生成中在右上角保留精致脉冲指示点；
   - 联动所有侧边栏状态（会话侧边栏、文件工作区侧边栏、移动端会话与文件抽屉）：只要任意侧边栏打开，按钮自动隐藏，杜绝遮挡与注意力分散。

## Alternatives considered

- **全量重构 UI 采用第三方重型组件库** — 否决：破坏既有的轻量极简风格与严格的包体积门禁（`scripts/check-pack-size.mjs`），且无法复用已有的 GrokBot 与 Morphicons 视觉标准。
- **右上角点击直接强制在当前项目下新建而不给选项** — 否决：部分用户有在当前页面临时开一个无绑定的 scratchpad 独立会话的需求，采用 2 项轻量 Menu 既满足“当前项目下新建”的核心诉求，又保障了“或者给个选项”的灵活度。
- **使用复杂的右键菜单或长按手势** — 否决：移动端与桌面端体验不一致，学习成本与发现成本过高。

## Consequences

- **收益**：深色模式下界面层次与组件纵深感显著增强；浅色阅读下的内联代码告别刺眼撞色；处于项目目录时无需多余操作即可在当前项目下连贯新建会话，大幅提升开发连续性；文件树与顶栏完全遵循 `docs/iconography.md` 图标规范，消除对宿主字体符号的隐式依赖，树形结构对齐与引导感明显提升；滚动到底部按钮精简居中且避让侧边栏，操作干净专注。
- **代价与后续维护**：新增了 `NewSessionButton` 及其在 4 种语言下的翻译条目；后续若调整项目路径解析逻辑需同步维护 `projectLabel` 与 `NewSessionButton`。
