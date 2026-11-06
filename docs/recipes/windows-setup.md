# レシピ: Windows でのローカルセットアップ

作成日: 2026-10-08（README「Windowsでのローカルセットアップ」から切り出し。
トラックB＝アプリ作者向け）

Windows でデスクトップアプリ（Tauri）として開発・起動するまでの手順。
ブラウザ単体（`pnpm dev`）だけなら Rust と WebView2 は不要（[README「まず試す: ブラウザデモ」](../../README.md#まず試す-ブラウザデモinmemory)）。

## 前提ツール（未導入のもののみ）

1. **Node.js 24+**: https://nodejs.org/
2. **pnpm 10+**: 管理者不要。`corepack enable pnpm` または `npm i -g pnpm`
3. **Rust**: https://rustup.rs/ （MSVCツールチェーン。インストーラの指示に従い
   Visual Studio Build Tools の「C++によるデスクトップ開発」を入れる）
4. **WebView2 Runtime**: Windows 10/11 は通常プリインストール済み
   （詳細: https://tauri.app/start/prerequisites/ ）

## セットアップ（PowerShell / コマンドプロンプト）

```powershell
cd D:\develop
git clone https://github.com/tyaro/banto.git banto
cd banto
pnpm install

# デスクトップアプリとして起動（初回はRustのコンパイルで数分かかります）
pnpm --filter admin-template tauri dev
```

初回起動時は管理者アカウント作成画面が表示されるので、ユーザー名・
表示名・パスワード（8文字以上）を入力してアカウントを作成する。以降の
起動ではそのアカウントでログインする（アカウントを作らずに始める選択肢は
[no-login-app.md](no-login-app.md)）。Tauriウィンドウ内ではRust+SQLite
（初回起動時に1,000件シード）、ブラウザ実行（`pnpm dev`）ではInMemory
（10,000件）が自動選択される。SQLiteファイルは
`%APPDATA%\dev.banto.admin\admin-template.sqlite3` に作成される。

## 補足

- Windowsでは`tauri dev`/`tauri build`に`icons/icon.ico`が必須（同梱済み）。
  独自アイコンに差し替える場合は`pnpm --filter admin-template tauri icon
<画像>`で全形式を再生成できる（[rename.md](rename.md) の「やらないこと」）。
- 認証はargon2id資格情報ストア + 初回セットアップ実装済み（`users`テーブル、
  `crates/banto-admin-services/src/users.rs`）。`pnpm dev`のブラウザ単体
  デモモード（Tauri/バックエンドなし、InMemoryデータ）のみ、Rustバック
  エンドを持たないため`admin` / `admin`固定の簡易セッション認証のまま。
- テーマ・ドックレイアウト等のUI設定は、Tauri/LANブラウザでは SQLite 設定DB
  （`SettingsProvider`、M12で移行済み）へ永続化される。localStorage は初回描画の
  ちらつき防止キャッシュ兼、ブラウザ単体デモモードのフォールバックとして併用する。
- LAN の他端末へ配信する場合は [lan-access.md](lan-access.md)。
