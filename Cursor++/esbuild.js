const esbuild = require("esbuild");
const { cpSync, mkdirSync, readdirSync, readFileSync, existsSync } = require("fs");
const { join } = require("path");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

// HUB_URL —— 由 relay.config.json 驱动，同步脚本生成 branding.ts 时一并更新此注入
// 单一真源: 根目录 relay.config.json → Cursor++/src/server/relay/branding.ts → esbuild define __HUB_URL__
// 此处做运行时回退读取，确保直接改 relay.config.json 后不跑 sync 也能构建出正确值
let HUB_URL = "https://ccursor.cometix.dev";
try {
  const cfgPath = join(__dirname, "..", "relay.config.json");
  if (existsSync(cfgPath)) {
    const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
    if (cfg?.branding?.hubUrl) HUB_URL = cfg.branding.hubUrl;
  }
} catch {}

function copyRuntimeAssets() {
  mkdirSync(join(__dirname, "dist"), { recursive: true });

  // Copy supermarkdown NAPI .node binaries + JS entry to dist/
  const smDir = join(__dirname, "node_modules", "@vakra-dev", "supermarkdown");
  try {
    for (const f of readdirSync(smDir)) {
      if (f.endsWith(".node") || f === "index.js" || f === "index.d.ts") {
        cpSync(join(smDir, f), join(__dirname, "dist", f));
      }
    }
    console.log("[build] supermarkdown native binaries copied to dist/");
  } catch (e) {
    console.warn("[build] supermarkdown copy failed:", e.message);
  }

  // Copy gpt-tokenizer o200k_base encoding to dist/ (external, not obfuscated)
  try {
    cpSync(
      join(__dirname, "node_modules", "gpt-tokenizer", "dist", "o200k_base.js"),
      join(__dirname, "dist", "o200k_base.js"),
    );
    console.log("[build] gpt-tokenizer o200k_base copied to dist/");
  } catch (e) {
    console.warn("[build] gpt-tokenizer copy failed:", e.message);
  }
}

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
  name: "esbuild-problem-matcher",

  setup(build) {
    build.onStart(() => {
      console.log("[watch] build started");
    });
    build.onEnd((result) => {
      result.errors.forEach(({ text, location }) => {
        console.error(`✘ [ERROR] ${text}`);
        if (location) {
          console.error(
            `    ${location.file}:${location.line}:${location.column}:`,
          );
        }
      });
      console.log("[watch] build finished");
    });
  },
};

async function main() {
  // ── Context 1: Extension host (Node.js) ──
  const extCtx = await esbuild.context({
    entryPoints: ["src/extension.ts"],
    bundle: true,
    format: "cjs",
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: "node",
    outdir: "dist",
    external: ["vscode"],
    logLevel: "silent",
    jsx: "automatic",
    jsxImportSource: "hono/jsx",
    define: {
      "import.meta.url": "undefined",
      __HUB_URL__: JSON.stringify(HUB_URL),
    },
    plugins: [
      {
        name: "supermarkdown-native",
        setup(build) {
          build.onResolve({ filter: /^@vakra-dev\/supermarkdown$/ }, () => ({
            path: "./index.js",
            external: true,
          }));
        },
      },
      {
        name: "gpt-tokenizer-external",
        setup(build) {
          build.onResolve({ filter: /^gpt-tokenizer\/encoding\/o200k_base$/ }, () => ({
            path: "./o200k_base.js",
            external: true,
          }));
        },
      },
      esbuildProblemMatcherPlugin,
    ],
  });

  // ── Context 2: Webview (Browser, IIFE) ──
  const webCtx = await esbuild.context({
    entryPoints: ["src/ui/webview/alpine-entry.ts"],
    bundle: true,
    format: "iife",
    minify: production,
    sourcemap: false,
    platform: "browser",
    outfile: "dist/webview.js",
    logLevel: "silent",
    plugins: [esbuildProblemMatcherPlugin],
  });

  if (watch) {
    copyRuntimeAssets();
    await Promise.all([extCtx.watch(), webCtx.watch()]);
  } else {
    await Promise.all([extCtx.rebuild(), webCtx.rebuild()]);
    await Promise.all([extCtx.dispose(), webCtx.dispose()]);
    copyRuntimeAssets();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
