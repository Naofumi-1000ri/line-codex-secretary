# LINE秘書 運用メモ

## 現在の開発環境

- LINE公式アカウント: `PC Codex秘書`（`@805xcchy`）
- Worker: `https://line-codex-secretary-dev.naofumi-00c.workers.dev`
- Webhook: `https://line-codex-secretary-dev.naofumi-00c.workers.dev/v1/line/webhook`
- 許可workspace: `/Users/hgs/Documents/ChatGPT/LineBotV2`
- Agent ID: `linebot-mac`
- AIモデル: `gpt-5.6-luna`
- 推論強度: `max`
- 実行モード: 読み取り専用

## 状態確認

```bash
npm run setup
npx wrangler deployments list --config apps/worker/wrangler.jsonc
curl -fsS https://line-codex-secretary-dev.naofumi-00c.workers.dev/healthz
npm run worker:control -- status
```

## PC Codex秘書の起動と停止

秘書を使う間は、このプロジェクトを開いているCodex Appタスクの統合ターミナルをサイドパネルに開く。そこで次のコマンドを実行し、ターミナルを開いたままにする。このターミナルを秘書の起動・状態確認・停止を行う操作盤として使う。

```bash
npm run secretary
```

起動に成功すると「Codex接続」「LINEからの依頼を待っています」「AIモデル gpt-5.6-luna / max」が表示される。同じLINEトークから届いた依頼は同じCodexスレッドへ追加され、PC再起動後も前回のスレッドへ再接続する。停止するときは同じターミナルで `Ctrl+C` を押す。PCを再起動した後は、このコマンドをもう一度実行する。

事故防止のため、LINE秘書は新規スレッド、既存スレッドの再開、各ターンのすべてで `gpt-5.6-luna` を明示し、各ターンの推論強度を `max` に固定する。利用者のCodex全体設定や別タスクのモデルは変更しない。

Codex App Serverは現在Experimentalである。Codex CLIを更新した後は `npm run codex:smoke` を実行し、セッション接続と結果形式を確認する。

ターミナルには、LINEからPCへ届いたことが分かるように、時刻、受付番号、依頼文の短いプレビュー、Codexの接続状態、返信文の短いプレビュー、処理時間を表示する。受信行は、幅の狭いサイドパネルでも本文が先に見える `📩「依頼文…」のメッセージを受信` の順にする。これは手元のデモ用ターミナルだけに表示し、Cloudflareの監査ログやD1のイベントログには本文を複製しない。秘密情報、ユーザーID、Authorizationヘッダーは表示しない。接続状態は `npm run worker:control -- status` の `latestAgent` でも確認できる。

LINEには次の3段階だけを通知する。

1. `📨 PC Codexへ送信しました`
2. `🖥️ PC Codexが受信しました` / `🧠 Codexが確認中です…`
3. `✅ Codexから返信が届きました`

受付番号はLINEとターミナルの両方へ表示し、画面を並べたデモで同じ依頼を追えるようにする。Codexの内部推論、生のコマンド出力、秘密情報はLINEへ送らない。

## 秘密情報の更新

`npm run worker:secrets` を再実行する。LINE側で古い鍵を失効してから動作確認する。秘密情報をコマンド引数、環境変数、チャット、LINEへ貼らない。

## 診断

```bash
npm run typecheck
npm test
npm run codex:smoke
npx wrangler d1 migrations list DB --remote --config apps/worker/wrangler.jsonc
```

LINEから受付番号は返るが完了しない場合は、`npm run secretary` のターミナル表示、`npm run worker:control -- status` の順に確認する。通常の画面表示にある短い本文プレビューを除き、診断コマンドの出力へジョブ本文や秘密値を含めない。

## 最初から再確認する場合

1周目の `.setup/progress.json` を別名で保存してから、新しい進捗ファイルを作る。外部リソースは削除せず、LINE公式アカウント、Provider、D1、WorkerをIDで検出して再利用する。完全な新規作成テストを行う場合は、既存環境と名前・IDを混同しない別の開発環境を使う。
