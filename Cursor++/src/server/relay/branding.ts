/**
 * Relay Branding — 中转站品牌单一真源
 *
 * 由 relay.config.json + scripts/sync-relay.mjs 自动生成。请勿手改，改 relay.config.json。
 * 同步: node Cursor++/scripts/sync-relay.mjs
 */

export const RELAY_BRANDING = {
  publisher: "nextcode",
  name: "nextcode-cursor",
  displayName: "NextCode",
  description: "NextCode BYOK Extension — Bring Your Own Key for Cursor IDE",
  hubUrl: "https://www.arctictest.com",
  npmPackage: "@nextcode/ccursor",
  updateCommand: "npx @nextcode/ccursor update",
} as const

export const HUB_URL = RELAY_BRANDING.hubUrl
export const NPM_PACKAGE = RELAY_BRANDING.npmPackage
export const UPDATE_COMMAND = RELAY_BRANDING.updateCommand
