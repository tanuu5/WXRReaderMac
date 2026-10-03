# 書庫 ChatGPT・Codex プラグイン

noteやWordPressのWXRバックアップを、OpenAIのCodexから検索・参照するためのローカルMCPプラグインです。画面部品は持たず、検索と本文取得のツールだけを追加します。

中で動くMCPサーバは、Claude Desktop用の拡張機能（[mcpb/](../../mcpb/README.md)）と同じものです。ツールの使い方や検索の並び順の考え方は、そちらのREADMEに書いてあります。

## 使えるツール

| ツール | できること |
| --- | --- |
| `library_info` | 記事数、期間、カテゴリ・タグなどの概要 |
| `search_articles` | AND / OR、関連度順、期間などを使った記事検索 |
| `find_similar` | 下書きや既存記事に近い過去記事の候補出し |
| `topic_timeline` | ある話題の記事を古い順に整理 |
| `get_article` | 記事1件の本文をMarkdown / HTML / テキストで取得 |

すべて読み取り専用です。ファイルの変更や外部サービスへの書き込みは行いません。

## バックアップフォルダの設定

macOSアプリ「書庫」でバックアップフォルダを一度開いていれば、その設定を自動的に再利用します。

アプリを使っていない場合は、Finderで `scripts/configure.command` をダブルクリックし、WXRの `.xml` が入ったフォルダを選んでください。設定は `~/Library/Application Support/Shoko/mcp-config.json` に保存され、中身はフォルダの場所だけです。

読み込み先の優先順位は、環境変数 `SHOKO_WXR_DIR`、上の設定ファイル、書庫アプリの設定、の順です。

## インストール

リポジトリのルートをローカル・マーケットプレイスとして登録し、このプラグインを入れます。Node.js 18以降が必要です。

```bash
codex plugin marketplace add /path/to/WXRReaderMac
codex plugin add shoko-chatgpt@personal
```

Codexはプラグインのフォルダを自分のキャッシュ（`~/.codex/plugins/cache/`）にコピーして動かします。リポジトリを更新したときは、もう一度 `codex plugin add shoko-chatgpt@personal` を実行して入れ直してください。

## 開発

サーバの正本は `mcpb/server/index.js` で、`server/index.js` はそのコピーです。Codexはプラグインのフォルダしかコピーしないため、シンボリックリンクではなく実体を置いています。サーバを直したら `mcpb/pack.sh` を実行すると、こちらにもコピーされます。

```bash
# 動作確認（テスト用のWXRで一通り呼ぶ。コピーが正本と一致しているかも確かめる）
node mcpb/test/smoke.js
```

## プライバシー

このプラグイン自体は、WXRファイルの読み取り以外を行いません。独自の外部通信もありません。ただし、ツールが返した検索結果や記事本文は会話に使われるため、OpenAI側へ送られます。Mac内で完結するのは、XMLの解析と検索までです。
