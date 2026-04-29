## 実装計画

### ゴール
設定モーダルに「ログ」セクションを追加し、`~/.vibe-editor/logs/vibe-editor.log` の内容 (Rust 側 tracing が出力するエラー / 警告 / IPC ログ) を GUI 上で閲覧できるようにする。最低限「最新行を表示・リフレッシュ・レベルフィルタ・ログフォルダを開く」ができる状態を done とする。

### 影響範囲 / 触るファイル
- `src/types/shared.ts` — `ReadLogTailRequest` / `ReadLogTailResponse` 型を追加 (max_bytes / lines / 取得結果)
- `src-tauri/src/commands/settings.rs` (または新規 `src-tauri/src/commands/logs.rs`) — `read_log_tail` / `open_log_dir` の Tauri コマンドを追加。ログパスは既存の `~/.vibe-editor/logs/vibe-editor.log` を再利用
- `src-tauri/src/commands/mod.rs` — 新規モジュール宣言 (新規ファイルにする場合)
- `src-tauri/src/lib.rs` — `invoke_handler!` に新コマンドを登録
- `src/renderer/src/lib/tauri-api.ts` — `readLogTail` / `openLogDir` ラッパーを追加
- `src/renderer/src/components/settings/LogsSection.tsx` (新規) — ログビューア UI (textarea/pre + フィルタ + リフレッシュ + フォルダを開くボタン)
- `src/renderer/src/components/SettingsModal.tsx` — `SECTION_ICON_TYPES` / `FIXED_LABELS_JA` / `FIXED_LABELS_EN` / `groupsRaw` / `renderSection` の 5 箇所に `logs` を追加
- `src/renderer/src/styles/components/settings.css` (該当ファイル名は実装時に確認) — ログ表示用のモノスペース / 背景 / overflow スタイル
- (任意) `src/renderer/src/lib/i18n.ts` — 「ログ」「リフレッシュ」「レベル」「フォルダを開く」の文言を ja/en で追加

### 実装ステップ
- [ ] Step 1: Rust 側に `read_log_tail(max_bytes: u64) -> { content: String, path: String, truncated: bool }` を実装。ファイル末尾から最大 256KB を UTF-8 lossy で読む (CP932 混入には `encoding_rs` を使うが、tracing 出力は UTF-8 なので通常は不要)
- [ ] Step 2: Rust 側に `open_log_dir()` を実装 — Tauri の `opener` プラグイン (既に依存に入っているか要確認) で `~/.vibe-editor/logs/` をエクスプローラ等で開く
- [ ] Step 3: `tauri-ipc-commands` skill の 5 点同期チェック — `shared.ts` 型 / `commands/<領域>.rs` 構造体 (`#[serde(rename_all = "camelCase")]`) / `mod.rs` モジュール宣言 / `lib.rs` の `invoke_handler!` 登録 / `tauri-api.ts` ラッパー の同期
- [ ] Step 4: `LogsSection.tsx` を作成。最低限の UI は (a) `<pre>` でテール表示、(b) リフレッシュボタン、(c) ログレベル絞り込みセレクト (ALL / ERROR / WARN / INFO)、(d) ログフォルダを開くボタン、(e) ログパス表示
- [ ] Step 5: `SettingsModal.tsx` の 5 箇所に `logs` を追加。アイコンは lucide-react の `FileText` か `ScrollText` を採用。グループは「その他」相当 (既存にあれば流用、無ければ MCP / roles と同じ「チーム」グループに混ぜず別グループ「ログ」を新設するか検討)
- [ ] Step 6: i18n 文言 (ja/en) を `i18n.ts` に追記
- [ ] Step 7: 表示時のサイズ上限 (例: 直近 1000 行) と自動更新 (5 秒ポーリング or 手動のみ) を最終決定して実装。MVP は手動リフレッシュのみで OK
- [ ] Step 8: パフォーマンス確認 — ログが数 MB に成長しても固まらないか (末尾だけ読む実装になっているか)

### 検証方法
- `npm run typecheck` が通る
- `npm run build` が通る (Tauri ビルド)
- `npm run dev` で起動 → 設定モーダル → 「ログ」セクションで `~/.vibe-editor/logs/vibe-editor.log` の末尾が表示される
- リフレッシュボタンで再読込される
- 「フォルダを開く」でエクスプローラ / Finder が開く
- レベルフィルタで ERROR のみ抽出できる
- ログファイルが存在しない / 空のときも例外を出さず空表示になる

### リスク・代替案
- リスク: ログにユーザのファイルパス等 PII が含まれる可能性 → 既に `util/log_redact.rs` でホームディレクトリは `~` に置換済みなので踏襲する。それ以外の機微情報が混入していないかを確認
- リスク: 巨大ログ (数十 MB) を全文読み込むと固まる → 末尾 N バイトのみ読む実装で回避
- 代替案 1: 最初は MVP として「リフレッシュボタン + 末尾 256KB 表示」のみ実装し、自動 tail / 検索 / 追従は後続 issue に切り出す (推奨)
- 代替案 2: `tauri-plugin-log` 導入で Rust→Renderer のリアルタイムストリームを構築する案もあるが、依存追加が大きくなるので今回は見送る

### 想定 PR 構成
- branch: `feat/issue-326-settings-logs-viewer`
- commit 粒度: 2 commit に分割推奨。(1) Rust IPC + 型同期、(2) 設定モーダル UI 追加 + i18n
- PR title 案: `feat(settings): #326 設定モーダルにログビューアセクションを追加`
- 本文に `Closes #326` を含める
