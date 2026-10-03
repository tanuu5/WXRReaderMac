#!/usr/bin/env node

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

function configPath() {
  if (process.env.SHOKO_CONFIG_PATH) return process.env.SHOKO_CONFIG_PATH;
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Shoko', 'mcp-config.json');
  }
  if (process.platform === 'win32' && process.env.APPDATA) {
    return path.join(process.env.APPDATA, 'Shoko', 'mcp-config.json');
  }
  return path.join(os.homedir(), '.config', 'shoko', 'mcp-config.json');
}

function chooseFolder() {
  if (process.platform !== 'darwin') {
    throw new Error('フォルダのパスを引数で指定してください。');
  }
  const script = [
    'set chosenFolder to choose folder with prompt "noteまたはWordPressのWXR（.xml）が入ったフォルダを選んでください"',
    'POSIX path of chosenFolder',
  ];
  return execFileSync('/usr/bin/osascript', script.flatMap((line) => ['-e', line]), {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  }).trim();
}

function containsXml(root) {
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.xml')) return true;
      if (entry.isDirectory() && depth < 3 && walk(path.join(dir, entry.name), depth + 1)) return true;
    }
    return false;
  };
  return walk(root, 0);
}

function main() {
  const selected = path.resolve(process.argv[2] || chooseFolder());
  if (!fs.existsSync(selected) || !fs.statSync(selected).isDirectory()) {
    throw new Error('選択したフォルダが見つかりません。');
  }
  if (!containsXml(selected)) {
    throw new Error('選択したフォルダと3階層下までに .xml が見つかりません。');
  }

  const output = configPath();
  fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
  fs.writeFileSync(output, JSON.stringify({ wxr_dir: selected }, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(output, 0o600);
  console.log(`設定しました: ${path.basename(selected)}`);
}

try {
  main();
} catch (error) {
  console.error(`設定できませんでした: ${error.message}`);
  process.exitCode = 1;
}
