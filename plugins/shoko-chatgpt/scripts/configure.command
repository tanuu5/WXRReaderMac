#!/bin/zsh

cd -- "$(dirname -- "$0")/.." || exit 1
node ./scripts/configure.js
status=$?

if [[ $status -eq 0 ]]; then
  echo
  echo "設定が終わりました。このウインドウを閉じてChatGPTを再起動してください。"
else
  echo
  echo "設定できませんでした。上のメッセージを確認してください。"
fi

echo
read -k 1 "?何かキーを押すと閉じます。"
exit $status
