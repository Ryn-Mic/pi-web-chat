# 视觉与图标规范

本规范约束 pi-web-chat 新增或修改的 Agent 表情、功能图标、动画与相关可访问性。存量界面采用渐进迁移：触达相关组件时收敛，不为满足规范而一次性重写全部图标。

## 角色分工

### GrokBot：Agent 身份与状态

GrokBot 是 Agent 身份、活动状态和情绪反馈的唯一人格化视觉语言：

- 使用 `src/components/AgentEyes.tsx`、`src/components/AgentIcon.tsx` 和 `src/lib/activity.ts` 的既有映射。
- 适用于 idle、thinking、working、searching、loading、happy、sending、connecting、error、sleeping 等 Agent 状态。
- 只表达 Agent/会话状态、人格化等待反馈和与 Agent 直接相关的空状态，不充当普通导航或按钮图标。
- 表情不能成为状态的唯一载体；必须同时提供可读文本、ARIA 状态或其他不依赖颜色/动画的提示。

GrokBot 表情派生自 [LaoA-GrokBot](https://github.com/zhulin025/LaoA-GrokBot)，来源与 MIT 许可证记录在 [第三方声明](../THIRD_PARTY_NOTICES.md) 中。

### Morphicons：功能图标

[Morphicons](https://github.com/guillermolg00/morphicons) 是动作、导航、切换和反馈图标的统一渲染与动效标准：

- 图形路径按语义命名并集中登记在 `src/lib/morph-icons.ts`。
- React 封装集中在 `src/components/MorphIcons.tsx`、`src/components/RemoteActionIcon.tsx` 等语义组件。
- 业务组件只调用语义组件，不重复定义路径，不新增裸 `<svg>`。
- Morphicons 是图标 morph 动画引擎，不是可任意拼接的图标目录；缺少语义时，应先复用或扩展项目级路径与组件。
- 不引入第二套通用图标库，也不使用 emoji、Unicode 或平台字体符号代替功能图标。

## 新图标接入流程

1. 先确认现有 Morphicon 路径或语义组件是否覆盖目标动作。
2. 缺少语义时，在 `src/lib/morph-icons.ts` 登记可复用路径，并在 `src/components/MorphIcons.tsx` 或同层语义组件中封装。
3. 业务组件使用封装后的组件，并由按钮或控件提供国际化名称。
4. 涉及状态切换时，验证初态、终态、连续 morph 与 reduced-motion 行为。
5. 若必须例外，Agent Note 记录原因、替代方案和重新评估条件。

## 动效与可访问性

- Morphicons 动画统一设置 `reducedMotion="user"`；GrokBot 动作同样遵守用户的 reduced-motion 偏好。
- 纯装饰图标使用 `aria-hidden`，必要时设置 `focusable="false"`。
- 纯图标按钮必须由按钮提供国际化 `aria-label`，并建议同步 `title`；触控区域不得小于项目既有按钮规格。
- 有独立语义的非按钮图标使用组件 `label`，或提供 `role="img"` 与 `aria-label`。
- 错误、成功、等待和选中状态不得只依赖颜色、动画或 GrokBot 表情。

## 明确例外

以下资产不强制使用 Morphicons：

- 由 `scripts/generate-icons.mjs` 生成并在 manifest 中引用的 PWA、favicon、apple-touch 与 maskable 品牌安装资产；
- 用户上传内容、文件缩略图和文件预览内部内容；
- 必须保持原始识别度的第三方品牌 Logo；
- 第三方 viewer 自带且由其运行时控制的图标。

例外资产仍必须保留来源、许可证、替代文本及安全边界。新增或派生第三方资产时，同一版本同步 `THIRD_PARTY_NOTICES.md` 与 `third-party-licenses/`。

## 渐进迁移

- 现有裸 SVG、Unicode 和 emoji 不在本次规范建立时批量替换。
- 修改含存量功能图标的组件时，应在同一范围内迁移到项目级 Morphicons 语义组件；若迁移明显扩大风险，在 Agent Note 中说明保留原因。
- 不因视觉迁移改变业务语义、键盘行为、ARIA 名称或点击区域。

## 检查清单

- 图标属于 GrokBot 状态语言、Morphicons 功能语言或明确例外之一。
- 业务组件没有新增裸 SVG、emoji/Unicode 功能符号或第二套通用图标库。
- Morphicons 路径和语义封装位于统一模块。
- 动画尊重 reduced-motion，图标按钮有国际化可访问名称。
- 状态不只靠颜色、动画或表情传达。
- 第三方来源与许可证已同步登记。
