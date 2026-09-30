# Agent Note: iOS 26/27 主屏 Web App 不再把内容铺到状态栏下

Status: implemented

## Problem

用户把 pi-web-chat 加到主屏幕（standalone PWA）后，顶部标题栏呈现「像被一层发白蒙版盖住」的样子，且一直如此（非瞬时、与滚动无关）。

对真机截图做像素分析后确认这是**模糊**而不是「发白」：

| 区域 | 最暗像素 p1 | 最大梯度 maxgrad | >30 梯度占比 |
| --- | --- | --- | --- |
| 顶部受影响带（约 65–100pt） | 204 | **23.0** | 0.00% |
| 状态栏文字（参考） | 39 | 221.0 | 2.79% |
| 正文（参考） | 30 | 217.0 | 5.60% |

受影响带几乎没有陡峭边缘（maxgrad 23 vs 正文 217），横向剖面是从 247 平滑过渡到约 193 的平台——典型的大半径模糊 + 提亮。应用代码里没有任何作用于标题栏的模糊/蒙版/渐变（`blur|mask|gradient` 只命中工具调用行的横向 fade-x、Codex 弹层遮罩、编辑器拖放浮层）。

原因是平台行为：本应用按 `viewport-fit=cover` + `apple-mobile-web-app-status-bar-style: black-translucent` 把网页铺到状态栏下面，而 iOS 26 起（Liquid Glass）主屏 Web App 的状态栏是一层**半透明材质**盖在网页之上，会把下方的像素糊掉。也就是说：只要标题栏落在材质下面，它就会被模糊——这与社区记录一致（WebKit bug 301994「REGRESSION (iOS 26.1): Status bar remains visible in fullscreen mode in Home Screen Web apps」，以及若干 iOS 26 PWA 讨论）。

## Decision

**去掉 `viewport-fit=cover`，让 iOS 把 App 排在状态栏下方，从根上去掉「内容位于材质之下」这个前提。**

- `index.html` 的 viewport meta 不再声明 `viewport-fit=cover`。
- `src/lib/viewport.ts` 相应删掉所有「顶部预留」逻辑：`STANDALONE_SAFE_TOP_FALLBACK`(44/20)、0.1.117 引入的 `IOS_STATUS_MATERIAL_EXTRA`(36) 与 `safariMajorVersion()`。这些补偿只在 cover 模式下才有意义；不铺到状态栏下之后，`env(safe-area-inset-top)` 就是 0，再补一段就是凭空的空白。
- 保留底部兜底（`STANDALONE_SAFE_BOTTOM_FALLBACK = 34`）：不铺 cover 时 `env(safe-area-inset-bottom)` 同样归 0，而视图仍延伸到 home indicator 之下，输入框需要这 34px。
- 状态栏那条带由系统用页面的 `theme-color`/背景（#faf9f5）着色，与本应用画布同色，视觉上是连续的，不会出现异色条。
- `SAFE_TOP_MAX` 保留（仅作「异常超报」的保护）。

依据：`dispatch` 项目的 ios-pwa-viewport-findings（2026-09-15 结案）用真机读数给出同一结论——cover 模式下 `inner 873 = screen 932 − 59`、`safe-t 59`，而改成不铺 cover 后 `safe-t 0`、`fixed; top: 0` 落在时钟正下方；他们的同类 bug 由此关闭。

## Alternatives considered

- **保留 cover，把标题栏往下挪出材质（0.1.117 的做法：`env + 36px`）** — 实测确实能让标题栏不再发糊，但只是把内容移出模糊区，没有消除模糊本身；代价是状态栏与标题栏之间多出一段空白，用户明确指出这是偷懒的规避而不是修复。改为根因修复后放弃。
- **保留 cover，把 `apple-mobile-web-app-status-bar-style` 改成 `default`（不透明状态栏）** — 不透明状态栏不会模糊下方像素，理论上也能让标题栏变清晰，且保留沉浸式布局。但需要确认 iOS 26 是否真的按 opaque 处理（未验证），并且仍要处理「env 变 0 后的兜底逻辑」这一整套补偿；在无法真机验证的前提下比去掉 cover 更难判断。保留为备选。
- **把顶部栏背景做成不透明** — 材质模糊的是「材质下方的像素」，标题栏的图标文字仍在其下方，仍会发虚；不解决问题，否决。
- **继续加固定魔数（例如顶部硬留 100px）** — 不依赖平台语义，能压过任何材质高度，但会在没有材质的设备（iOS 18）上留下大段空白，且永远要跟着系统版本调参；否决。
- **等 Apple 修复 WebKit 回归** — 该回归自 iOS 26.1 起已存在数月，用户每天使用主屏 App，不能等。否决。

## Consequences

- 主屏 App 的标题栏不再被系统材质模糊；同时不再需要任何顶部预留，之前那段 36px 的空白一并消失。
- App 的布局视口从状态栏下方开始：状态栏那条带由系统按页面底色着色，与被应用画布一致。
- 不使用 `viewport-fit=cover` 的副作用：iOS 在横屏时会留出安全区黑边（不再铺满）。本应用以竖屏为主，接受该代价；这是与「顶部不铺到状态栏下」绑定的取舍。
- iOS 18 及更早、以及浏览器标签页行为不变（标签页本来就有浏览器自己的 chrome）。
- 设置菜单底部的临时诊断行（`top=/env=/screen=/inner=/vv=/standalone|browser`）保留最后一轮，用于真机确认 `env=0 / top=0`；确认后删除。
- 本轮仍无法在本地真机复现（Xcode 26 的 Device Hub 窗口位于副屏、ScreenCaptureKit 抓取失败，驱动拒绝派发像素点击；Library/WebClips 注入也不被 iOS 26 采纳），最终验收依赖用户主屏 App。
