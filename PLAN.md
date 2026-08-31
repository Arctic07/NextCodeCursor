# NextCode Cursor 中转站接入方案

> 域名：`https://www.arctictest.com`（NewAPI） Logo：`logo.svg` → `Cursor++/resources/icon.png`
> 中转站源码 `https://github.com/QuantumNous/new-api`

## 1. 目标
- 用户自填 Key（多 Key，多分组），`GET /v1/models` 拉分组可见模型
- 仅白名单模型可添加，大小写不敏感，`Qwen/` 去前缀
- 同名显示 `group/id`（如 `default/gpt-5.6-luna`），否则裸名
- 命中白名单自动填 `上下文/最大输出/识图/思考/max`，不可手改，默认收起
- 无 Key 拦输入，无模型拦保存（≥1），保存后显 Logo + 余额

## 2. 已完成
- `nextcode-models.json` 44 条（`/` 与 `Cursor++/src/server/relay/nextcode-models.json` 同步，只读）
- `Qwen/Qwen3.6-Max-Preview→Qwen3.6-Max-Preview`；`luna/sol/terra` 同 `1.1M/128k/识图`
- `claude-sonnet-4.6/5, opus-5/4.7/4.8` 均 `1M/128k/识图/思考/max`
- 品牌已切 `nextcode/nextcode-cursor/NextCode/@nextcode/ccursor`

## 3. 白名单设计
```ts
// Cursor++/src/server/relay/nextcodeRegistry.ts
normalize(raw)= raw.split('/').pop()!.trim().toLowerCase()
lookup(raw): NextcodeModel | null
isAllowed(raw): boolean
```
- 命中：`id` 剥前缀后小写建 `Map`，`sol/terra` 克隆 `luna`
- 未命中：不显示，不可添加

## 4. 面板流程
```
空状态(Logo+Key输入+Fetch) → 校验Key(401/403拦) → 拉 /v1/models → 白名单过滤 → 列表(仅白名单)
→ 勾选≥1 → 保存(自动填参) → 已存态(Logo+Provider卡+余额+模型收起)
     ↓ 可添多 Key（多 Provider）
```

## 5. 接口
- `GET {baseUrl}/models` `Authorization: Bearer {key}` → `{data:[{id}]}`
- `GET {baseUrl}/api/user/self` 或 `/v1/dashboard/billing/credit_grants` → `quota/used_quota`，失败隐藏

## 6. 文件清单
```
relay.config.json                          // hubUrl 已改
Cursor++/src/server/relay/nextcodeRegistry.ts  // 新
Cursor++/src/ui/panel-provider.ts          // Fetch+过滤+分组去重(id=group/id, apiModel=裸名)
Cursor++/src/ui/webview/app.ts             // Key/数量校验+余额
Cursor++/resources/icon.png                // logo.svg 128/256px
```

## 7. 校验
- Key 必填，`Fetch` 成功才可添模型
- 模型数 ≥1 才可保存；参数来自白名单，不开放编辑

## 8. 风险
- `DisableModelList` 导致 403 → 提示重输 Key
- 新模型需更新 `models.yml` 重生成白名单

## 9. 明日步骤
1. `nextcodeRegistry.ts` 2. `panel-provider` 过滤 3. `app.ts` 门槛+余额 4. `logo` 转 `png` 5. `sync --check && pnpm check-types && lint && compile`
