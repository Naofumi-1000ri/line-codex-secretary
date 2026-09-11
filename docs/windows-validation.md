# Windows移植の検証記録

更新日: 2026-09-11

## 根拠と実装範囲

公開mainを取得し、`b2a8af3d28cd72118637ef2ad0e30be89df4d852`のままでWindows対応が未反映であることを確認しました。提供されたWindows検証メモと配布ガイドを参照しました。原Windowsソースやパッチは提供資料から入手できなかったため、今回はメモを根拠とした再実装です。

Windows DPAPI、PowerShell標準入力、環境変数許可リスト、WranglerのNode直接起動、Windows設定例、起動CMDを追加しました。加えて、npm版Codex 0.153.4の配布ファイルでネイティブ実行ファイルの配置を確認し、Windowsではそのexeを直接起動します。シェルやNodeラッパーを介さず、停止対象をApp Server自身にします。Windows秘密入力は非表示TTYとし、未対応のGUI / clipboardは明確なエラーで拒否します。

MacのKeychainコマンド・Swift補助処理・Codex起動経路を維持しています。Windows鍵ストアでは固定エラー、同一ディレクトリでの暗号化ファイルの原子的置換を使用します。DPAPIファイルはリポジトリの`.agent/credentials`へ保存し、cwdや許可workspaceを変更しても鍵の保存場所は変わりません。

## 以前のWindows実機確認（提供資料）

Windowsネイティブ / Node 22.18.0 / Codex CLI 0.153.4のローカル修正版で、LINE依頼と続く「さっきの説明を一言で」の2往復、同一thread ID、Ctrl+C停止を利用者が確認済みです。Windowsビルド番号は不明です。これは**今回作成したコードの実機確認ではありません**。

この過去確認には、Worker 0.3.0とAgent 0.1.0のHTTP 426を解消する別のプロトコル対応が含まれます。今回のPRは公開0.1.0同士を対象としたOS移植であり、0.3.0互換・バージョン偽装・既存Workerの変更を含みません。

## 今回の検証

- macOS作業環境でTypeScript型チェック、単体テストを実行。
- GitHub ActionsのmacOS / Windows、Node 22.18.0、Codex CLI 0.153.4で型チェック、テスト、Worker dry-runを実行する構成を追加。
- Windowsの実DPAPIでランダムなテスト鍵の保存・復号・暗号化ファイル内の平文不在・上書き・別Agent ID・欠損/破損時の固定エラーを検査。テスト専用一時ディレクトリは削除。
- npm / exeの起動解決、空白を含むパス、Windows環境変数の大文字小文字、秘密環境変数の除外を検査。
- Codex App Serverのinitialize / initializedと停止を認証なし・モデル呼び出しなしで実行。
- Secret BrokerのNode起動・標準入力・非TTY / clipboard拒否をモックで検査。クラウドへ鍵は送信しません。
- workspaceの脱出拒否テストはWindowsで管理者権限不要のjunctionを使い、同じ境界を検査。

CIの実行結果・リンクは完了後に追記します。

## 未検証・残る制限

今回の修正版によるLINE 2往復、新規LINE / Cloudflareを含む一通りの導入、Windows対話TTYでの実ユーザー入力、別Windowsユーザーからの復号拒否、別PCへの移行、Windows 10 / ARM64、組織管理下の実行ポリシーは未検証です。Macの実Keychainへテスト鍵を登録する試験は行わず、既存のユーザー鍵を保護します。

実ユーザーの鍵更新、既存Bot設定変更、Workerデプロイは今回行いません。CI成功は上記の起動・ローカル処理の確認であり、認証済みモデル処理やLINE全体の成功を保証するものではありません。
