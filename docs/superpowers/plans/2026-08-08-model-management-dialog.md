# 模型管理弹窗实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在不改变模型配置数据流的前提下，将模型管理弹窗重排为清晰、响应式、符合项目暖色主题的编辑工作台。

**架构：** 保留 `ModelsDialog`、`ProviderCard` 和 `ModelRow` 的现有数据职责，仅调整 JSX 层级与 Tailwind token 类。弹窗使用固定标题/滚动主体/固定底栏，提供方和模型采用嵌套卡片，所有交互回调与 API 调用保持不变。

**技术栈：** React 19、TypeScript、`@base-ui-components/react/dialog`、Tailwind CSS v4、现有 i18n token。

---

### 任务 1：重塑模型管理弹窗层级

**文件：**
- 修改：`src/components/ModelsDialog.tsx`（`ModelsDialog`、`ProviderCard`、`ModelRow`）
- 修改：`src/i18n/en.ts`、`src/i18n/zh.ts`、`src/i18n/ja.ts`、`src/i18n/ko.ts`（若关闭按钮需要独立文案）

- [ ] **步骤 1：确认现有数据回调不变**

保留 `draft`、`save`、`close`、`patch`、`onChange` 和 `onRemove` 的签名；只替换容器与字段的 className/静态结构。

- [ ] **步骤 2：实现弹窗头部、主体和底栏**

将 Popup 调整为 `max-h-[88vh] w-[min(94vw,52rem)]`，使用标题图标、标题、配置路径、关闭按钮；主体继续 `thin-scroll flex-1 overflow-y-auto`；底栏保持固定并保留保存状态、取消和保存按钮。

- [ ] **步骤 3：实现提供方卡片视觉层级**

提供方头部展示 server 图标、key、API 类型徽标和删除图标；连接字段使用 `grid gap-2 sm:grid-cols-2`；模型列表使用嵌套区域和次级添加按钮。

- [ ] **步骤 4：实现模型子卡片视觉层级**

模型头部展示序号圆标、模型 ID/显示名输入和删除按钮；规格字段使用响应式网格；推理/图片输入使用带边框的能力开关；thinking 等级保持原有 checkbox 逻辑，只改善胶囊样式。

- [ ] **步骤 5：实现空态和添加操作**

空 provider 使用轻量空态容器；添加 provider 使用全宽虚线次级按钮，添加 model 保持卡片内部次级按钮，避免与主保存按钮竞争。

### 任务 2：验证弹窗构建与主题兼容

**文件：**
- 测试：`src/components/ModelsDialog.tsx`、四份 locale 文件

- [ ] **步骤 1：运行类型检查**

运行 `npm run typecheck`；预期输出成功且没有 JSX、i18n 类型错误。

- [ ] **步骤 2：运行样式静态检查**

运行 `git diff --check`，并检查 Popup 的 `max-h`、滚动主体、`sm:grid-cols-2`、`dark` token 类和 icon button 的 `aria-label` 均存在。

- [ ] **步骤 3：运行生产构建**

运行 `npm run build`；预期 Vite 与 esbuild 均完成，输出 `dist/index.js + dist/public/`。
