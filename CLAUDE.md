# vibe-editor

Electronベースの Claude Code / Codex 専用エディタ (v1.2.x)

## アーキテクチャ原則
- メインプロセス: ファイルI/O、git操作、node-pty、設定永続化のみ
- レンダラー: UI描画のみ。Node.jsモジュールを直接importしない
- IPC通信: contextBridgeを必ず経由する（src/preload/index.ts）
- 状態管理: React hooks + Context (Settings, Toast)

## 技術スタック
- Electron 33 + Vite 5 + React 18 + TypeScript 5.6
- Monaco Editor (diff表示、27言語対応)
- xterm.js + node-pty (ターミナル)
- lucide-react (アイコン)
- electron-updater (自動アップデート)
- CSS カスタムプロパティベースのテーマシステム（Tailwind不使用）

## ディレクトリ構成
- `src/main/` — メインプロセス（index.ts + ipc/）
- `src/main/ipc/` — IPCハンドラ (app, git, terminal, settings, dialog, sessions)
- `src/preload/` — contextBridge API定義
- `src/renderer/src/components/` — Reactコンポーネント (14個)
- `src/renderer/src/lib/` — ユーティリティ (themes, i18n, commands, settings-context等)
- `src/types/shared.ts` — 共有型定義

## コーディング規約
- TypeScript strict mode
- コンポーネントは src/renderer/src/components/ に配置
- IPCハンドラは src/main/ipc/ にまとめる
- 型定義は src/types/ に集約
- スタイリング: 単一CSSファイル (index.css) + CSS変数によるテーマ切替

## よく使うコマンド
- 開発起動: `npm run dev`
- ビルド: `npm run build`
- パッケージング: `npm run dist:win`
- 型チェック: `npm run typecheck`

## 実装済み機能
- [x] Scaffold + Monaco + ファイルツリー
- [x] git diff ビューア（side-by-side/inline切替、バイナリ検出）
- [x] ターミナル統合（xterm.js + node-pty、最大10タブ同時実行）
- [x] セッション履歴（過去のClaude Codeセッション閲覧・再開）
- [x] コマンドパレット（Ctrl+Shift+P、ファジー検索）
- [x] 5テーマ対応（claude-dark/light, dark, midnight, light）
- [x] i18n（日本語/英語）
- [x] 情報密度設定（compact/normal/comfortable）
- [x] 設定モーダル（テーマ、フォント、密度、Claude/Codexオプション）
- [x] チーム/マルチエージェント機能（ロール: planner/programmer/researcher/reviewer）
- [x] 画像ペース���対応（ターミナルにbase64→temp file→パス挿入）
- [x] 自動アップデート（GitHub Releases）
- [x] Linear/Notion風デザイン（ノイズオーバーレイ、スプリングアニメーション、レイヤードシャドウ）

## 未実装 / 今後の予定
- [ ] CLAUDE.md管理UI（テンプレート、スキル切り替え）
- [ ] Claude Codeのトークン使用量可視化
- [ ] ファイルエディタ（現在はdiff viewerのみ）

## キーボードショートカット
| ショートカット | アクション |
|----------------|------------|
| Ctrl+Shift+P | コマンドパレット |
| Ctrl+, | 設定 |
| Ctrl+Tab | 次のタブ |
| Ctrl+Shift+Tab | 前のタブ |
| Ctrl+W | タブを閉じる |
| Ctrl+Shift+T | 閉じたタブを復元 |

## 注意
- node-ptyはnativeモジュールなので electron-rebuild を忘れずに
- Monaco EditorはCDNではなくnpmパッケージを使う（選択的インポートで27言語のみ）
- 設定は `~/.vibe-editor/settings.json` に永続化される
- セッション履歴は `~/.claude/projects/<encoded-path>/` から読み取る