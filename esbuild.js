import esbuild from 'esbuild';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf-8'));
const production = process.argv.includes('--production');

// 1. Bundle
await esbuild.build({
  entryPoints: ['src/cli.js'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  outfile: 'dist/cli.cjs',
  minify: false,
  banner: {
    js: '#!/usr/bin/env node',
  },
  external: ['acorn'],
  define: {
    'process.env.CURSOR2PLUS_VERSION': JSON.stringify(pkg.version),
  },
});

console.log('[build] dist/cli.cjs (%s KB)', (readFileSync('dist/cli.cjs').length / 1024).toFixed(1));

// 2. Copy assets (models catalog) as sibling files — avoids bloating cli.cjs bundle
mkdirSync('dist', { recursive: true });
const ASSETS = ['models-catalog.json'];
for (const asset of ASSETS) {
  const src = join(__dirname, 'assets', asset);
  const dest = join(__dirname, 'dist', asset);
  copyFileSync(src, dest);
  console.log('[build] copied asset → dist/%s (%s KB)', asset, (readFileSync(dest).length / 1024).toFixed(1));
}

// 2. Obfuscate (production only)
if (production) {
  console.log('[build] Obfuscating...');
  const jsConfuserPath = join(__dirname, '..', 'references', 'js-confuser');
  const { obfuscate } = await import(jsConfuserPath + '/dist/index.js');

  // 去掉 shebang 再混淆（Pack 会把它包进 Function() 字符串导致语法错误）
  const raw = readFileSync('dist/cli.cjs', 'utf-8');
  const code = raw.replace(/^#!.*\n/, '');
  const result = await obfuscate(code, {
    target: 'node',
    compact: true,
    hexadecimalNumbers: true,
    // 与 Cursor++ 扩展相同的安全配置
    renameVariables: true,
    renameGlobals: true,
    renameLabels: true,
    movedDeclarations: true,
    shuffle: true,
    calculator: true,
    stringConcealing: true,
    duplicateLiteralsRemoval: 0.5,
    stringSplitting: 0.25,
    deadCode: 0.1,
    opaquePredicates: 0.5,
    astScrambler: true,
    controlFlowFlattening: 0.25,
    dispatcher: 0.08,
    globalConcealing: true,
  });

  writeFileSync('dist/cli.cjs', '#!/usr/bin/env node\n' + result.code);
  console.log('[build] Obfuscated: %s KB', (result.code.length / 1024).toFixed(1));
}

console.log('[build] done');
