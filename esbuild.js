const esbuild = require("esbuild");

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
    plugins: [esbuildProblemMatcherPlugin],
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
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
