# LINE Codex秘書

LINEの個人トークからPCのCodexへ文章で依頼したり、画像・動画を送り、要約・比較・指定フォルダへの整理を頼めます。PC Agentは前景で起動し、同じトークの会話を継続します。

## 対応環境

- macOS: 既存のKeychain保存と起動経路を維持。鍵の保存にはXcode Command Line Tools（Swift）が必要です。
- Windowsネイティブ（WSL不要）: Windows PowerShell 5.1、DPAPI CurrentUser、非表示TTY入力に対応。Windows 11を導入の基準とします。組織ポリシーによるPowerShell / Codex sandbox制限は管理者と確認してください。
- Node.js **22.18.0以上**（`node:sqlite`を使用）。CIは22.18.0、Codex CLI **0.153.4**で確認します。npm版Codex、または絶対パスで指定したネイティブ実行ファイルを使用します。
- LINE Messaging API、Cloudflare Workers / D1、ログイン済みCodex CLIが必要です。Codexデスクトップアプリのログイン表示だけではCLI認証を確認できません。

現在の公開版は **0.3.0 / DBスキーマ4**。**個人トークの文字・画像・動画**に対応します。画像は20MiB、動画は200MiBまで。動画は代表6フレームの確認で、音声文字起こしは未対応です。`ffmpeg` / `ffprobe`をPATHへ追加してください。

Codexは読み取り専用。Agentの固定処理が`line-media/`へ原ファイルと一覧を保存し、依頼されたフォルダへコピー整理します。原ファイルを移動・削除しません。添付だけなら用途を確認し、指示があれば解析・整理してまとめて返信します。Windowsサービス / 自動起動、一般ファイル編集、複数PC同時接続、Linux鍵ストアは対象外です。

## 導入

- [Windowsの新規導入・既存環境への接続](docs/windows-setup.md)
- [共通セットアップ手順](docs/setup-procedure.md)
- [AI向け導入手順](docs/ai-setup-runbook.md)
- [Windows移植の検証記録と制限](docs/windows-validation.md)

既存の設定ファイルやトークンを上書きせず、[0.3.0への更新手順](docs/upgrade-0.3.0.md)でWorker・Agent・DBを揃えてください。HTTP 426を番号の書き換えだけで回避せず、画像取得・一括ジョブ・追加結果の引き継ぎ・通知APIを含むこの版を使用します。

[画像・動画と整理の使い方](docs/media-support.md) / [今回の統合・検証記録](docs/release-0.3.0.md)

## 開発時の確認

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
node node_modules/wrangler/bin/wrangler.js deploy --dry-run --config apps/worker/wrangler.jsonc
```

Windows PowerShellでは上記の`npm`を`npm.cmd`に置き換えます。CIはmacOS / Windowsで実行し、Windowsではテスト専用のランダムな鍵でDPAPIを検査します。実ユーザーの鍵やクラウド認証はCIへ渡しません。
