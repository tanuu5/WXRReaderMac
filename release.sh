#!/bin/bash
# 配布用zipを作成する（GitHub Releases添付用）
# ditto を使うことで .app の属性・実行権限を保ったままzip化する
set -e
cd "$(dirname "$0")"

./build.sh

VERSION=$(defaults read "$(pwd)/build/書庫.app/Contents/Info.plist" CFBundleShortVersionString 2>/dev/null || echo "1.0")
ZIP="build/Shoko-${VERSION}.zip"
rm -f "$ZIP"
ditto -c -k --keepParent "build/書庫.app" "$ZIP"

echo ""
echo "✅ 配布用zip: $(pwd)/$ZIP"
echo "   GitHub Releases にアップロードしてください。"
echo "   注意: 未署名のため、ダウンロードした人は"
echo "   システム設定 > プライバシーとセキュリティ から手動許可が必要です。"
