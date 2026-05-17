const esbuild = require("esbuild");
const { cpSync, readdirSync } = require("fs");
const { join } = require("path");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

// HUB_URL —— 字符串在 js-confuser 的 StringConcealing 下不可见
const HUB_URL = "https://ccursor.cometix.dev";

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
    await Promise.all([extCtx.watch(), webCtx.watch()]);
  } else {
    await Promise.all([extCtx.rebuild(), webCtx.rebuild()]);
    await Promise.all([extCtx.dispose(), webCtx.dispose()]);

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
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
