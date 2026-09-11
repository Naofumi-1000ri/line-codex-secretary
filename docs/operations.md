# LINE秘書 運用手順（0.3.0）

Mac / Windows、個人トークの文字・画像・動画に対応します。Codexは読み取り専用、Agentの固定処理が添付保存とコピー整理を行います。Windowsでは以下の`npm`を`npm.cmd`に置き換えます。

## 設定と状態確認

接続先は自分の`.agent/config.json`とwrangler設定ファイルで確認します。配布テンプレートの名前・D1 IDを既存環境へ転用しません。Worker / Agentは0.3.0、D1はschema4です。[更新手順](upgrade-0.3.0.md)も参照してください。

```sh
npm run worker:control -- status
npm run worker:control -- agent-health
```

`status`は所有者数・キュー件数・最後に登録されたAgent情報を取得します。`agent-health`は認証付き接続確認とAgent情報の登録を行うため、実行しただけで「常駐中のAgentが確認できた」とは扱いません。`/healthz`は鍵なしでWorkerの版とschemaを確認できます。

## 起動と停止

```sh
npm run secretary
```

ターミナルを開いたままにし、停止はCtrl+C。Windowsでは`start-secretary.cmd`も使えます。再起動後は再実行します。同時に複数Agentを起動しません。OSサービスや自動起動は登録しません。

既存の会話IDは`.agent/agent.sqlite`に保持します。同じLINEトークは同じCodexスレッドへ追加し、再起動後は再接続します。モデルは`gpt-5.6-luna`、推論強度は`max`です。CLI更新後は`npm run codex:smoke`で読み取り試験を行います。

## LINE通知とメディア

通常の文章は最終返信のみです。添付だけなら保存して用途を確認します。画像・動画の解析／整理は同じ作業で開始通知1回と最終返信を送り、処理中の追加分があれば前の結果を保留してまとめます。「これから詳細ログを出して」「今回は詳細ログも出して」「ログはもういい」で通知量を切り替えます。

PC側には受付番号・短い本文・保存先・処理状況を表示します。LINEへ内部推論、生のコマンド出力や鍵を送信しません。配信を確認できない場合は「結果保存・LINE配信未確認」と表示し、配信成功と区別します。自動再送や厳密な一度限りの配信保証を意味しません。

受信データは`line-media/`へ保存し、整理先はその会話内の`collections/<指定名>/`です。原ファイルを消さずコピーし、既存の異なる内容は上書きしません。`ffmpeg` / `ffprobe`が必要です。[メディアの詳細](media-support.md)を参照してください。

## 診断・鍵

```sh
npm run typecheck
npm test
npm run codex:smoke
```

媒体のローカルモデル試験は`npm run media:smoke`、会話判断は`npm run conversation:smoke`です。これらはモデルを呼びます。CIはテスト用媒体とLINEモックで検査し、実ユーザーの鍵やLINEへ接続しません。

401は既存鍵・Agent ID・接続先の組み合わせ、426はWorker / Agentの機能版を確認します。鍵更新は通常のコード更新に不要です。`worker:secrets -- agent-token`はWorkerの単一鍵を置き換え、旧端末を失効させます。変更が必要な場合だけ対象と移行影響を確認して行い、値はチャット・引数・環境変数に貼りません。

Windowsの鍵は同一ユーザーのDPAPI、MacはKeychainです。スタッフのWindows移行で旧Mac鍵が失効した例と同様に、別PCの鍵を無断で再登録して接続を奪い返さないでください。
