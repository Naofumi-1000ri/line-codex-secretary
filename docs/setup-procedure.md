# PC Codex秘書 セットアップ実施手順

更新日: 2026-09-03
対象: LINE公式アカウント → Cloudflare Worker / D1 → PC上のCodex App

## ゴール

LINEへ依頼を送ると、Codex Appの右側ターミナルに受信・処理・返信のログが流れ、結果がLINEへ返る状態を作る。

```text
LINE
  ↓ 依頼
Cloudflare Worker + D1
  ↓ 安全な取得
PC Codex秘書（gpt-5.6-luna / max）
  ↓ 結果
LINE
```

初回は次の規定値を使う。

| 項目 | 規定値 |
|---|---|
| LINE公式アカウント名 | PC Codex秘書 |
| 団体名 | PC Codex秘書 |
| 業種 | 個人 → 個人（その他・架空に近い項目） |
| 利用者 | 1人 |
| 対象 | 個人チャットのテキスト |
| ワークスペース | このプロジェクトフォルダ1つ |
| 操作モード | 読み取り専用 |
| AIモデル | `gpt-5.6-luna` |
| 推論強度 | `max` |
| 同時処理 | 1件 |

## 作業分担

AIが、ページ移動、通常項目の入力、設定、ファイル作成、コマンド、D1、デプロイ、Webhook、検査、右側ターミナルの準備をまとめて行う。利用者へクリック単位で作業を頼まない。

利用者が行うのは次の場合だけとする。

- ログイン、パスワード、MFA、CAPTCHA
- 規約や法的事項への同意
- OAuthの許可
- LINEのSecretやTokenを公式画面で表示し、安全なローカル入力欄へ渡す操作

Secret、Token、パスワード、MFAコードはCodexの会話やLINEへ貼らない。

## 開始時の確認

AIは作成を始める前に、現在のプロジェクト、`.setup/progress.json`、既存のLINE公式アカウント、Cloudflareアカウント、D1、Worker、Keychainを確認する。存在するものは再利用し、同名リソースを重複作成しない。

途中から再開する場合も、最初からやり直さず、最後にAPIまたはCLIで確認できた地点の次から始める。

## 1. LINEの箱を作る

### AIがまとめて行うこと

1. `manager.line.biz` の正しい画面を開く。
2. 既存の `PC Codex秘書` を検索する。
3. 存在しなければ、アカウント名、団体名、業種などの通常項目を規定値で入力し、確認画面まで進める。
4. 作成後、Messaging APIを有効にし、ProviderとChannelを確認する。

### 利用者が行うこと

ログイン、MFA、規約同意を行う。AIは本人操作が必要な画面まで準備してから、一つの目的として依頼する。

### 完了条件

- LINE公式アカウント `PC Codex秘書` が存在する。
- Messaging API Channelが存在する。
- Channel IDをAIが確認できる。

## 2. ネットの受付を作る

### AIがまとめて行うこと

1. Worker、D1 migration、設定ファイルを準備する。
2. Wranglerの認証を開始する。アプリ内ブラウザからlocalhost callbackへ戻れない場合は、待たずにdevice authorizationへ切り替える。
3. ログイン後、`wrangler whoami` で対象アカウントとscopeを確認する。
4. D1を作成または既存IDで再利用し、migrationを適用する。
5. Workerをデプロイし、正確な `workers.dev` URLの `/healthz` を確認する。

### 利用者が行うこと

Cloudflareへのログイン、MFA、OAuthの許可を行う。

### 完了条件

- `/healthz` が `ok: true` を返す。
- D1のschema versionを取得できる。
- Worker URL、D1 ID、Cloudflare Account IDが進捗ファイルに記録される。

## 3. LINEの鍵を安全に登録する

### AIがまとめて行うこと

1. Channel SecretとChannel Access Tokenの登録先を準備する。
2. 入力内容を画面、履歴、引数へ残さないローカル入力を開く。
3. Cloudflare Secretの存在を確認し、実際の認証処理で正しさを検査する。
4. PC Agent tokenを生成し、平文はmacOS Keychain、ハッシュはWorkerへ保存する。

### 利用者が行うこと

