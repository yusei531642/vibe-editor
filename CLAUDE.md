# vibe-editor

Tauri ベースの Claude Code / Codex 専用エディタ (v1.4.x)

## 必須スキル
このリポジトリで作業する前に、以下の skill を必ず起動すること。

- **`vibeeditor`** skill — プロジェクト全体ガイド (アーキテクチャ / IPC / 命名規則 / 頻出コマンド / Canvas / PTY / TeamHub 等)。コードを書く前・触る前に必ず参照する。
- **`pullrequest`** skill — PR 作成から bot 自動レビュー → 指摘修正ループ → 自動 merge までの workflow。PR を作る/触るときは必ずこれに従う。

## 作業ワークフロー (厳守)

### 1. 問題発見時は「PR を直接作らない」
- バグ・改善・リファクタ等を見つけたら、**いきなり PR を出さない**。
- まず **GitHub Issue を作成** し、内容・再現手順・想定スコープを記述する。
- その後ブランチを切って修正 → PR を提出する (`Closes #<issue>` を本文に含める)。

### 2. Issue には必ずラベルを付ける
- ラベル無しの Issue は作らない。種類 (`bug` / `enhancement` / `refactor` / `docs` 等) と領域 (`area:rust` / `area:renderer` / `area:canvas` 等) を最低 1 つずつ付ける。
- 既存ラベルが合わない場合は先にラベルを作るか、ユーザーに確認する。

### 3. `main` への直接 push 禁止
- いかなる理由があっても `git push origin main` は禁止。
- 必ず feature branch を切って PR 経由でマージする。merge は **vibe-editor-reviewer (bot) が自動で行う**。手動 merge もしない。

### 4. PR 提出後はレビューループを完走させる
- PR を出したら **vibe-editor-reviewer (GitHub bot)** が自動レビューする。
- レビューコメントが付いたら **すべて修正** → push → 再レビュー、を **bot が merge するまで繰り返す**。
- 検知は `loop` skill (または `/loop` ) を使い、`gh pr view <PR#> --json reviews,comments,state` 等で状態を polling する。レビューが来ない間は idle、来たら修正コミットを push する。
- `gh pr create` 一発で投げっぱなしにしない。**merge されたことを確認するまでがタスク**。

### 5. コミットメッセージは Conventional Commits 形式
- 必ず `<type>: <要約>` または `<type>(<scope>): <要約>` の形式で書く。
- 使用する type:
  - `feat:` 新機能追加
  - `fix:` バグ修正
  - `refactor:` 機能変更を伴わないリファクタ
  - `docs:` ドキュメントのみ
  - `chore:` ビルド・依存・リリース等の雑務 (`chore(release): bump version to X.Y.Z` 等)
  - `test:` テスト追加・修正
  - `ci:` CI 設定の変更
  - `style:` フォーマット・lint のみ
  - `perf:` パフォーマンス改善
- 破壊的変更は `feat!:` / `fix!:` のように `!` を付ける。
- 例: `fix(canvas): ノード削除時に edge が残るバグを修正`、`chore: bump tauri to 2.x.y`

## アーキテクチャ原則
- Rust 側 (`src-tauri/`): ファイル I/O、git、PTY (portable-pty)、設定永続化、TeamHub、MCP 設定、updater
- レンダラー (`src/renderer/`): UI 描画のみ
- IPC: `@tauri-apps/api/core` の `invoke()` + `listen()`。renderer からは `window.api` 互換層 (`src/renderer/src/lib/tauri-api.ts`) を経由
- 状態管理: React hooks + Context (Settings, Toast) + zustand (canvas / ui)

## 技術スタック
- Tauri 2 + Vite 8 + React 18 + TypeScript 5.6
- Rust 1.85 (tokio, portable-pty, notify, anyhow, serde, encoding_rs, sha2)
- Monaco Editor (diff + エディタ、選択的言語インポート)
- xterm.js + portable-pty (ターミナル)
- @xyflow/react (Canvas)
- zustand (UI / Canvas store)
- lucide-react (アイコン)
- CSS カスタムプロパティベースのテーマシステム (Tailwind 不使用)

