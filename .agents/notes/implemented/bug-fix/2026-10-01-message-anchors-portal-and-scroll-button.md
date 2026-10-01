# Agent Note: 修复向下滚动按钮穿透显示在用户消息弹窗上的问题

Status: implemented

## Problem

当用户点击输入栏右侧的「历史用户消息（MessageAnchors）」按钮打开跳转列表弹窗时，浮动在聊天容器中央的「向下滚动按钮」会直接出现在该弹窗上方，造成视觉杂乱并遮挡用户点击历史消息：

1. **Containing Block 与 Stacking Context 陷阱**：Composer 外层容器使用了 `backdrop-blur-md`（`backdrop-filter`），根据 W3C 渲染规范，`backdrop-filter` 强制为其后代创建全新的包含块（Containing Block）和层叠上下文。`MessageAnchors` 弹窗原先以内联方式直接挂载在 `Composer` 内部，其 `fixed` 定位与 `z-40` 无法逃逸出 Composer 的层叠上下文，因此其渲染层级被位于 Composer 上方的兄弟容器 `MessageList` 及其向下滚动按钮盖住。
2. **缺乏弹窗打开状态联动**：当用户打开消息历史定位浮层时，页面焦点应当完全置于浮层之内，此时页面底部的向下滚动快捷按钮未做避让，仍在页面中央显示。

## Decision

1. **浮层传送至 document.body 顶层**：
   - 在 `src/components/MessageAnchors.tsx` 中使用 `createPortal(..., document.body)` 渲染整个遮罩与弹窗面板；
   - 浮层 z-index 提升至 `z-50`，彻底摆脱 Composer 局部层叠上下文的限制，确保弹窗天然覆盖在所有页面内容最上方；
   - 弹窗面板增加深色模式半透明微光边框（`dark:border dark:border-white/[0.08]`），与全站卡片质感统一。
2. **弹窗开启状态双重联动隐藏按钮**：
   - 在 `src/lib/drawer.ts` 中维护 `modalOverlayOpen` 状态与 `setModalOverlayOpen` 方法；
   - `MessageAnchors` 组件在 `open` 为 true 时同步调用 `setModalOverlayOpen(true)`，使 `useAnyDrawerOpen()` 返回 true；
   - `ChatPage.tsx` 将联动后的 `isAnySidebarOpen`（包含模态浮层）传入 `MessageList` 的 `hideScrollButton`，在弹窗打开期间瞬间隐藏向下滚动按钮，从根源杜绝遮挡。

## Alternatives considered

- **仅提高 MessageAnchors 的 z-index 并在局部微调定位** — 否决：在 CSS 规范中，只要父元素存在 `backdrop-filter`，子元素的 `z-index` 再大也无法突破父级的 Stacking Context，无法根本解决被兄弟元素穿透的问题。
- **让用户手动关闭滚动按钮或仅调小尺寸** — 否决：用户体验割裂，模态浮层弹出时隐藏非相关浮动控件是标准的人机交互规范。

## Consequences

- **收益**：打开用户消息跳转浮层时，界面纯净通透，向下滚动按钮完全隐藏，弹窗位于屏幕顶层，不再发生穿透或点击被遮挡；
- **后续约束**：若后续新增自定义全局 Modal 浮层（未通过 base-ui Dialog 托管的裸浮层），需同样通过 `createPortal` 挂载并在打开时通知 `setModalOverlayOpen`。
