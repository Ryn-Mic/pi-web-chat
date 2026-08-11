# API 密钥掩码显示设计（2026-08-11）

## 目标

Web 端模型管理（ModelsDialog）不再暴露完整 API 密钥：

- 后端 `GET /api/custom-models` 返回时对 `apiKey` 掩码：保留前 4 与后 4 个字符，中间以 `…` 代替。
- 前端以普通文本（非 password 字段）展示掩码值。

## 决策（用户确认的默认值）

- `$ENV_VAR` 引用（如 `$OPENAI_API_KEY`）**不掩码**——它只是引用而非密钥，掩码后无法解析。
- 长度 ≤ 8 的短密钥**整段掩码**为 `••••••••`——前 4 后 4 规则会重叠泄露。

## 掩码规则（`maskApiKey`）

| 输入 | 输出 |
|------|------|
| 空 / 未定义 | `undefined` |
| `$` 开头 | 原样 |
| 长度 > 8 | `前4 + "…" + 后4`（如 `sk-1…wxyz`） |
| 长度 ≤ 8 | `••••••••` |

## 关键链路与防覆盖设计

掩码值必须能安全往返：保存时不能被写回 models.json，运行时重载与模型发现必须用真 key。

1. **读**：`readCustomModels()` 的 `apiKey` 字段返回 `maskApiKey()` 结果。
2. **保存**（`writeCustomModels`）：对每个 provider，入参 `apiKey === mask(存储真值)` 时**保留存储真值**；否则视为新输入按原逻辑写入；空则删除。函数改为返回解析后的 providers（含真 key）。
3. **运行时重载**：PUT handler 用 `writeCustomModels` 返回的解析后 providers 调 `reloadModelProviders`，保证注册进运行时的是真 key。
4. **模型发现**：`POST /api/custom-models/discover` 请求体增加可选 `key`（provider key，向后兼容）。服务端 `resolveIncomingApiKey(key, incoming)`：incoming 与存储值掩码相等时还原为存储真值，再走原有 `resolveDiscoveryApiKey`（`$ENV_VAR` 解析）。

## 前端改动

- `ModelsDialog.tsx`：apiKey 输入框 `type="text"`；删除 `showApiKey` state、眼睛切换按钮与 `EyeIcon` 组件。
- discover 调用携带 `key: provider.key`。
- i18n（en/ja/ko/zh）：删除 `showApiKey`/`hideApiKey` 条目；`apiKeyHint` 补充"已保存的密钥仅显示前后 4 位"。
- `shared/protocol.ts`：`UIModelDiscoveryRequest` 增加可选 `key` 字段。

## 边界情况

- 两个 provider 掩码值相同（同前 4 后 4）：保存按 key 逐个比对，无歧义；发现按 `key` 查找，无歧义。
- 用户输入一个恰好等于旧掩码形式的新 key：视为未修改（可接受，概率极低且语义一致）。
- 首次保存新 provider（无存储值）：掩码比对不命中，按新值写入。

## 验证

- 无相关单元测试（现有测试覆盖 chat-client/session-workspace），人工验证：
  - GET 返回掩码值；保存后 models.json 真 key 未被掩码覆盖；重载后运行时用真 key；
  - discover 用掩码值可还原真 key 拉取模型；`$ENV_VAR` 正常解析；前端展示为普通文本。