## ディレクトリ構成
- `src-tauri/` — Rust 側
  - `src/commands/` — IPC handler (app, git, terminal, settings, dialog, sessions, team_history, files, fs_watch, atomic_write, role_profiles, vibe_team_skill)
  - `src/pty/` — portable-pty + batcher + claude session watcher
  - `src/team_hub/` — マルチエージェント用の socket hub
  - `src/mcp_config/` — MCP サーバー設定 (codex 連携用)
  - `src/util/`, `src/state.rs` — 共通ユーティリティ / グローバル state
- `src/renderer/src/components/` — React コンポーネント (`canvas/`, `settings/`, `shell/`, `overlays/` サブディレクトリあり)
- `src/renderer/src/layouts/` — CanvasLayout など
- `src/renderer/src/stores/` — zustand store (ui, canvas)
- `src/renderer/src/lib/` — ユーティリティ (themes, i18n, commands, settings-context, tauri-api, workspace-presets 等)
- `src/types/shared.ts` — 共有型定義 (TS / Rust 両側で serde が参照)

## コーディング規約
- TypeScript strict mode
- コンポーネントは `src/renderer/src/components/` に配置
- Rust の IPC コマンドは `src-tauri/src/commands/` にまとめる
- 型定義は `src/types/` に集約 (Rust 側は serde で camelCase へマッピング)
- **Glass テーマ対応**: 新規パネル / surface 系コンポーネントのルート要素には `glass-surface` クラスを付与する (Issue #260 PR-3)。Glass テーマ時のみ自動で `backdrop-filter` が当たり、他テーマでは no-op。`tokens.css` 側で完結するので index.css の `[data-theme='glass']` ホワイトリスト追記は不要。
- スタイリング: `src/renderer/src/styles/components/` に機能別 CSS を配置 + CSS 変数でテーマ切替

## よく使うコマンド
- 開発起動: `npm run dev` (= `cargo tauri dev`)
- ビルド: `npm run build` (= `cargo tauri build`)
- 型チェック: `npm run typecheck`
- レンダラーだけ vite で起動: `npm run dev:vite`

## 実装済み機能
- [x] Scaffold + Monaco + ファイルツリー + ファイルエディタ (`EditorView`)
- [x] git diff ビューア (side-by-side/inline 切替、バイナリ検出)
- [x] 変更パネル (`ChangesPanel`)
- [x] ターミナル統合 (xterm.js + portable-pty、複数タブ同時実行)
- [x] セッション履歴 (過去の Claude Code セッション閲覧・再開)
- [x] コマンドパレット (Ctrl+Shift+P、ファジー検索)
- [x] 複数テーマ対応 (claude-dark/light, dark, midnight, light)
- [x] i18n (日本語/英語)
- [x] 情報密度設定 (compact/normal/comfortable)
- [x] 設定モーダル (テーマ、フォント、密度、Claude/Codex オプション、MCP 設定)
- [x] チーム/マルチエージェント機能 (ロールプロファイル: planner/programmer/researcher/reviewer 等)
- [x] 画像ペースト対応 (ターミナルに base64 → temp file → パス挿入)
- [x] 自動アップデート (tauri-plugin-updater 経由、GitHub Releases)
- [x] Canvas モード — @xyflow/react ベースの無限キャンバスに各エージェント/ファイル/git を自由配置
- [x] オンボーディングウィザード (`OnboardingWizard`)
- [x] Notes パネル / Markdown プレビュー
- [x] CP932 / Shift_JIS デコード (Issue #120)
- [x] 外部変更検出 (sha2 ハッシュ + サイズ + mtime, Issue #119)

## キーボードショートカット
| ショートカット | アクション |
|----------------|------------|
| Ctrl+Shift+P | コマンドパレット |
| Ctrl+Shift+M | Canvas / IDE モード切替 (macOS は Cmd+Shift+M も可) |
| Ctrl+, | 設定 |
| Ctrl+Tab | 次のタブ |
| Ctrl+Shift+Tab | 前のタブ |
| Ctrl+W | タブを閉じる |
| Ctrl+Shift+T | 閉じたタブを復元 |

## 注意
- Rust 依存は `src-tauri/Cargo.toml` 管理。`node-pty` 系の `electron-rebuild` は不要
- Monaco Editor は CDN ではなく npm パッケージを使う (選択的インポート)
- 設定は `~/.vibe-editor/settings.json` に永続化される
- セッション履歴は `~/.claude/projects/<encoded-path>/` から読み取る
- `src-tauri/target/` と `src-tauri/gen/schemas/` は gitignore 済み
