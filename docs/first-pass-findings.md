# 1周目セットアップ所感

実施日: 2026-09-03

## 利用者案内

- 「一度に一つ」をクリック単位に分解すると、確認回数が増えて流れが分かりにくくなった。
- 名前、団体名、業種、通常の選択、URL入力、保存、検証はAIがまとめて行う。
- 利用者へ渡すのは、ログイン、MFA、規約同意、OAuth承認、秘密情報の表示・入力など本人しか確定できない境界に限る。
- 複数クリックでも同じ目的で途中判断が不要なら、一つの操作としてまとめて案内する。

## ブラウザと認証

- アプリ内ブラウザからWranglerの `localhost` OAuth callbackへ接続できなかった。単なる待ち時間ではなく接続拒否だった。
- Wranglerのdevice authorization flowで認証できた。対象Account IDと必要scopeは `wrangler whoami` で検証する。
- Codex再起動前は新規ブラウザタブとターミナルパネルが画面へ反映されなかった。再起動後は、必要時に表示確認してから利用する。

## 実装で見つかった問題

- macOS `security add-generic-password -w` の非TTY入力では空のパスワードが保存された。Security frameworkを使うSwift helperで、標準入力からKeychainへ保存するよう修正した。
- OSの自動起動ではCodexの実行環境が利用者のターミナルと異なり、設定と診断が分かりにくくなった。自動起動は採用せず、`npm run secretary` を明示的に実行し、`Ctrl+C`で止める構成へ変更した。
- 依頼ごとに独立したCLIプロセスを作る方式では会話が分かれた。Codex App Serverを前景で1つ起動し、LINEトークごとのthread IDへ再接続する方式へ変更した。
- 再試行時に同じidempotency keyを使うと、2回目の失敗遷移が重複扱いになりジョブがLEASEDで残った。試行ごとにUUIDを使うよう修正した。
- Worker公開前に `workers.dev` subdomainが未登録でdeployが止まった。既存subdomainの確認後に再deployすると成功した。

## 1周目の結果

- LINE → Webhook → D1 → PC Agent → Codex CLI → LINE返信が成功した。
- 最終依頼は1回で完了し、通知も1回送信された。
- workspaceは `LineBotV2`、実行モードは読み取り専用、所有者は1人で開始した。
- PC Agentはバックグラウンド登録せず、利用者が秘書を使う間だけターミナルで起動する。
- App Server移行後、連続するLINE依頼2件が同じthread IDを使い、2件目が1件目の内容を正しく引き継ぐことをD1と応答内容で確認した。

## 第2周へ反映すること

- 利用者向けには6章だけを見せ、A〜Zの内部項目はAIの検証用に残す。
- LINE側は「PCへ送信」「PCが受信・Codexが確認中」「返信」の3段階にする。
- Codex Appの右側ターミナルを操作盤として使い、LINEからPCへ届いたことを視覚的に見せる。
- 幅の狭いパネルでも内容が見えるよう、受信ログは `「本文…」のメッセージを受信` の順にする。
- PCの既定設定を継承せず、LINE秘書は `gpt-5.6-luna / max` を新規・再開・各ターンで明示する。
- 再実施時は[PC Codex秘書 セットアップ実施手順](./setup-procedure.md)を正本にする。
