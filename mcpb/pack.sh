#!/bin/bash
# 配布用の .mcpb を作る
# 前提: Node.js（npx）
set -e
cd "$(dirname "$0")"

OUT="../build/shoko.mcpb"
mkdir -p ../build

echo "▸ manifest.json を検証"
npx -y @anthropic-ai/mcpb validate manifest.json

echo "▸ パック"
npx -y @anthropic-ai/mcpb pack . "$OUT"

echo ""
echo "✅ 完了: $(cd .. && pwd)/build/shoko.mcpb"
echo "   ダブルクリックでClaude Desktopにインストールできます。"
open -R "$OUT" 2>/dev/null || true
