# Windowsネイティブ導入手順

更新日: 2026-09-11。WSLを使わず、文字メッセージ・個人トーク・読み取り専用で利用します。新規導入では共通の[セットアップ手順](setup-procedure.md)のLINE / Cloudflare手順と、このOS別手順を併用してください。実際の検証範囲は[検証記録](windows-validation.md)を参照してください。

## 1. PCを準備する

Windows 11、Git、Node.js 22.18.0以上、Windows PowerShell 5.1を準備します。Windows 10、ARM64は今回の実環境検証の対象外です。Codexの[Windows sandbox公式説明](https://developers.openai.com/codex/windows/)も参照し、読み取り専用sandboxを利用できる状態にしてください。管理者承認が必要な設定は本人または組織管理者が行います。

通常のPowerShellターミナルで次を実行します。既存のCodexがある場合は先に版とログインを確認し、勝手に置き換えないでください。

```powershell
node --version
npm.cmd --version
git --version
# 未導入の場合
npm.cmd install --global @openai/codex@0.153.4
codex.cmd --version
codex.cmd login status
# 未ログインの場合だけ
codex.cmd login

git clone https://github.com/Naofumi-1000ri/line-codex-secretary.git
Set-Location line-codex-secretary
npm.cmd ci --ignore-scripts
npm.cmd run typecheck
npm.cmd test
```

取得した版に`apps/agent/native/token-store.ps1`と`start-secretary.cmd`があることを確認してください。PRのマージ前はPRブランチを取得する必要があります。`npm.cmd` / `codex.cmd`はPowerShell用`.ps1` shimの実行ポリシーを避ける指定です。Agentはnpmの標準グローバル配置をPATHから探してネイティブ`codex.exe`を直接起動します。別の配布方式なら、以下で実在する実行ファイルの絶対パスを指定してください（`.cmd`、引数付き文字列は不可）。この環境変数は起動するターミナルごとに設定します。

```powershell
$env:LINE_SECRETARY_CODEX_EXE = 'C:\Tools\Codex\codex.exe'
```

## 2. 接続先を決める

### 新規のLINE / Cloudflare環境

共通手順の第1〜3章に従い、LINE公式アカウントとMessaging APIを準備し、Wranglerへログインします。LINEの規約同意・ログイン・秘密入力は本人が行います。

配布元の`apps/worker/wrangler.jsonc`には既存の開発用リソースIDがあります。そのままデプロイせず、自分用コピーを作成してください。以下は新規導入専用です。同名のローカル設定がある場合はコピーせず内容を確認します。

```powershell
Copy-Item apps/worker/wrangler.jsonc apps/worker/wrangler.local.jsonc
node node_modules/wrangler/bin/wrangler.js login
node node_modules/wrangler/bin/wrangler.js whoami
node node_modules/wrangler/bin/wrangler.js d1 create YOUR_UNIQUE_DATABASE_NAME
```

`wrangler.local.jsonc`の`account_id`、`name`、`database_name`、`database_id`を自分用の値へ変更します。`vars.AGENT_ID`は`linebot-windows`、`APP_VERSION`はこの版の`0.1.0`、`DEFAULT_WORKSPACE_KEY`は`linebot`とし、後のAgent設定と一致させます。ファイルはWorkerディレクトリ内に置き、既存の`main`と`migrations_dir`の相対パスを維持します。

新規作成したリソースであることを確認してから実行します。

```powershell
node node_modules/wrangler/bin/wrangler.js d1 migrations apply YOUR_UNIQUE_DATABASE_NAME --remote --config apps/worker/wrangler.local.jsonc
node node_modules/wrangler/bin/wrangler.js deploy --config apps/worker/wrangler.local.jsonc
```

これは利用者の導入時に行うクラウド変更です。今回のWindows修正・CIではデプロイしません。発行されたWorker URLを控え、次の鍵登録後、共通手順に従ってLINEのWebhook URL（Worker URL + `/v1/line/webhook`）、Webhook有効化、重複する自動応答の停止を設定します。

### 既存Workerに接続する場合

Workerの版、対象Account ID、Agent ID、設定ファイルを先に確認します。公開Agent 0.1.0と別系統のWorker 0.3.0は同一仕様ではありません。HTTP 426が出る場合は対応するAgentを用意してください。今回の変更は0.3.0互換を追加しません。

既存Workerで`agent-token`を実行すると、Workerの単一`AGENT_TOKEN_SHA256`が置き換わり、以前の鍵を使うPCは接続できなくなります。複数PC用の追加登録ではありません。既存端末を保護する場合は、独立したWorkerを用意するか、明示的な移行計画を立ててください。既存のLINE鍵の再登録も通常は不要です。

## 3. 秘密を非表示で登録する

Windowsは**対話ターミナルの非表示入力**を使用します。非TTY（パイプ・AI実行ログなど）と`--clipboard`は登録前にエラーになります。Mac専用GUIやクリップボード処理はWindowsでは使いません。

```powershell
$env:LINE_SECRETARY_WRANGLER_CONFIG = 'apps/worker/wrangler.local.jsonc'
$env:LINE_SECRETARY_AGENT_ID = 'linebot-windows'
npm.cmd run worker:secrets -- channel-secret
npm.cmd run worker:secrets -- access-token
# 新規Worker、または既存鍵の置換を明示的に決めたときだけ
npm.cmd run worker:secrets -- agent-token
```

最初の2コマンドは1つずつ実行し、「入力内容は表示されません」の専用プロンプトを確認してから本人が貼り付け、Enterを押します。通常のシェルやチャットへ鍵を貼らないでください。WindowsのBackspaceとCtrl+Cに対応します。手動貼り付け後のクリップボードは自動消去されないため、利用者が消去します。

PC鍵は生成後、DPAPI CurrentUserで暗号化し、`.agent/credentials/<Agent IDのSHA-256>.dpapi`へ保存します。秘密はPowerShell補助処理とWranglerへ標準入力で渡し、引数には含めません。鍵ストアの失敗時は固定エラーを返します。補助PowerShellは`-ExecutionPolicy RemoteSigned`で起動し、PC全体のポリシーは変更しません。グループポリシーに禁止されている場合は組織管理者へ確認してください。

DPAPIは同じWindowsユーザーの環境に依存します。暗号化ファイルだけを別PC / 別ユーザーへ移しても移行できません。同じユーザーで実行するプログラムから秘密を隔離する機能でもありません。Windowsのプロファイル・鍵ストアは適切に保護してください。

## 4. Agent設定と確認

新規導入で`.agent/config.json`がない場合だけ作成します。

```powershell
New-Item -ItemType Directory -Force .agent | Out-Null
Copy-Item apps/agent/config.windows.example.json .agent/config.json
```

`workerUrl`を実際のURL、`agentId`をWorkerと鍵登録で使った値、`workspacePath`を許可する絶対パスへ変更します。JSONでは`C:/Users/NAME/Documents/project`のように`/`を使うか、`\\`でバックスラッシュをエスケープします。`workspaceKey`はWorkerの`DEFAULT_WORKSPACE_KEY`と一致させます。

```powershell
npm.cmd run worker:control -- agent-health
npm.cmd run worker:control -- link-code
```

表示された短時間有効のリンクコードを本人がBotとの個人トークへ`/link 123456`の形式で送信します。コードは例の値を使わず、発行されたものを使います。その後、次を実行します。

```powershell
npm.cmd run codex:smoke
npm.cmd run secretary
```

`codex:smoke`はログイン済みCodexでモデルを呼ぶ読み取り試験です。CIの認証不要な起動試験とは異なります。LINEから短い読み取り依頼を送り、返信後「さっきの説明を一言で」を送り、継続を確認してください。

起動は`start-secretary.cmd`のダブルクリックでも可能です。起動済みなら重ねて実行しません。停止はCtrl+C、バッチ終了確認が出たらY。再開は同じコマンドで行います。PCの電源・ネット接続・Agentの実行が必要です。自動起動やサービス登録は行いません。
