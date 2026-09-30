# Agent Note: iOS 主屏 Web App 使用原生状态栏和文档布局

Status: implemented

## Problem

用户先报告主屏 App 的顶部标题栏发糊，后又指出多次顶部补偿造成额外距离。去掉 viewport-fit=cover 后仍保留 black-translucent、固定 body、手动安全区和可视视口高度控制；0.1.122 后的真机截图仍出现键盘打开时几乎整页空白。先前的截图分析只能说明显示异常，不能确认其具体系统材质成因，也不能证明去掉 cover 已完成真机修复。

## Decision

页面采用默认系统状态栏：apple-mobile-web-app-status-bar-style 为 default，viewport 仅保留 width=device-width 和 initial-scale=1。不再声明 cover、interactive-widget 或透明状态栏；主页面不通过 top、固定 body 或额外安全区留白定位。

Apple 的[状态栏元数据说明](https://developer.apple.com/library/archive/documentation/AppleApplications/Reference/SafariHTMLRef/Articles/MetaTags.html)规定 default/black 模式的内容显示在状态栏下方，black-translucent 则把内容铺到状态栏后面。这支持选择默认模式，但不代表已经验证当前 iOS 版本的具体渲染表现。

视口模块及临时设置诊断被移除；键盘高度、系统安全区和聚焦滚动交给 WebView。普通文档高度与 flex 布局、标题栏八像素间距和现有字号规则继续保留，详见[移动端布局决定](../bug-fix/2026-09-30-mobile-composer-bounds.md)。文件预览仍是标准的 inset:0 浮层，不再引用应用写入的可视视口高度。

## Alternatives considered

- 只去掉 viewport-fit=cover 仍保留 black-translucent：这两项并不等价于默认状态栏，用户最新真机反馈也没有确认问题解决。
- 给透明状态栏增加 36px 或其他顶部常数：之前已经引入用户指出的额外空白，继续调参会重复同一问题。
- 按 iOS 版本或截图估算系统模糊材质高度：现有证据不足以建立可靠的设备规则，且与用户要求的原生布局所有权相冲突。
- 整体恢复今天之前的布局：历史版本仍有固定 body 和负底部偏移，只回退文件会重新带入旧行为。因此保留无关功能，仅撤销本问题涉及的补偿。

## Consequences

- 应用不再主动把标题栏放到透明状态栏后，也不再把整个页面绑到 visualViewport.height；输入聚焦和键盘引起的视口变化由浏览器处理。
- 默认状态栏与系统安全区可能改变主屏 App 的系统外观或横屏留边，这属于使用原生布局的取舍。
- 删除临时诊断也避免渲染设置菜单时添加隐藏探针和读取布局。
- Chromium 可以验证应用不写入偏移以及常规文档尺寸变化，无法复现真实 iOS 状态栏、键盘或系统聚焦滚动。物理 iPhone Safari/PWA 与 Android 验收仍未验证，不能把此前像素推断或模拟测试描述为真机根因与验收证据。
