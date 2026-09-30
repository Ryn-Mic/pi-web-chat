# Agent Note: iOS 26/27 主屏 Web App 顶部系统栏遮挡标题栏

Status: implemented

## Problem

用户把 pi-web-chat 加到主屏幕后（standalone PWA）打开，顶部标题栏（会话列表按钮、Agent 图标、连接徽标、项目名、文件/新建按钮）呈现「像被一层发白蒙版盖住」的样子，且一直如此（非瞬时、与滚动无关）。

对用户提供的真机截图做像素分析后确认这不是「发白」而是**模糊**：

| 区域 | 最暗像素 p1 | 最大梯度 maxgrad | >30 梯度占比 |
| --- | --- | --- | --- |
| 顶部受影响带（约 65–100pt） | 204 | **23.0** | 0.00% |
| 状态栏文字（参考） | 39 | 221.0 | 2.79% |
| 正文（参考） | 30 | 217.0 | 5.60% |

受影响的带区几乎不存在陡峭边缘（maxgrad 23 vs 正文 217），且横向剖面是从 247 平滑过渡到约 193 的平台——这是**大半径模糊 + 提亮**的典型特征，而不是「颜色变浅」。应用代码中不存在任何作用于标题栏的模糊/蒙版/渐变（`grep blur|mask|gradient` 仅命中工具调用行的横向 fade-x、Codex 交互弹层的遮罩、编辑器拖放浮层）。

因此模糊来自系统：iOS 26 起（Liquid Glass）主屏 Web App 的系统状态栏是覆盖在网页内容之上的半透明材质，会对下方的网页内容做模糊与着色。社区已知该回归（WebKit bug 301994「REGRESSION (iOS 26.1): Status bar remains visible in fullscreen mode in Home Screen Web apps」、多篇 iOS 26 PWA 讨论）。用户设备 UA 为 `iPhone OS 18_7 … Version/27.0.1`（Safari 把 OS token 冻结在 18_7 用于反指纹，真实版本看 Version/27）。

本应用按设计让内容钻到状态栏下面（`apple-mobile-web-app-status-bar-style = black-translucent` + `viewport-fit=cover`），并用 `--safe-top` 预留系统栏高度。问题出在 `src/lib/viewport.ts` 的 `SAFE_TOP_MAX = 60`：这个上限是为 44–59px 的旧状态栏写的，iOS 26/27 报出的顶部安全区高于它，被截断后标题栏正好落在系统栏材质下方约 60–100pt 的位置——与截图中被模糊的 65–100pt 完全吻合。

## Decision

1. **放宽顶部安全区上限**：`SAFE_TOP_MAX` 60 → 140。该上限只为防「异常超报」而存在，不应把平台真实上报的高度截断；iOS 26+ 报多少就预留多少，标题栏自然落到系统栏下方。低于 60 的情况行为完全不变（旧设备零影响）。同时保留 iOS standalone 且 `env` 报 0 时的 44/20px 兜底。
2. **加临时真机诊断**：设置菜单底部的版本行追加 `top=… env=… screen=… inner=… vv=… standalone|browser`（`viewportDiagnostics()`）。原因是「env 报 60 但系统栏实际约 100」与「env 报 100 但被我们截断到 60」两种假设会得到相同的截图，只有真机上的数字能区分；若放宽上限后仍然模糊，就按该数字决定是否需要在 iOS standalone 下额外增加固定间隙。诊断代码会在确认后删除。

## Alternatives considered

- **把 `apple-mobile-web-app-status-bar-style` 改成 `default`（不透明状态栏）** — 让系统预留状态栏、网页不再钻到下面，理论上也能消除遮挡；但它会同时改掉沉浸式外观，并让 `env(safe-area-inset-top)` 变为 0，从而触发我们自己的 44px 兜底，导致顶部出现一段无意义的空白（需要再删兜底逻辑）。在只能靠用户真机验证的前提下，这个改动面更大、回归更难判断，先不做，保留为备选。
- **在 iOS standalone 下直接加一个固定额外间隙（例如 +40px）** — 不依赖 env，理论上能压过任何系统栏高度；但这是在不知道系统栏真实高度的前提下硬编码魔数，且会让非 Liquid Glass 设备（iOS 18）白白多出一段空白。否决，先由放宽上限 + 真机诊断定位真实数值。
- **把顶部栏背景做成不透明** — 系统材质模糊的是「材质下方的像素」，标题栏图标文字仍在其下方，仍会被模糊；不解决图标发虚的问题，否决。
- **等 Apple 修复 WebKit 回归** — 该回归自 iOS 26.1 起已存在多个月，且用户每天在用主屏 App，不能等。否决。

## Consequences

- iOS 26/27 主屏 App 的标题栏预计不再被系统栏模糊；旧设备（env ≤ 60）行为不变。
- 若某些设备异常上报极大的顶部 inset（> 140），仍会被截断到 140；这是刻意的防呆上限。
- 设置菜单底部短期内会显示一行诊断信息（含 `screen`/`inner` 等），确认间距后移除；这属于临时诊断，不是产品功能。
- 本轮无法在本地真机复现（Xcode 26 的 Simulator/DeviceHub 未提供可自动化窗口，也没有 iOS 真机），最终验收依赖用户在自己的主屏 App 上确认。
