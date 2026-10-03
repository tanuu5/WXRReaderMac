#!/bin/bash
# 配布用の .mcpb を作る
# 前提: Node.js（npx）
set -e
cd "$(dirname "$0")"

OUT="../build/shoko.mcpb"
mkdir -p ../build

# ChatGPT・Codex用プラグインも同じサーバを使う。Codexはプラグインのフォルダだけを
# 自分のキャッシュへコピーして動かすので、リンクではなく実体のコピーを置く
echo "▸ サーバを plugins/shoko-chatgpt/ にコピー"
cp server/index.js ../plugins/shoko-chatgpt/server/index.js

echo "▸ manifest.json を検証"
npx -y @anthropic-ai/mcpb validate manifest.json

echo "▸ パック"
npx -y @anthropic-ai/mcpb pack . "$OUT"

echo ""
echo "✅ 完了: $(cd .. && pwd)/build/shoko.mcpb"
echo "   ダブルクリックでClaude Desktopにインストールできます。"
open -R "$OUT" 2>/dev/null || true