LINE Developersの公式画面でChannel SecretとChannel Access Tokenを表示し、指定されたローカル入力欄へ入れる。会話欄やLINEには貼らない。

### 完了条件

- 必要なWorker Secret名がすべて存在する。
- PC AgentがWorkerの認証付きhealth APIへ接続できる。
- Secretの値そのものがログや進捗ファイルに残っていない。

## 4. LINEと受付をつなぐ

### AIがまとめて行うこと

1. WorkerのWebhook URLをLINEへ設定する。
2. Webhookを有効にし、署名付きイベントがD1へ届くことを確認する。
3. 一度だけ使える6桁のリンクコードを発行する。

### 利用者が行うこと

LINEで `PC Codex秘書` を友だち追加し、AIが発行した `/link 123456` 形式のコードを送る。

### 完了条件

- LINEへ「PC Codex秘書と安全にリンクできました」と1回だけ返る。
- D1に有効な所有者が1人だけ登録される。
- 使用済みリンクコードが再利用できない。

## 5. PCのCodex秘書を起動する

### AIがまとめて行うこと

1. 許可フォルダがこのプロジェクトだけであることを確認する。
2. Codex App Serverの読み取り専用smoke testを行う。
3. 新規スレッド、再開スレッド、各ターンで `gpt-5.6-luna` を明示し、各ターンを `max` に固定する。
4. Codex Appのこのタスクに右側ターミナルを開く。
5. 右側ターミナルで次を起動し、表示したままにする。

```bash
npm run secretary
```

パネルが表示されない場合はCodex Appを一度再起動し、同じタスクを開いてからターミナル表示を再試行する。

### 利用者が行うこと

通常はなし。停止したいときだけ、起動したターミナルで `Ctrl+C` を押す。

### 完了条件

右側ターミナルに次が表示される。

```text
🟢 ONLINE     LINEからの依頼を待っています
🔗 Codex接続  会話を引き継ぐセッションサーバーに接続済み
🤖 AIモデル   gpt-5.6-luna / max
🔒 操作モード 読み取り専用
```

## 6. LINEから一往復を確認する

### 利用者が行うこと

LINEから安全な読み取り依頼を1件送る。

```text
このプロジェクトを3行で説明してください
```

続けて、会話継続を確認する短い依頼を送る。

```text
さっきの説明を一言にしてください
```

### LINEで見える流れ

```text
📨 PC Codexへ送信しました
🖥️ PC Codexが受信しました
🧠 Codexが確認中です…
✅ Codexから返信が届きました
```

### 右側ターミナルで見える流れ

```text
[時刻] 📩「このプロジェクトを3行で説明してください」のメッセージを受信
[時刻] 🧾 受付番号  J...
[時刻] 🔗 Codex接続  前のLINE会話を引き継ぎました
[時刻] 🧠 Codex処理中  回答を作っています…
[時刻] ✅ LINE返信  「...」  (処理時間)
```

### AIが検証すること

- Webhook eventとjobが重複していない。
- 受付番号がLINEと右側ターミナルで一致する。
- 2件が同じCodex thread IDを使う。
- モデルが `gpt-5.6-luna`、推論強度が `max` である。
- 結果が各依頼につき1回だけLINEへ返る。
- Secret、Token、ユーザーIDがログに出ていない。

## 完了報告

AIは「できました」だけで終えず、次をまとめて報告する。

- LINE公式アカウント名
- Worker URLと稼働状態
- D1 schema version
- 許可ワークスペース
- `gpt-5.6-luna / max` と読み取り専用の固定
- LINEの2往復と同一スレッド継続
- 起動方法 `npm run secretary`
- 停止方法 `Ctrl+C`
- 未解決事項があれば、その影響と次の一手

## 作業中の話し方

- 最初に現在の章と目的を伝える。
- 本人操作が不要な間は、AIが止まらずに進める。
- 利用者へ頼むときは、ログイン、同意、OAuth、Secret入力など一つの目的にまとめる。
- 「確認を押す」「次を押す」のようなクリック単位の往復を続けない。
- 技術用語より「LINEの箱」「ネットの受付」「PCの秘書」を先に使う。
- 利用者の自己申告だけで完了にせず、画面、API、CLI、D1のいずれかで確認する。
