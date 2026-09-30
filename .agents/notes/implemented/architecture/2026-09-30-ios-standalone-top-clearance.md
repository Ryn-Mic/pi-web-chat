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

受影响的带区几乎不存在陡峭边缘（maxgrad 23 vs 正文 217），横向剖面是从 247 平滑过渡到约 193 的平台——这是**大半径模糊 + 提亮**的典型特征，而不是「颜色变浅」。应用代码中不存在任何作用于标题栏的模糊/蒙版/渐变（`grep blur|mask|gradient` 仅命中工具调用行的横向 fade-x、Codex 交互弹层的遮罩、编辑器拖放浮层）。

因此模糊来自系统：iOS 26 起（Liquid Glass）主屏 Web App 的系统状态栏是覆盖在网页内容之上的半透明材质，会对下方内容做模糊与着色（社区已知：WebKit bug 301994「REGRESSION (iOS 26.1): Status bar remains visible in fullscreen mode in Home Screen Web apps」，以及多篇 iOS 26 PWA 讨论）。用户设备 UA 为 `iPhone OS 18_7 … Version/27.0.1`（Safari 把 OS token 冻结在 18_7 反指纹，真实版本看 `Version/`）。

本应用按设计让内容钻到状态栏下面（`apple-mobile-web-app-status-bar-style = black-translucent` + `viewport-fit=cover`），并用 `--safe-top` 预留系统栏高度。`src/lib/viewport.ts` 的 `SAFE_TOP_MAX = 60` 上限是为 44–59px 的旧状态栏写的，iOS 26/27 报出 68 时被截断成 60。

## Decision

两个环节，按实测顺序落地：

1. **不再截断平台上报的顶部安全区**：`SAFE_TOP_MAX` 60 → 140。该上限只为防「异常超报」存在，不应把平台真实值砍掉；低于 60 的设备行为完全不变。保留 iOS standalone 且 `env` 报 0 时的 44/20px 兜底。
2. **iOS 26+ standalone 额外预留 `IOS_STATUS_MATERIAL_EXTRA = 36px`**：0.1.116 上线后用户回读诊断行 `top=68px env=68 screen=912 inner=844 vv=844 standalone`——即 env 诚实上报了 68，我们也照用了 68，但标题栏（page y 72–108）仍在系统材质里发糊，说明材质覆盖范围大于它上报的 inset（截图里模糊带下沿约 100）。因此在 iOS standalone 且 `Version/ ≥ 26`（iOS 26 起 Safari 版本与系统同号，是唯一诚实的代际信号）时，`--safe-top = 上报值 + 36`，本机即为 104，标题栏落到 108 以下。

诊断行（设置菜单底部 `top=/env=/screen=/inner=/vv=/standalone|browser`）暂留，用于确认第 2 步的数值；确认后删除。

## Alternatives considered

- **把 `apple-mobile-web-app-status-bar-style` 改成 `default`（不透明状态栏）** — 让系统预留状态栏、网页不再钻到下面；理论可行，但它同时改掉沉浸式外观，并让 `env(safe-area-inset-top)` 变为 0 从而触发我们自己的 44px 兜底（需再删兜底逻辑），改动面更大且同样只能靠用户真机验证。保留为备选。
- **从 viewport meta 去掉 `viewport-fit=cover`** — 这是社区里被验证过的同类修复（`dispatch` 项目 2026-09-15 的 ios-pwa-viewport-findings：去掉 cover 后 iOS 把安装版 App 排在状态栏下方，`safe-t` 变为 0、`fixed; top:0` 落在时钟下方）。但同一份记录显示去掉 cover 后 `safe-b` 也变 0、布局一直铺到「玻璃底部」；本应用底部是输入框，`env(safe-area-inset-bottom)` 一旦归零，需要另找 home indicator 的补偿，属于把顶部问题换成底部问题。本轮不采用，若第 2 步仍不奏效再启用。
- **在 iOS standalone 下直接硬编码一个更大的固定间隙（如 100px 起）** — 不依赖 env，能压过任何材质高度，但会让 iOS 18 等无材质设备白白多出一大段空白；改用「上报值 + 固定增量 + 版本门控」把影响限制在 Liquid Glass 代际。否决纯硬编码。
- **把顶部栏背景做成不透明** — 材质模糊的是「材质下方的像素」，标题栏图标文字仍在其下方，仍会发虚；不解决图标模糊，否决。
- **等 Apple 修复 WebKit 回归** — 该回归自 iOS 26.1 起已存在数月，且用户每天在用主屏 App，不能等。否决。

## Consequences

- iOS 26/27 主屏 App 的标题栏预计落在系统材质下方，不再发糊；顶部栏比之前高约 36px（以一段画布色空白呈现，不会露出被模糊的内容）。
- 旧设备（`env ≤ 60`、`Version/ < 26`）行为完全不变。
- 依赖 `Version/` 识别代际：若某个 iOS 26+ 的 standalone UA 不带 `Version/`，增量不会生效（退回当前现状，不会更差）。
- 设置菜单底部短期内显示一行诊断信息（含 `screen`/`inner` 等），确认后移除；这是临时诊断，不是产品功能。
- 本轮无法在本地真机复现（Xcode 26 的 Simulator/DeviceHub 未提供可自动化窗口，也没有 iOS 真机），每一轮都必须由用户在手机主屏 App 上验收。
