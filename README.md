# 書庫 — WXR Blog Archive Reader for macOS

<p align="center">
  <img src="Resources/AppIcon-preview.png" width="160" alt="書庫 アイコン">
</p>

noteなどのWXRバックアップ（WordPress eXtended RSS形式の.xml）を、ローカルで閲覧・検索・統計分析・Markdown変換するmacOSネイティブアプリです。SwiftUI製、依存パッケージなし。処理はすべてMac内で完結し、ネットワーク送信は一切ありません。

## 機能

- **WXR解析** — CDATA対応の文字列走査で壊れ気味のXMLも読める。複数ファイル・サブフォルダ収集対応
- **全文検索** — スペース区切りでAND、`OR`でOR。タグ・カテゴリクリックで絞り込み
- **統計** — 投稿カレンダー（ヒートマップ＋連続日数・連続週数）、月間投稿数・文字数チャート、カテゴリ・タグランキング
- **記事表示** — 本文HTML表示（バックアップ内assetsの画像を解決）、関連記事、前後移動
- **エクスポート** — Markdown（単体・一括）、CSV、クリップボードコピー（MD / HTML / URL）
- **キーボード** — `/` 検索、`j` / `k` 前後記事、`Esc` 戻る・クリア
- **Spotlight連携** — 記事をmacOSのSpotlight（⌘Space）から検索でき、結果クリックで該当記事が直接開く。索引はローカルのみ

## AI連携（別パッケージ）

### Claude Desktop

同じバックアップをClaude Desktopから検索・閲覧したい場合は、MCP拡張機能 `shoko.mcpb` を用意しています。ダウンロードしてダブルクリックするだけで入り、設定ファイルの編集は不要です。アプリとは独立して動くので、書庫を起動していなくても使えます。

過去記事の検索と本文取得に加えて、書こうとしているネタを過去に書いていないか調べる重複チェックと、ある話題について書いてきたことを時系列に並べる機能があります。記事が数百本を超えて自分でも把握しきれなくなったあたりから効いてきます。

詳しくは [mcpb/README.md](mcpb/README.md) をご覧ください。

### ChatGPT・Codex

同じ5つのツールを、OpenAIのCodex（CLI・デスクトップ）から使うためのローカルプラグイン `plugins/shoko-chatgpt/` もあります。中で動くMCPサーバはClaude用と同じもので、検索の結果も同じです。

書庫アプリで選んだバックアップフォルダを自動的に再利用します。会話に送られるのは検索結果と取得した記事本文だけで、バックアップ全体やMac上のフルパスは送りません。

詳しくは [plugins/shoko-chatgpt/README.md](plugins/shoko-chatgpt/README.md) をご覧ください。

## 動作環境

- macOS 13 Ventura 以降
- ビルドには Xcode Command Line Tools が必要（`xcode-select --install`）

## ビルドとインストール

```bash
git clone https://github.com/tanuu5/WXRReaderMac.git
cd WXRReaderMac
./build.sh
```

`build/書庫.app` ができます。Applicationsフォルダに移動してお使いください。

> **Releasesのzipを使う場合**: このアプリは未署名のため、初回起動時にGatekeeperにブロックされます。「システム設定 > プライバシーとセキュリティ」下部の「このまま開く」から許可してください。ソースからビルドした場合、この手順は不要です。

## 使い方

1. 起動して「フォルダを選択」から、noteのエクスポートXMLを含むフォルダを選ぶ
2. 記事一覧・統計が表示される。2回目以降は前回のフォルダにワンクリックで再接続
3. noteのバックアップzipは展開し、`（番号）_（ID）_1/` のようなサブフォルダ構成のままの親フォルダを選べばOK（assetsフォルダの画像も自動で表示される）

## プロジェクト構成

```
Sources/WXRReader/
  WXRParser.swift      # WXR解析（CDATA対応の文字列走査）
  Stats.swift          # 統計・関連記事スコアリング
  HTMLToMarkdown.swift # HTML→Markdown変換
  AppState.swift       # 状態管理・検索・エクスポート
  Views/               # SwiftUIビュー一式
build.sh               # .appを組み立てる
release.sh             # 配布用zipを作る
mcpb/                  # Claude Desktop用のMCP拡張機能（Node製・アプリとは独立）
  server/index.js      #   MCPサーバ本体（Claude・ChatGPT・Codexで共通の正本）
plugins/shoko-chatgpt/ # ChatGPT・Codex用のプラグイン（サーバは mcpb/ からのコピー）
.agents/plugins/       # Codexのローカル・マーケットプレイスの定義
```

## 変更履歴

### v1.1

- 投稿カレンダーに「現在の連続週数」「最長連続週数」「投稿した週数」を追加。毎日は書けなくても、毎週続いているかが分かります。週の区切りはヒートマップの列と同じ日曜始まりです
- 最長連続（日・週）の数字にポインタを重ねると、その期間を表示
- 投稿カレンダーを開いたとき、最新の週（右端）が見えるようにした
- 検索で全角・半角を区別しないようにした（`ＡＩ` と `AI`、`ｻｰﾊﾞ` と `サーバ` が同じものとして当たる。全角スペースもAND区切りになる）
- ダークモードで検索欄の文字が読めなかったのを修正（配色に合わせてライト表示に固定）
- 本文に `<![CDATA[` という文字列を含む記事があると、同じファイルの以降の記事が読み込まれなかったのを修正
- Markdown変換で `<br>` や `<blockquote>` を太字、`<img>` を斜体と取り違えて本文が崩れることがあったのを修正

### v1.0

- 初版

## ライセンス

[MIT License](LICENSE)

もとはHTML+JavaScriptのシングルファイルツールとして作ったものを、SwiftUIでフル書き直ししたものです。Built with Claude (Anthropic).
