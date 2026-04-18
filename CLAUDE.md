# vibe-editor

Tauri ベースの Claude Code / Codex 専用エディタ (v1.1.x)

## アーキテクチャ原則
- Rust 側 (src-tauri/): ファイル I/O、git 操作、PTY (portable-pty)、設定永続化、TeamHub、updater
- レンダラー (src/renderer/): UI 描画のみ
- IPC: `@tauri-apps/api/core` の `invoke()` + `listen()`。renderer からは `window.api` 互換層 (`src/renderer/src/lib/tauri-api.ts`) を経由
- 状態管理: React hooks + Context (Settings, Toast) + zustand (canvas / ui)

## 技術スタック
- Tauri 2 + Vite 5 + React 18 + TypeScript 5.6
- Rust (tokio, portable-pty, notify, anyhow, serde)
- Monaco Editor (diff 表示、27 言語対応)
- xterm.js + portable-pty (ターミナル)
- @xyflow/react (Canvas)
- zustand (UI / Canvas store)
- lucide-react (アイコン)
- CSS カスタムプロパティベースのテーマシステム (Tailwind 不使用)

## ディレクトリ構成
- `src-tauri/` — Rust 側 (Tauri main + commands + pty + team_hub + updater)
  - `src/commands/` — IPC handler (app, git, terminal, settings, dialog, sessions, team_history, files)
  - `src/pty/` — portable-pty + batcher + claude session watcher
  - `src/team_hub/` — マルチエージェント用の socket hub
- `src/renderer/src/components/` — React コンポーネント
- `src/renderer/src/components/canvas/` — Canvas モード専用コンポーネント
- `src/renderer/src/layouts/` — CanvasLayout など
- `src/renderer/src/stores/` — zustand store (ui, canvas)
- `src/renderer/src/lib/` — ユーティリティ (themes, i18n, commands, settings-context, tauri-api, workspace-presets 等)
- `src/types/shared.ts` — 共有型定義 (TS / Rust 両側で serde が参照)

## コーディング規約
- TypeScript strict mode
- コンポーネントは `src/renderer/src/components/` に配置
- Rust の IPC コマンドは `src-tauri/src/commands/` にまとめる
- 型定義は `src/types/` に集約 (Rust 側は serde で camelCase へマッピング)
- スタイリング: `src/renderer/src/styles/components/` に機能別 CSS を配置 + CSS 変数でテーマ切替

## よく使うコマンド
- 開発起動: `npm run dev` (= `cargo tauri dev`)
- ビルド: `npm run build` (= `cargo tauri build`)
- 型チェック: `npm run typecheck`
- レンダラーだけ vite で起動: `npm run dev:vite`

## 実装済み機能
- [x] Scaffold + Monaco + ファイルツリー
- [x] git diff ビューア (side-by-side/inline 切替、バイナリ検出)
- [x] ターミナル統合 (xterm.js + portable-pty、最大 10 タブ同時実行)
- [x] セッション履歴 (過去の Claude Code セッション閲覧・再開)
- [x] コマンドパレット (Ctrl+Shift+P、ファジー検索)
- [x] 5 テーマ対応 (claude-dark/light, dark, midnight, light)
- [x] i18n (日本語/英語)
- [x] 情報密度設定 (compact/normal/comfortable)
- [x] 設定モーダル (テーマ、フォント、密度、Claude/Codex オプション)
- [x] チーム/マルチエージェント機能 (ロール: planner/programmer/researcher/reviewer)
- [x] 画像ペースト対応 (ターミナルに base64 → temp file → パス挿入)
- [x] 自動アップデート (tauri-plugin-updater 経由、GitHub Releases)
- [x] Canvas モード — @xyflow/react ベースの無限キャンバスに各エージェント/ファイル/git を自由配置
- [x] Linear/Raycast 風デザイン (薄ボーダー + 左端色バー、フラット shadow)

## 未実装 / 今後の予定
- [ ] CLAUDE.md 管理 UI (テンプレート、スキル切り替え)
- [ ] Claude Code のトークン使用量可視化
- [ ] ファイルエディタ (現在は diff viewer のみ)

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
- Monaco Editor は CDN ではなく npm パッケージを使う (選択的インポートで 27 言語のみ)
- 設定は `~/.vibe-editor/settings.json` に永続化される
- セッション履歴は `~/.claude/projects/<encoded-path>/` から読み取る
- `src-tauri/target/` と `src-tauri/gen/schemas/` は gitignore 済み
