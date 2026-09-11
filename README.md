# LINE Codex秘書

LINEの個人トークからPCのCodexへ文章で依頼し、許可したフォルダを読み取った結果をLINEへ返します。PC Agentは前景で起動し、同じトークの会話を継続します。

## 対応環境

- macOS: 既存のKeychain保存と起動経路を維持。鍵の保存にはXcode Command Line Tools（Swift）が必要です。
- Windowsネイティブ（WSL不要）: Windows PowerShell 5.1、DPAPI CurrentUser、非表示TTY入力に対応。Windows 11を導入の基準とします。組織ポリシーによるPowerShell / Codex sandbox制限は管理者と確認してください。
- Node.js **22.18.0以上**（`node:sqlite`を使用）。CIは22.18.0、Codex CLI **0.153.4**で確認します。npm版Codex、または絶対パスで指定したネイティブ実行ファイルを使用します。
- LINE Messaging API、Cloudflare Workers / D1、ログイン済みCodex CLIが必要です。Codexデスクトップアプリのログイン表示だけではCLI認証を確認できません。

現在の対象は**文字メッセージ・個人トーク・読み取り専用**です。画像・動画解析、ファイル編集、Windowsサービス / 自動起動、複数PCの同時接続は対象外です。Linuxの鍵ストアは未対応です。

## 導入

- [Windowsの新規導入・既存環境への接続](docs/windows-setup.md)
- [共通セットアップ手順](docs/setup-procedure.md)
- [AI向け導入手順](docs/ai-setup-runbook.md)
- [Windows移植の検証記録と制限](docs/windows-validation.md)

既存の設定ファイルやトークンを上書きせず、利用するWorkerとAgentの版を合わせてください。この変更は公開版0.1.0のWindows移植です。別途稼働しているWorker 0.3.0への互換修正は含みません。HTTP 426をバージョン文字列の書き換えだけで回避しないでください。

## 開発時の確認

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
node node_modules/wrangler/bin/wrangler.js deploy --dry-run --config apps/worker/wrangler.jsonc
```

Windows PowerShellでは上記の`npm`を`npm.cmd`に置き換えます。CIはmacOS / Windowsで実行し、Windowsではテスト専用のランダムな鍵でDPAPIを検査します。実ユーザーの鍵やクラウド認証はCIへ渡しません。
