# NextCodeCursor — 中转站定制与上游同步指南

本 fork 已做成“核心零侵入”的中转站叠加层：中转配置全部隔离在 `relay.config.json` + `src/server/relay/*`，`git merge upstream/main` 时由 `.gitattributes merge=ours` 自动保护，不会与上游核心逻辑冲突。

## 目录结构

```
relay.config.json                        # 唯一配置源（改这里）
Cursor++/src/server/relay/branding.ts    # 由脚本生成，请勿手改
Cursor++/src/server/relay/preset.ts      # 由脚本生成，请勿手改
installer/src/relay/branding.js          # 由脚本生成，请勿手改
installer/src/relay/preset.js            # 由脚本生成，请勿手改
Cursor++/scripts/sync-relay.mjs           # 同步脚本（JSON → 上述 4 文件 + package.json）
Cursor++/src/server/config/providersStore.ts  # 合并 RELAY_PROVIDERS 作为种子（不覆盖用户已有配置）
Cursor++/src/server/config/routesStore.ts     # 合并 RELAY_EXTRA_REDIRECT 到白名单（BYOK=on 时追加）
installer/src/release-defaults.js             # install 时同理合并 relay 预设
Cursor++/esbuild.js                      # HUB_URL 注入改为读 relay.config.json
Cursor++/src/update-check.ts             # 更新检查改为读 relay/ branding
.github/workflows/sync-upstream.yml      # 定时自动合上游并发 PR
.github/workflows/relay-check.yml        # PR/push 时校验 relay 同步 + tsc
.gitattributes                           # 锁定品牌/叠加层文件为 merge=ours
```

## 一次性初始化（已完成）

```bash
git remote add upstream https://github.com/CometixSpace/CCursor.git
git fetch upstream
git config merge.ours.driver true   # 启用 .gitattributes 的 merge=ours
```

若换机器克隆后，需再执行一次 `git config merge.ours.driver true`（该配置是本地的，不随仓库提交）。

## 如何定制你的中转站

1. 编辑 `relay.config.json`：
   ```json
   {
     "branding": {
       "publisher": "your-publisher",
       "name": "your-extension-name",
       "displayName": "Your Display Name",
       "hubUrl": "https://your-hub.example.com",
       "npmPackage": "@your-scope/your-pkg",
       "updateCommand": "npx @your-scope/your-pkg update"
     },
     "providers": [
       {
         "_enabled": true,
         "id": "my-relay",
         "name": "MyRelay",
         "type": "openai-chat",
         "baseUrl": "https://api.your-relay.com/v1",
         "auth": { "kind": "apiKey", "value": "" },
         "models": [
           { "id": "gpt-4o", "apiModel": "gpt-4o", "displayName": "GPT-4o", "thinking": false, "defaultOn": true, "contextTokenLimit": 128000, "maxOutputTokens": 16384 }
         ]
       }
     ],
     "extraRedirect": []
   }
   ```
   - `providers` 里 `_enabled: true` 才会生效，默认示例是 `_enabled: false` 不会写入。
   - `type` 选 `openai-chat` 最通用（兼容所有 openai-compatible 网关），如需思考/特定行为可选 `anthropic` / `openai-responses` / `gemini`。
   - `extraRedirect` 仅在需要劫持额外 gRPC/REST 路径时填写。

2. 同步生成文件：
   ```bash
   node Cursor++/scripts/sync-relay.mjs
   cat Cursor++/src/server/relay/preset.ts  # 确认写入
   ```

3. 本地验证并构建：
   ```bash
   pnpm -C Cursor++ check-types
   pnpm -C Cursor++ compile          # 或 node Cursor++/esbuild.js
   pnpm -C Cursor++ vsix             # 打 vsix 包
   pnpm -C Cursor++ test:server      # 可选
   cd installer && npm run build     # 重新打包 installer/dist/cli.cjs
   ```

4. 提交：
   ```bash
   git add relay.config.json Cursor++/src/server/relay/ installer/src/relay/ Cursor++/package.json
   git commit -m "feat(relay): configure MyRelay preset"
   git push origin main
   ```

## 如何同步上游核心功能

### 自动（推荐）

- 仓库已配置 `.github/workflows/sync-upstream.yml`：每天 02:00 UTC 自动 `git merge upstream/main`。
- 成功：自动推分支 + 提 PR，CI 通过后直接合并。
- 冲突：提 draft PR 并在日志里提示冲突文件，本地解决后推即可。
- 所有中转配置受 `.gitattributes merge=ours` 保护，自动合并不会覆盖你的 `relay.config.json`。

### 手动

```bash
git fetch upstream
git checkout main
git pull origin main
git merge upstream/main --no-edit
# 若提示冲突，通常只会在 Cursor++/src/server/data/defaults.ts 等核心文件
# 按上游新逻辑解决冲突后：

node Cursor++/scripts/sync-relay.mjs --check   # 确认 relay 未漂移
pnpm -C Cursor++ check-types && pnpm -C Cursor++ test:server
git add -A && git commit   # 若无冲突，此步已在 merge 时完成
git push origin main
```

### 上游白名单/兜底变更时

- `Cursor++/src/server/data/defaults.ts` 与 `installer/src/defaults.js` 必须保持一致（文件头有注释提醒）。
- 上游改了 `BYOK_REDIRECT` / `DEFAULT_PROVIDERS` / `DEFAULT_ROUTES` 后，手动同步的改动会自动通过 merge 带入；只需确认 `routesStore.ts` 的 `RELAY_EXTRA_REDIRECT` 追加逻辑未被冲突覆盖即可。

## 常见问题

**Q: 我想完全改名发布到商店？**
改 `relay.config.json` 的 `branding.publisher/name/displayName` 后跑 sync，`Cursor++/package.json` 会同步变更。首次发布前记得改 `Cursor++/src/resources/icon.png` 和 `CHANGELOG`，并申请新的 publisher。

**Q: 用户已有的 `~/.ccursor/providers.json` 会被覆盖吗？**
不会。`RELAY_PROVIDERS` 仅在 `providers.json` 不存在时作为“种子”写入；已存在的文件走 `withFallback` 不覆盖。`routes.json` 则是 `install` 时强制覆盖（携带 relay 白名单），运行时 `toggleByokMode` 也会重算白名单（已带 `RELAY_EXTRA_REDIRECT`）。

**Q: 换电脑后 `.gitattributes` 不生效？**
执行 `git config merge.ours.driver true` 即可。仓库级 `.git/config` 不会被提交，需每台机器执行一次。

**Q: CI 报 `relay.config.json out of date`？**
执行 `node Cursor++/scripts/sync-relay.mjs` 后提交即可。
