# NextCode Cursor 中转站接入方案

> 域名：`https://www.arctictest.com`（NewAPI） Logo：`logo.svg` → `Cursor++/resources/icon.png`
> 中转站源码 `https://github.com/QuantumNous/new-api`

## 1. 目标
- 用户自填 Key（多 Key，多分组），每个 Key 附带**自定义名称**（输入框提示：名称自定义，用于区分不同 Key；留空默认 `默认`）
- `GET /v1/models` 拉分组可见模型
- 白名单**动态拉取**：`GET https://code.arctictest.com/nextcode-models.json`；仅白名单模型可添加，大小写不敏感，`Qwen/` 去前缀；新增/下架模型只改远端 JSON，无需更新插件
- 跨 Key 同 id 模型显示 `名称/模型名称`（如 `工作号/GPT-5.6 Luna`）；仅一个 Key 拥有时显示 `displayName`
- 命中白名单自动填 `上下文/最大输出/识图/思考/max`，不可手改，默认收起
- 无 Key 拦输入，无模型拦保存（≥1），保存后显 Logo + 余额

## 2. 已完成
- 白名单 44 条已上传至 `https://code.arctictest.com/nextcode-models.json`（格式见 §3）；本地 `nextcode-models.json`（根目录与 `Cursor++/src/server/relay/`）待删除
- `Qwen/Qwen3.6-Max-Preview→Qwen3.6-Max-Preview`；`luna/sol/terra` 同 `1.1M/128k/识图`
- `claude-sonnet-4.6/5, opus-5/4.7/4.8` 均 `1M/128k/识图/思考/max`
- 品牌已切 `nextcode/nextcode-cursor/NextCode/@nextcode/ccursor`

## 3. 远端白名单 + 注册表
远端 JSON 条目（paste-1 格式，无鉴权）：
```ts
{ id, displayName, contextTokenLimit, maxOutputTokens, supportsImages, supportsThinking, supportsMaxMode, _sourceId }
```
```ts
// Cursor++/src/server/relay/nextcodeRegistry.ts（URL 常量内置于此 relay 文件）
load(): 拉取远端 JSON → 内存缓存 TTL 10min
normalize(raw) = raw.split('/').pop()!.trim().toLowerCase()
lookup(raw): NextcodeModel | null   // 按 id 小写建 Map
isAllowed(raw): boolean
```
- 未命中：不显示，不可添加
- 拉取失败：报错 + 可重试；有旧缓存则回退旧缓存（提示数据为缓存）
- 匹配：`/v1/models` 返回的 id 剥前缀小写后与远端 `id` 匹配；参数取远端条目

## 4. 面板流程
```
空状态(Logo+Key名称输入+Key输入+Fetch) → 校验Key(401/403拦) → 拉 /v1/models → 白名单过滤 → 列表(仅白名单)
→ 勾选≥1 → 保存(自动填参) → 已存态(Logo+Provider卡[名称+余额]+模型收起)
     ↓ 可添多 Key（多 Provider，各带名称）
```

## 5. 接口
- `GET https://code.arctictest.com/nextcode-models.json` → 白名单数组（扩展宿主 Node fetch，无 CORS 问题）
- `GET {baseUrl}/models` `Authorization: Bearer {key}` → `{data:[{id}]}`
- `GET {baseUrl}/api/user/self` 或 `/v1/dashboard/billing/credit_grants` → `quota/used_quota`，失败隐藏

## 6. 文件清单
```
relay.config.json                              // hubUrl 已改
Cursor++/src/server/relay/nextcodeRegistry.ts  // 远端拉取+TTL缓存+匹配
nextcode-models.json                           // 删（根目录）
Cursor++/src/server/relay/nextcode-models.json // 删
Cursor++/src/ui/panel-provider.ts              // Key名称+Key输入、Fetch+过滤+跨Key去重(显示=名称/displayName, apiModel=裸id)
Cursor++/src/ui/webview/app.ts                 // Key/数量校验+余额
Cursor++/resources/icon.png                    // logo.svg 128/256px
```

## 7. 校验
- Key 必填；Key名称可留空（默认 `默认`），仅用于显示，不参与鉴权
- `Fetch` 成功才可添模型；远端白名单拉取失败时 Fetch 报错重试
- 模型数 ≥1 才可保存；参数来自远端白名单，不开放编辑
- 同 id 多 Key：显示 `名称/displayName`；唯一：`displayName`

## 8. 风险
- `DisableModelList` 导致 403 → 提示重输 Key
- 远端 JSON 不可达/格式非法 → 报错+重试，旧缓存兜底
- 新模型仅改远端 JSON 即生效，无需发版

## 9. 明日步骤
1. `nextcodeRegistry.ts`（远端拉取+TTL 缓存） 2. `panel-provider` Key名称输入+过滤 3. `app.ts` 门槛+余额 4. `logo` 转 `png` 5. 删两处本地 `nextcode-models.json` 6. `sync --check && pnpm check-types && lint && compile`
