# vibe-editor

[English](README.md) · [日本語](README-ja.md)

![vibe-editor demo](docs/demo.gif)

> **[Claude Code](https://claude.com/code) と [Codex](https://openai.com/codex/) のためのチームオーケストレーター。** 2〜30 体のエージェントをロール付きで立ち上げ、リアルタイムで仕事を引き継ぐ様子を眺めながら、一つのデスクトップ画面でレビュー/軌道修正する。

vibe-editor はコードエディタではありません。Tauri + Rust で作られた**チームディスパッチャ**です — 仕事を言葉で渡すと Leader が programmer / researcher / reviewer に割り振り、メッセージは **pty に直接注入**される (ポーリングもファイルキューもなし)。あなたはレビュアーとしてループに居続けます。内蔵のエディタ・git diff・セッション履歴は、このレビューループを支えるための道具であって、本物の IDE と張り合うものではありません。

![vibe-editor screenshot](docs/screenshot.png)

---

## インストール (Windows)

[Releases](https://github.com/yusei531642/vibe-editor/releases/latest) ページから最新の Windows インストーラを落とすのが最速です。

1. `vibe-editor-Setup-1.0.0.exe` をダウンロード
2. 実行。インストーラは **ワンクリックサイレント**（セットアップウィザード無し）で終わり、そのまま vibe-editor が起動します
3. 以降のアップデートは **完全サイレント**。内蔵の自動アップデータが GitHub Releases から新版をバックグラウンド取得し、ダイアログ無しで再起動します

### SmartScreen がブロックした場合

ビルドはコード署名されていません（Authenticode 証明書無し）。お好みで:

- **SmartScreen「詳細情報」→「実行」** — 一番簡単。もしくは `.exe` 右クリック → プロパティ → 下部の「ブロックの解除」にチェック → OK
- **Smart App Control を「評価」モードに** — 設定 → プライバシーとセキュリティ → Windows セキュリティ → アプリとブラウザーの制御 → Smart App Control → **評価**。既知の悪性アプリのみブロック
  - ⚠️「オフ」は選ばないこと。戻すには Windows の再インストールが必要になります。「評価」が落とし所
- **自分でビルド** — `git clone … && npm install && npm run build` で実ファイルを検証

### インストール場所

ワンクリックインストールは `%LOCALAPPDATA%\Programs\vibe-editor\`（ユーザースコープ、管理者権限不要）に入ります。アンインストールは Windows の「インストール済みアプリ」から。設定とチーム履歴は `%APPDATA%\vibe-editor\` に保存され、アンインストール後も残ります。

### macOS / Linux

Pre-built バイナリは未公開です。ソースからビルドしてください:

```bash
git clone https://github.com/yusei531642/vibe-editor.git
cd vibe-editor
npm install
npm run build      # src-tauri/target/release/bundle/ に出力
```

---

## 必要なもの

- **[Claude Code CLI](https://claude.com/code)** が `PATH` に `claude` として入っていること — 主役。先にインストールして `claude --version` が通ることを確認
- **Git** が `PATH` にあること — 変更ファイル一覧で使用
- **Node.js 20+** — ソースからビルドする場合のみ

Python、C++ ビルドツール、node-gyp は**不要**です（pty は Rust の `portable-pty` を使用、renderer は pure JS）。Rust ツールチェイン（`rustup`）のみ必要です。

---

## 機能

### マルチエージェントチーム（リアルタイムメッセージ配信）

- 2〜30 インスタンスの Claude Code / Codex をロール付きで束ねる（**leader / planner / programmer / researcher / reviewer**）
- Leader はユーザー指示を待ち、メンバーは Leader の委譲を待つ — 勝手に動き出さない
- **pty 直接注入** を使う独自 MCP ハブ (`TeamHub`): Leader が `team_send("programmer", "...")` を呼ぶと、**programmer の入力プロンプトにその場で注入**される。ファイルポーリング無し、キュー無し、遅延無し
- チーム状態の永続化: 作成したチームは `~/.vibe-editor/team-history.json` に保存。**履歴 → Teams** からワンクリックで復元、各メンバーは `claude --resume <session>` で過去の会話をそのまま継続
- 組み込みプリセット（Dev Duo / Full Team / Code Squad）＋カスタムプリセット保存

### ターミナルワークスペース

- 右側に固定の Claude Code / Codex ターミナルパネル（幅はドラッグ調整）
- 最大 30 個のターミナルを同時実行、2/3/4/5 列のグリッドに自動レイアウト
- ペインのドラッグ並び替えで pty を再起動しない
- ターミナル内で `Ctrl+V` → クリップボードの画像を一時ファイルに保存して絶対パスをカーソル位置に挿入（Claude がそのまま読める）
- ロール別カラーラベル、Leader クラウン、チームグループ表示

### ファイルツリー＋軽量エディタ

- 3 タブサイドバー: **ファイル** / **変更** / **履歴**
- 遅延ロード式のファイルツリー（`.git` / `node_modules` / `out` / `dist` などは自動除外）
- ファイルクリック → Monaco ベースのエディタタブで開く（27言語のシンタックスハイライト）
- `Ctrl+S` でアトミック保存（tmp → rename）。TabBar にダーティインジケータ。未保存のまま閉じようとすると確認

### Git 差分レビュー

- `git status --porcelain=v1 -z` 連動の変更ファイルパネル
- クリックで Monaco `DiffEditor` にサイドバイサイド／インラインで差分表示
- 右クリック →「差分レビューを Claude Code に依頼」でアクティブターミナルにプロンプト送信
- バイナリファイルは自動検出してプレースホルダ表示

### セッション履歴

- `~/.claude/projects/<encoded>/*.jsonl` を読み取り、このプロジェクトの Claude Code 過去セッション一覧を表示
- クリックで `claude --resume <id>` の新規タブ起動
- チームセッションは履歴タブの冒頭に Teams セクションとして分離表示

### 自動アップデート

- `tauri-plugin-updater` が起動時に GitHub Releases をチェック
- 完了時に **サイレント上書きインストール** → 自動再起動（ダイアログ無し）
- 署名検証付きマニフェスト、ダウンロード失敗時のリトライ、GitHub CDN 向けに TLS ハンドシェイクを明示安定化

### テーマとデザイン

- 5 テーマ: `claude-dark`（既定）/ `claude-light` / `dark` / `midnight` / `light`
- 3 段階の情報密度: `compact` / `normal` / `comfortable`
- 日本語タイポグラフィ優先（Notion JP 相当 — Yu Gothic 系スタック、行間 1.75、カーニング）
- レイヤードシャドウ、スプリングアニメーション、アクセント面のノイズオーバーレイ
- アイコンは全て [lucide-react](https://lucide.dev/)

---

## キーボードショートカット

| ショートカット | アクション |
|---|---|
| `Ctrl+Shift+P` | コマンドパレット（全アクションのファジー検索） |
| `Ctrl+,` | 設定 |
| `Ctrl+S` | アクティブなエディタタブを保存 |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | タブを巡回 |
| `Ctrl+W` | アクティブなタブを閉じる |
| `Ctrl+Shift+T` | 最後に閉じたタブを復活 |

---

## ソースから開発

```bash
git clone https://github.com/yusei531642/vibe-editor.git
cd vibe-editor
npm install
npm run dev
```

Tauri が Claude Code ターミナル1つで起動します。左上のプロジェクトメニュー or `Ctrl+Shift+P → フォルダを開く…` で任意のフォルダを開いてください。

### その他のスクリプト

```bash
npm run typecheck    # tsc --noEmit (strict)
npm run dev:vite     # レンダラーのみ起動 (Rust なし)
npm run build        # cargo tauri build → src-tauri/target/release/bundle/
npm run icons        # build/icon.svg から ICO を再生成
```

---

## アーキテクチャ

```
src-tauri/                       # Rust 側 (Tauri ホスト)
├── src/
│   ├── main.rs                  # Tauri アプリエントリ、updater 起動
│   ├── lib.rs                   # invoke handler 登録
│   ├── commands/                # IPC ハンドラ (app/git/terminal/settings/…)
│   ├── pty/                     # portable-pty + batcher + Claude session ウォッチャ
│   ├── team_hub/                # TCP JSON-RPC MCP ハブ + 埋込み team-bridge.js
│   └── mcp_config/              # ~/.claude.json & ~/.codex/config.toml 書き込み
├── Cargo.toml
└── tauri.conf.json

src/renderer/src/                # React 18 + TypeScript, UI 専用
├── App.tsx
├── components/                  # UI コンポーネント
├── components/canvas/           # @xyflow/react 無限キャンバスモード
├── stores/                      # zustand (ui, canvas)
└── lib/                         # themes, i18n, tauri-api, commands, …
```

### TeamHub の仕組み

```
 ┌──── Rust ホスト (src-tauri) ──────────────┐
 │                                           │
 │  TeamHub                                  │
 │   ├─ 127.0.0.1:rand の JSON-RPC           │
 │   ├─ agentId → pty レジストリ             │
 │   └─ team_send → pty.write 注入           │
 │                                           │
 │  commands/terminal.rs が pty を保有        │
 │  (portable-pty)                            │
 └───────────────────────────────────────────┘
       ▲                ▲
   stdio MCP        stdio MCP
 ┌────┴────┐      ┌────┴────┐
 │Claude A │      │Claude B │
 │bridge.js│      │bridge.js│ ← ~60 行の TCP パススルー
 └─────────┘      └─────────┘
```

- 起動時に Rust の `TeamHub` がランダムポート + 24 バイトトークンで TCP JSON-RPC サーバーを立てる
- `team-bridge.js` を `%APPDATA%\vibe-editor\team-bridge.js` に書き出し、`~/.claude.json` と `~/.codex/config.toml` の `vibe-team` MCP として登録
- Claude Code が `vibe-team` を spawn するとブリッジが TCP でハブに接続、トークンで認証
- `team_send(to, message)` はハブ側で宛先 `agentId` → pty を引き、`pty.write(message + '\r')` でその場注入。ファイルポーリング無し
- Windows の ConPTY 向けに UTF-8 安全なチャンク送信を実装済み
- アプリ終了時にハブ停止し、MCP 設定エントリを cleanup（自己完結したアンインストール）

### 設計上の制約

- Rust ホストが保有: ファイルシステム、git、pty、ダイアログ、TeamHub TCP サーバー、自動アップデータ
- レンダラーは純 UI: すべての副作用は `@tauri-apps/api/core` の `invoke()` + `listen()` 経由
- TypeScript strict モード全レンダラーコードベース適用

---

## 思想

これはコードエディタではありません。**Claude Code のレビュー面とチームディスパッチャ**です:

- `CLAUDE.md` を人間が編集しない — Claude が書く
- スキルを有効化しない — Claude が説明文から自動ロードする
- 関数を書かない — ターミナルで説明して Claude に書かせる
- 複数の Claude をロール付きで**編成**し、差分をレビューして方向修正する

UI の役目は**邪魔をしないこと**。

---

## ライセンス

MIT — [LICENSE](LICENSE) を参照。

Anthropic、OpenAI との提携関係はありません。「Claude Code」は [Anthropic](https://anthropic.com/) の、「Codex」は [OpenAI](https://openai.com/) のプロダクトです。
