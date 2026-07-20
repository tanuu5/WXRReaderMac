#!/bin/bash
# 書庫.app を組み立てるビルドスクリプト
# 前提: Xcode Command Line Tools（swiftc）
set -e
cd "$(dirname "$0")"

echo "▸ swift build（初回は1〜2分かかります）"
# -file-prefix-map: バイナリに埋め込まれるソースパスからローカルパス（ユーザー名等）を除去
swift build -c release -Xswiftc "-file-prefix-map" -Xswiftc "$(pwd)=WXRReader"

APP="build/書庫.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp .build/release/WXRReader "$APP/Contents/MacOS/WXRReader"
cp Resources/Info.plist "$APP/Contents/Info.plist"
[ -f Resources/AppIcon.icns ] && cp Resources/AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"

# ad-hoc署名（ローカル実行用）
codesign --force -s - "$APP" 2>/dev/null || true

echo ""
echo "✅ 完了: $(pwd)/$APP"
echo "   Finderで開くか、以下で起動できます:"
echo "   open \"$APP\""

# Finderで場所を表示
open -R "$APP" 2>/dev/null || true
