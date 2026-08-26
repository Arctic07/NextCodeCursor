#!/usr/bin/env node
/**
 * 对 installer 的 src/*.js 进行 js-confuser 混淆保护
 * 输出到 dist/
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const jsConfuserPath = join(__dirname, '..', '..', 'references', 'js-confuser');
const { obfuscate } = await import(jsConfuserPath + '/dist/index.js');

const srcDir = join(__dirname);
const distDir = join(__dirname, '..', 'dist');
mkdirSync(distDir, { recursive: true });

const files = readdirSync(srcDir).filter(f => f.endsWith('.js') && f !== 'obfuscate.js');

for (const file of files) {
  const code = readFileSync(join(srcDir, file), 'utf-8');
  console.log(`[obf] ${file} (${(code.length / 1024).toFixed(1)} KB)...`);
  const result = await obfuscate(code, {
    target: 'node',
    preset: 'medium',
    minify: false,
    compact: true,
    hexadecimalNumbers: true,
  });
  writeFileSync(join(distDir, file), result.code);
  console.log(`  → ${(result.code.length / 1024).toFixed(1)} KB`);
}

console.log('[obf] Done');
