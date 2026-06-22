/**
 * ccursor CLI — Cursor++ BYOK Installer
 *
 * Usage:
 *   npx @cometix/ccursor install     # Install extension + apply patches
 *   npx @cometix/ccursor uninstall   # Remove extension + restore patches
 *   npx @cometix/ccursor status      # Check installation status
 */

import { install } from './install.js';
import { uninstall } from './uninstall.js';
import { status } from './status.js';
import { check } from './check.js';

async function update() {
  await uninstall();
  console.log('');
  await install();
}

const command = process.argv[2];

const commands = {
  install,
  uninstall,
  update,
  upgrade: update,
  status,
  check,
  help: async () => {
    console.log(`
ccursor — Cursor++ BYOK Installer

Commands:
  install      Install Cursor++ extension and apply patches
  uninstall    Remove extension and restore all patches
  update       Upgrade: uninstall then reinstall
  status       Check current installation status
  check        Dry-run: verify AST patch targets are matchable
  help         Show this help message
`);
  },
};

const fn = commands[command];
if (!fn) {
  console.error(`Unknown command: ${command || '(none)'}`);
  commands.help();
  process.exit(1);
}

fn().catch(err => {
  console.error(`\n\x1b[31m[ERROR]\x1b[0m ${err.message}`);
  process.exit(1);
});
