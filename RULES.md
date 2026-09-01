# AGENTS.md — NextCodeCursor 中转站工作规范

> 本文件是所有 AI 助手（Codex / Claude Code / Cursor / Gemini CLI / Copilot / 通用 Agent）的统一入口。**执行任何代码任务前必须全文阅读。**

## 1. 项目定位

- 本仓库 `NextCodeCursor` 是 `CometixSpace/CCursor` 的 fork，目标是构建**自有中转站专用**的 Cursor++ BYOK 插件。
- 技术栈：`Cursor++` 扩展（TypeScript + esbuild + Hono/Fastify + VS Code Extension Host） + `installer`（Node.js CLI + acorn AST patch）。
- 上游：`https://github.com/CometixSpace/CCursor`，分支 `main`，已配置 `git remote upstream`。
- 本地已执行 `git config merge.ours.driver true`，依赖 `.gitattributes` 的 `merge=ours` 策略保护中转配置。

## 2. 黄金架构 — Relay 叠加层（不可破坏）

核心原则：**中转定制零侵入上游核心。上游合并 (`git merge upstream/main`) 必须零冲突或仅在可控核心文件冲突。**

```
relay.config.json                          ← 唯一手工真源（品牌 + 预设 providers + 额外白名单）
  │ sync: node Cursor++/scripts/sync-relay.mjs
  ├─→ Cursor++/src/server/relay/branding.ts    (生成，勿手改)
  ├─→ Cursor++/src/server/relay/preset.ts      (生成，勿手改)
  ├─→ Cursor++/package.json                    (publisher/name/displayName/description)
  ├─→ installer/src/relay/branding.js          (生成，勿手改)
  └─→ installer/src/relay/preset.js            (生成，勿手改)
        │
        ├─→ Cursor++/src/server/config/providersStore.ts  读取 RELAY_PROVIDERS，仅在种子/兜底时合并（不覆盖用户已有 providers.json）
        ├─→ Cursor++/src/server/config/routesStore.ts     读取 RELAY_EXTRA_REDIRECT，BYOK=on 时追加去重
        ├─→ installer/src/release-defaults.js             同上（install 时）
        ├─→ Cursor++/esbuild.js                           注入 __HUB_URL__ 读 relay.config.json
        └─→ Cursor++/src/update-check.ts                  读 relay/branding.ts 的 NPM_PACKAGE/UPDATE_COMMAND
```

- 新增中转逻辑**只允许**放在 `Cursor++/src/server/relay/` 与 `installer/src/relay/`。
- 禁止直接改 `Cursor++/src/server/data/defaults.ts` 的品牌字符串，或在 `esbuild.js` 硬编码 HUB_URL。
- 禁止手改任何 `// 由 relay.config.json + scripts/sync-relay.mjs 自动生成` 的文件。

## 3. 唯一真源 — relay.config.json

```jsonc
{
  "branding": { "publisher": "...", "name": "...", "displayName": "...", "hubUrl": "...", "npmPackage": "...", "updateCommand": "..." },
  "providers": [{ "_enabled": true, "id": "my-relay", "type": "openai-chat", "baseUrl": "https://api.example.com/v1", "auth": { "kind": "apiKey", "value": "" }, "models": [...] }],
  "extraRedirect": [] // 需劫持的额外 gRPC/REST 路径，BYOK=on 时追加
}
```

- `providers[]` 仅 `_enabled: true` 的条目会生成到 `preset.ts`；示例默认 `_enabled: false` 不生效。
- `type` 首选 `openai-chat`（最通用，兼容所有 openai-compatible 网关），按需选 `anthropic`/`openai-responses`/`gemini`。
- 改完必须执行 `node Cursor++/scripts/sync-relay.mjs` 并提交生成文件；CI 会以 `--check` 校验。

## 4. 上游同步流程

- **自动**：`.github/workflows/sync-upstream.yml` 每日 02:00 UTC `fetch upstream` → `merge upstream/main` → 推分支提 PR（成功直推，冲突推 draft）。
- **手动**：
  ```bash
  git fetch upstream
  git checkout main && git pull origin main
  git merge upstream/main --no-edit
  node Cursor++/scripts/sync-relay.mjs --check
  pnpm --dir Cursor++ run check-types
  git push origin main
  ```
- `Cursor++/src/server/data/defaults.ts` 与 `installer/src/defaults.js` 必须保持一致；上游改白名单/兜底时手动对照同步（文件头有注释）。
- 换机器克隆后需再执行 `git config merge.ours.driver true`。

## 5. 构建与校验（本地）

```bash
node Cursor++/scripts/sync-relay.mjs --check   # 校验 relay 同步
pnpm --dir Cursor++ run check-types            # tsc --noEmit
pnpm --dir Cursor++ run lint                   # eslint src（relay/** 已忽略）
pnpm --dir Cursor++ run compile                # check-types + lint + esbuild（产出 Cursor++/dist/extension.js）
npm --prefix installer run build               # 产出 installer/dist/cli.cjs（若改 installer）
```

- `Cursor++/pnpm-workspace.yaml` 必须含 `packages: ['.']`，否则 `pnpm install --frozen-lockfile` 报 `packages field missing`。
- `Cursor++/src/server/relay/**` 由 `eslint.config.mjs` 忽略（生成文件，双引号由 JSON 产生）。

## 6. 禁止 / 必须

- **禁止**：手改生成文件；在 `defaults.ts`/`esbuild.js` 硬编码品牌；删除 `.gitattributes` 的 `merge=ours` 规则；用 `npm install` 替代 `pnpm install --frozen-lockfile`（会写出 `package-lock.json`）。
- **必须**：新增中转能力先评估能否放入 `relay/preset.ts` 或 `relay/branding.ts`；确需新逻辑则新建 `relay/*.ts` 并在 `providersStore/routesStore/release-defaults` 以最小合并接入；任何改动后跑 `sync-relay --check + check-types + lint`。

## 7. 关键文件索引

| 文件                                           | 作用                          |
| ---------------------------------------------- | ----------------------------- |
| `relay.config.json`                            | 唯一真源                      |
| `Cursor++/scripts/sync-relay.mjs`              | 同步脚本                      |
| `Cursor++/src/server/relay/branding.ts`        | 品牌真源（生成）              |
| `Cursor++/src/server/relay/preset.ts`          | 预设 providers/白名单（生成） |
| `Cursor++/src/server/config/providersStore.ts` | 合并 RELAY_PROVIDERS          |
| `Cursor++/src/server/config/routesStore.ts`    | 合并 RELAY_EXTRA_REDIRECT     |
| `installer/src/release-defaults.js`            | 同上（installer）             |
| `.gitattributes`                               | 保护中转文件不被上游覆盖      |
| `.github/workflows/sync-upstream.yml`          | 自动同步                      |
| `docs/RELAY_GUIDE.md`                          | 详细手册                      |

详见 `docs/RELAY_GUIDE.md`。
