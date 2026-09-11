# Worker・Agent・DBを0.3.0へ揃える

公開版のWorker / Agent / packageは0.3.0、通信仕様は0.3.0、D1 schemaは4です。番号だけを合わせず、この版のコード一式を取得します。共通protocolに画像取得・一括添付・追加結果・通知・整理指示の形式を含みます。

## 既存環境を保護する

1. 現在のAgentを停止し、処理中の依頼が終わった状態で更新します。元の未コミット作業はコミット・退避または別チェックアウトで保護し、強制resetや上書きをしません。
2. `.agent/config.json`、既存の鍵ストア、`.agent/agent.sqlite`（会話ID）、`line-media/`を保持します。Windows DPAPIは同じユーザー・PCで使用し、MacのKeychainとファイルコピーで交換しません。
3. 実際のWorker URLの`/healthz`でversionとschemaVersionを確認します。公開テンプレートには実アカウント・D1 IDを入れていません。既存環境のwrangler設定を別ファイルで使い、配布テンプレートをそのままデプロイしません。
4. `npm ci --ignore-scripts`、`ffmpeg -version`、`ffprobe -version`、型チェックとテストを実行します。Windowsでは`npm.cmd`です。

## DB migration

新規構築は0001〜0004を順に適用。既存schema1には0002〜0004、schema2には0003〜0004、schema3には0004が必要です。schema4なら再適用不要です。

- 0002：画像動画のメタデータを保持する`job_media`。
- 0003：会話通知設定とジョブごとの通知モード。
- 0004：処理中の追送を同じ作業として扱う`notice_group`とindex。

いずれも追加のみで、既存のジョブ・所有者・鍵・会話を消しません。ただし0003・0004のALTER TABLEは生SQLを繰り返すと重複列エラーになります。Wranglerのmigration履歴で管理してください。過去に生SQLで適用して履歴がない環境では、自動再実行せず、schema_versionsと実際の列・履歴を照合してから個別に扱います。履歴を推測して書き換えません。

以下は対象を確認した利用者の更新コマンド例です。`YOUR_CONFIG`と`YOUR_DATABASE`は既存環境のものに置き換え、D1のバックアップ／Time Travel利用可否を確認してから行います。

```sh
node node_modules/wrangler/bin/wrangler.js d1 migrations list YOUR_DATABASE --remote --config YOUR_CONFIG
node node_modules/wrangler/bin/wrangler.js d1 migrations apply YOUR_DATABASE --remote --config YOUR_CONFIG
node node_modules/wrangler/bin/wrangler.js deploy --dry-run --config YOUR_CONFIG
node node_modules/wrangler/bin/wrangler.js deploy --config YOUR_CONFIG
```

既存設定の`vars.APP_VERSION`も0.3.0に合わせます。D1・Worker名・Agent ID・secretsは維持します。`worker:secrets -- agent-token`は更新には不要です。実行すると他端末の鍵を失効させるため、移行手順に含めません。

## 再起動と確認

Workerを先に更新した後、0.3.0 Agentを起動します。Agentは起動時にWorker release 0.3.0 / schema4を確認し、不一致なら処理を始めません。Workerは0.1.0 / 0.2.0 Agentのclaimを426で拒否し、添付の取りこぼしを防ぎます。

```sh
npm run worker:control -- agent-health
npm run codex:smoke
npm run secretary
```

テキスト2往復、画像、短い動画、指定フォルダへのコピー、途中の追加添付を確認します。Codexは読み取り専用で、Agentだけが`line-media/`へ固定の保存・コピーを行います。LINE送信失敗は結果保存と区別します。

DBを削除・巻き戻すロールバックはしません。問題時はAgentを停止して記録を保ち、同じ通信仕様に対応するWorker / Agentの組み合わせへ戻します。旧0.1.0への番号だけの巻き戻しはできません。
