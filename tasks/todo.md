# vibe-editor Tauri ハイブリッド移行 + 無限キャンバス UI 革新 TODO

## ステータスマスコット スプライト追加 (完了)

計画: `tasks/mascot-sprite-plan.md`

- [x] 既存 StatusBar / terminal 状態 / テーマ CSS を調査
- [x] 実装前計画と Next Steps を記録
- [x] ユーザー確認を受ける
- [x] GitHub Issue 作成 (`enhancement`, `ui`) と `feature/issue-XXX` ブランチ作成
- [x] 6 パターンの inline SVG sprite sheet を持つ `StatusMascot` を追加
- [x] 状態導出を `App.tsx` から `StatusBar` へ接続
- [x] CSS でテーマ追従、状態別アニメーション、reduced motion を実装
- [x] i18n tooltip / aria ラベルを追加
- [x] `npm run typecheck` / `npm run test` / `npm run dev` UI 表示確認
- [x] 実装後レビュー観点と検証結果を記録

検証結果:
- `npm run typecheck`: 成功
- `npx vitest run src/renderer/src/lib/__tests__/status-mascot.test.ts`: 6 tests 成功
- `npm run test`: 12 files / 83 tests 成功
- `npm run dev`: Tauri dev profile build 成功、`target\debug\vibe-editor.exe` 起動、ネイティブウィンドウでステータスマスコット表示を確認
- `npm run build:vite`: 成功。既存の大きい chunk / dynamic import warning のみ

承認済みプラン: `C:\Users\yusei\.claude\plans\concurrent-wobbling-bunny.md`

## Phase 0 — 意思決定スパイク (1〜2週)

### 前提
- [x] **Rust toolchain インストール** (winget `Rustlang.Rustup` → rustc 1.95.0)
- [x] **Tauri CLI インストール** (`cargo install tauri-cli` → cargo-tauri v2.10.1)
- [x] `experiments/` 配下に PoC 用サブプロジェクト 5 つを作成

### ADR (5 件、並列実行可)
- [x] **ADR-1: PTY** — `experiments/pty-poc/` portable-pty + tokio batcher 動作確認 (ConPTY [6n 出力検証)
- [x] **ADR-2: Canvas** — `experiments/react-flow-load/` 20 nodes × xterm 描画成功、http://localhost:5180 で目視確認
- [x] **ADR-3: TeamHub** — `experiments/team-hub-rust/` tokio TCP listener + 64B/15ms inject 動作確認
- [x] **ADR-4: Updater** — 設定スキーマ確定、本番検証は Phase 1 完了時のプレリリースで
- [x] **ADR-5: Bundler** — tauri.conf.json スキーマ確定、本番検証は Phase 1 統合時

### 完了条件
- [x] `tasks/adr-1-pty.md` 〜 `tasks/adr-5-bundler.md` 5 件確定
- [x] 技術選定変更なし

---

## Phase 1 — Tauri シェル移行 (3〜5週)

### セットアップ
- [x] 手動 `src-tauri/` scaffold (cargo tauri init は使わず、より制御的に)
- [x] `tauri.conf.json` (NSIS/updater/tray/single-instance/window 設定)
- [x] `Cargo.toml` 依存追加 (portable-pty, tokio, serde, notify, dirs, which, whoami, base64, chrono, uuid, once_cell)

### IPC 移植 (8 モジュール — 並列可)
- [x] `commands/app.rs` (13 commands; checkClaude/openExternal/getUserInfo 実装。team_mcp 系は Phase 1 後半 stub)
- [x] `commands/git.rs` (status/diff フル実装、git バイナリ呼び出し)
- [x] `commands/files.rs` (list/read/write フル実装、safe_join でパス検証)
- [x] `commands/sessions.rs` (~/.claude/projects 列挙、jsonl summary 抽出)
- [x] `commands/settings.rs` (~/.vibe-editor/settings.json 読み書き)
- [x] `commands/team_history.rs` (Mutex 排他制御、最新 20 件 trim)
- [x] `commands/dialog.rs` (tauri-plugin-dialog ラッパ + isFolderEmpty)
- [x] `commands/terminal.rs` (**stub** — Phase 1 後半で portable-pty 実装)

### コア機能 (Phase 1 後半)
- [x] `pty/` モジュール **完全動作**
  - `session.rs` — portable-pty + `which::which` で PATHEXT 解決 + tokio batcher + exit watcher
  - `registry.rs` — Arc<HashMap<id, SessionHandle>> + agent_id 二次 index (TeamHub 用)
  - `batcher.rs` — 16ms / 32KB flush + tauri::Emitter
  - `commands/terminal.rs` 実装 (terminal_create/write/resize/kill 動作確認、claude spawn 成功)
  - `capabilities/default.json` 追加で **renderer の event listen 権限** を有効化 → xterm に Claude バナー描画成功
  - チーム所属端末は `VIVE_TEAM_SOCKET/TOKEN/ID/ROLE/AGENT_ID` を env 注入
  - **残課題 (Phase 2 以降)**: claude_watcher (~/.claude/projects 監視)、resolve-command の完全移植、codex 用 model_instructions_file
- [x] `team_hub/` モジュール **完全動作**
  - `mod.rs` — TeamHub struct + TCP listener + ハンドシェイク (token-based)
  - `inject.rs` — 64B/15ms チャンク注入 + UTF-8 境界尊重 + 4KB トランケート + 改行整形
  - `protocol.rs` — JSON-RPC 7 ツール (team_send/read/info/status/assign_task/get_tasks/update_task)
  - `bridge.rs` — team-bridge.js ソースを Rust binary に同梱 (旧 BRIDGE_SOURCE 等価)
  - app start で常時起動、`~/.vibe-editor/team-bridge.js` に書き出し
  - 動作確認: `[teamhub] client authed` で claude bridge が接続成功
- [x] `mcp_config/` モジュール **完全動作**
  - `claude.rs` — `~/.claude.json mcpServers["vive-team"]` の差分マージ + cleanup
  - `codex.rs` — `~/.codex/config.toml [mcp_servers.vive-team]` セクション編集 + remove_toml_section
  - `mod.rs` — bridge_desired (Claude/Codex 共通エントリ生成)
  - `app_setup_team_mcp` / `app_cleanup_team_mcp` から実呼び出し
- [ ] `paste_image_store.rs` (terminal_save_pasted_image 強化)

### Frontend 適応
- [x] `src/renderer/src/lib/tauri-api.ts` (window.api 互換層、自動 bootstrap 含む)
- [x] `src/renderer/src/main.tsx` 先頭で tauri-api.ts を import
- [x] `vite.config.ts` (renderer のみ、Tauri 用)
- [x] `package.json` script 追加 (dev:vite/build:vite/dev:tauri/build:tauri)

### Updater
- [ ] `tauri-plugin-updater` 設定 + GitHub Releases 連携 (現状 active=false)
- [ ] プログレス UI
- [ ] 公開鍵生成 + GitHub Actions Secrets 投入

### 削除 (Phase 1 完全移行時)
- [ ] `src/main/**/*` (現状並存)
- [ ] `src/preload/index.ts` (現状並存)
- [ ] `electron.vite.config.ts` (現状並存)
- [ ] electron-builder 関連設定 (現状並存)

### 完了条件
- [x] cargo build 成功 (dev profile, 23 秒)
- [x] cargo tauri dev で WebView2 ウィンドウ起動 (5 process / 50〜180MB)
- [ ] 既存 e2e シナリオ全通過 (terminal/git/file/team/handoff/updater)
- [ ] インストーラ 30MB 以下、起動 < 500ms

---

## Phase 2 — 無限キャンバス基盤 (2〜3週)

### MVP 実装完了 (2026-04-17)
- [x] **Zustand 導入**: `stores/{ui,canvas}.ts` の最小 2 ストアから着手 (App.tsx 完全分割は Phase 3 で)
- [x] `layouts/CanvasLayout.tsx` 新規 (Canvas モード専用 Toolbar + Canvas)
- [x] `components/canvas/Canvas.tsx` (ReactFlowProvider + MiniMap + Background + Controls)
- [x] `components/canvas/CardFrame.tsx` 共通フレーム (header + close + accent)
- [x] `components/canvas/cards/TerminalCard.tsx` (TerminalView 埋め込み + handles)
- [x] `Toolbar.tsx` モードトグル追加 (LayoutGrid icon)
- [x] `main.tsx` で viewMode dispatch (Root component で IDE/Canvas 切替)
- [x] 座標永続化 (`stores/canvas.ts` の persist middleware)
- [ ] DnD: Sidebar → Canvas で Card 自動配置 (Phase 3 で)
- [ ] EditorCard / DiffCard / FileTreeCard / ChangesCard (Phase 3 で)
- [ ] App.tsx 完全分割 → 800行目標 (Phase 3 で)

### 完了条件
- [x] IDE モード現行と pixel-perfect 一致 (ToolBar に新規ボタン 1 個追加のみ)
- [x] Canvas モードで pan/zoom/移動/リサイズ動作 (React Flow 標準)
- [x] 再起動で Card 座標復元 (zustand persist + localStorage)
- [x] Card 追加で TerminalCard が描画 + connection handles + minimap 反映

### Phase 2 MVP レビュー (2026-04-17)

**実装ファイル (新規 7)**
- `src/renderer/src/stores/{ui,canvas}.ts` — Zustand ストア (persist 込み)
- `src/renderer/src/layouts/CanvasLayout.tsx` — Canvas モードルート
- `src/renderer/src/components/canvas/Canvas.tsx` — React Flow ラッパ
- `src/renderer/src/components/canvas/CardFrame.tsx` — Card 共通枠
- `src/renderer/src/components/canvas/cards/TerminalCard.tsx` — TerminalView 埋め込み

**修正ファイル (3)**
- `src/renderer/src/components/Toolbar.tsx` — Canvas トグル追加
- `src/renderer/src/main.tsx` — Root component で viewMode dispatch
- `package.json` — zustand + @xyflow/react

**動作検証 (Playwright で確認)**
- ✅ IDE モード: 既存レイアウト無傷、Toolbar に LayoutGrid アイコン追加
- ✅ Canvas モード切替: クリックで `<CanvasLayout/>` に瞬時切替
- ✅ Canvas 表示: header (Canvas / 0 cards / IDE 戻るボタン) + 無限キャンバス + + Terminal FAB + Controls (zoom) + ミニマップ
- ✅ + Terminal クリック: `Claude #1` Card が中央に配置、紫● handles + ミニマップ反映

**残課題 (Phase 3 候補)**
- DnD ファイルツリー → Canvas
- Editor / Diff / FileTree / Changes Card
- AgentNodeCard (ロール別カラー、Phase 3 主役)
- HandoffEdge (team_send 矢印アニメ)
- App.tsx を stores/{workspace,terminals,teams} に解体

---

## Phase 3 — マルチエージェント空間化 (3〜4週)

### MVP 実装完了 (2026-04-17)
- [x] `lib/team-roles.ts` ROLE_META + colorOf/metaOf (5 ロール、color/accent/glyph/description)
- [x] `components/canvas/cards/AgentNodeCard.tsx` (ロール別 accent 枠線・アバター円・ヘッダグラデ・接続点)
- [x] `src-tauri/src/team_hub/protocol.rs` で team_send 時に `team:handoff` event emit
   - payload: `{teamId, fromAgentId, fromRole, toAgentId, toRole, preview, messageId, timestamp}`
- [x] `components/canvas/HandoffEdge.tsx` (bezier path + dashed flow animation + label)
- [x] `lib/workspace-presets.ts` (Bug Fix 4-agents / Feature Dev 5-agents / Code Review 3-agents)
- [x] CanvasLayout に "Spawn Team" ボタン + dropdown (preset selector)
- [x] MiniMap nodeColor をロール色で動的決定
- [x] `stores/canvas.ts` に addCards/pulseEdge/agent type 追加 (一括投入 + 一時 edge 1.5秒 fade)
- [ ] CommandPalette 拡張 → Quick Nav (Ctrl+Shift+K) (Phase 4 へ繰越)
- [ ] AgentNodeCard ステータスバッジ (idle/thinking/typing) 詳細実装 (Phase 4 へ)

### 完了条件
- [x] preset 起動 → AgentNode 配置 (Bug Fix で 4 Card が 2x2 配置確認)
- [x] handoff event emit 動作 (Rust 側コード実装 + emit パス確認、実テストは Tauri で)
- [ ] Quick Nav で agent ジャンプ (Phase 4 へ繰越)

### Phase 3 MVP レビュー (2026-04-17)

**実装ファイル (新規 5)**
- `src/renderer/src/lib/team-roles.ts` (ROLE_META 定数 + ヘルパ)
- `src/renderer/src/lib/workspace-presets.ts` (3 builtin presets)
- `src/renderer/src/components/canvas/cards/AgentNodeCard.tsx` (ロール別装飾 Card)
- `src/renderer/src/components/canvas/HandoffEdge.tsx` (粒子 flow edge + label)

**修正ファイル (4)**
- `src-tauri/src/team_hub/{mod,protocol}.rs` — AppHandle 注入 + team_send で event emit
- `src-tauri/src/lib.rs` — setup で hub.set_app_handle
- `src/renderer/src/stores/canvas.ts` — addCards/pulseEdge/agent type 拡張
- `src/renderer/src/components/canvas/Canvas.tsx` — agent nodeType + handoff edgeType + listen('team:handoff')
- `src/renderer/src/layouts/CanvasLayout.tsx` — Spawn Team ボタン + preset dropdown

**動作検証 (Playwright)**
- ✅ Spawn Team ドロップダウン: 3 preset + ロールカラー アバター列表示
- ✅ Bug Fix クリック: 4 AgentNodeCard が 2×2 配置 (Leader 紫 / Researcher 黄 / Programmer 緑 / Reviewer 赤)
- ✅ 各 Card: ロール色枠 + アバター + ヘッダーグラデ + 接続点
- ✅ ミニマップ: 4 色 Card プレビュー反映
- ⏭ handoff edge アニメ実機確認は Tauri で claude → MCP tool 呼び出しが必要 (テストシナリオ Phase 4)

---

## Phase 4 — 仕上げ (2〜3週)

### MVP 実装完了 (2026-04-17)
- [x] `lib/keybindings.ts` (Ctrl+Shift+K Quick Nav / Ctrl+Shift+I IDE / Ctrl+Shift+M Canvas / Ctrl+Shift+N New Terminal)
- [x] `components/canvas/QuickNav.tsx` Quick Nav パレット (fuzzy 検索 + ↑↓ navigate + Enter jump + Esc close + role icon avatar)
- [x] AgentNodeCard ステータスバッジ (idle/thinking/typing) — onActivity → 600ms idle 復帰 + typing パルスアニメ
- [x] React Flow `onlyRenderVisibleElements` 有効化 (基本仮想化)
- [x] Spatial memory: zustand persist で nodes + viewport が `vibe-editor:canvas` localStorage に保存 (Phase 2 から既存)

### Phase 5 着手 (2026-04-17 同日続行)
- [x] **claude_watcher (Phase 1 残課題)**: `src-tauri/src/pty/claude_watcher.rs` 実装。`~/.claude/projects/<encoded>/*.jsonl` 監視 (notify crate)、新規 jsonl 出現で `terminal:sessionId:{id}` event emit。terminal_create で claude spawn 時に自動起動。
- [x] **team-history.json `canvasState` 拡張**: TeamHistoryEntry に `canvasState?: { nodes, viewport }` 追加 (Rust + TS 両側、後方互換 optional)。
- [x] **CanvasLayout に Recent タブ**: Spawn Team ドロップダウン内 Preset / Recent タブ切替。Recent はカードごとにロール色アバター + last used 時刻。
- [x] **Auto save**: Canvas 上の AgentNode 群を 800ms debounce で `teamHistory.save` に同期。teamId 単位で集約。
- [x] **Restore**: Recent クリックで保存済み配置 + setupTeamMcp 自動再呼び出し。

### 残 (Phase 6 候補)
- [ ] `components/canvas/TimelineRail.tsx` (jsonl 時系列スクラブ)
- [ ] xterm pause/resume + active 上限 6 + ProxyImage Card (高度な仮想化)
- [ ] Rust 側 per-card subscribe / unsubscribe (パフォーマンス最適化)
- [ ] Updater pubkey 生成 + `tauri.conf.json` の `updater.active` を true 化
- [ ] Electron 残骸 (src/main, src/preload, electron.vite.config.ts) を本番デプロイ前に削除

## Phase 6 (Horizon 互換 / 自由配置 Card) — 2026-04-17 完了

**ユーザー要求**: 「無限の作業スペースに好きにタブを置けるみたいなやつ」

**新規ファイル 4** (Card 型を全部揃える):
- `cards/EditorCard.tsx` — Monaco Editor + files.read/write + dirty 管理 + Ctrl+S
- `cards/DiffCard.tsx` — Monaco DiffEditor + git.diff + sideBySide toggle
- `cards/FileTreeCard.tsx` — FileTreePanel ラップ、ファイル click → EditorCard 自動配置
- `cards/ChangesCard.tsx` — ChangesPanel ラップ、diff click → DiffCard 自動配置

**Canvas.tsx**: nodeTypes に `editor / diff / fileTree / changes` 4 種追加

**CanvasLayout.tsx**: 新規 `+ Add Card` ドロップダウン
- Terminal / File Tree / Git Changes / Editor (empty) を選択して即配置
- accent カラーで Card 種別が区別 (紫=editor, オレンジ=diff, 水色=fileTree, 赤=changes)

**動作確認 (Playwright)**:
- ✅ `+ Add Card` ボタン表示
- ✅ ドロップダウンに 4 種 (Terminal/File Tree/Git Changes/Editor)
- ✅ File Tree + Git Changes を 2 枚配置 → Canvas 上に共存 (異種 Card)
- ✅ ChangesCard はロード中スケルトン (動作中)
- ✅ ミニマップに 2 Card プレビュー反映
- ✅ 各 Card 種別で accent 色が違う (Card 視覚区別)

**Card 連携フロー**:
1. FileTreeCard でファイルクリック → 右隣に EditorCard が自動配置
2. ChangesCard で diff クリック → 右隣に DiffCard が自動配置
3. AgentNodeCard 起動中 → handoff 矢印アニメ (Phase 3)
4. Quick Nav (Ctrl+Shift+K) で全 Card 検索ジャンプ (Phase 4)

### 完了条件
- [x] Quick Nav (Ctrl+Shift+K) で agent ジャンプ動作
- [x] AgentNode に IDLE/TYPING バッジ表示
- [x] React Flow 仮想化有効
- [x] Canvas 配置 localStorage 永続化 (再起動で nodes/viewport 復元)
- [ ] 50 terminal + 20 editor で 60fps 維持 (高度仮想化は Phase 5)
- [ ] タイムラインスクラブで過去状態再現 (Phase 5)

### Phase 5 (Spatial Memory + claude_watcher) レビュー (2026-04-17)

**実装ファイル (新規 1)**
- `src-tauri/src/pty/claude_watcher.rs` (notify crate で jsonl 監視 + sessionId emit)

**修正ファイル (4)**
- `src-tauri/src/pty/mod.rs` — claude_watcher mod 追加
- `src-tauri/src/commands/terminal.rs` — claude spawn 時に watcher 自動起動
- `src-tauri/src/commands/team_history.rs` — TeamCanvasNode/Viewport/State 型追加 + TeamHistoryEntry に canvasState
- `src/types/shared.ts` — TeamHistoryEntry / TeamCanvasNode / TeamCanvasState 拡張
- `src/renderer/src/layouts/CanvasLayout.tsx` — Preset/Recent タブ切替 + auto save (800ms debounce) + restore handler

**動作検証**
- ✅ Recent タブ表示 (空状態メッセージ付き)
- ✅ Preset/Recent タブ切替 active 状態
- ✅ Rust 側 cargo build 成功 (notify, serde 全て OK)
- ✅ team-history.json 後方互換 (canvasState は #[serde(default, skip_serializing_if = ...)] でなしエントリも読める)

### Phase 4 MVP レビュー (2026-04-17)

**実装ファイル (新規 2)**
- `src/renderer/src/lib/keybindings.ts` (useKeybinding hook + KEYS 定数)
- `src/renderer/src/components/canvas/QuickNav.tsx` (fuzzy 検索パレット)

**修正ファイル (2)**
- `Canvas.tsx` — onlyRenderVisibleElements + useKeybinding (4 binding) + QuickNav 統合
- `cards/AgentNodeCard.tsx` — StatusBadge (idle/thinking/typing) + onActivity → typing 検出 + 600ms idle 復帰タイマ

**動作検証 (Playwright)**
- ✅ Bug Fix preset → 4 AgentCards 配置
- ✅ Ctrl+Shift+K → QuickNav パレット表示 ("Jump to agent / card …")
- ✅ 4 ロール色アバター付きアイテムリスト + フッターガイド (↑↓/Enter/Esc)
- ✅ 各 AgentCard ヘッダ右に "IDLE" バッジ
- ✅ React Flow 仮想化 (onlyRenderVisibleElements) 有効、viewport 外 node は描画スキップ

---

## レビューセクション (各 Phase 完了後に追記)

### Phase 0 レビュー (2026-04-17)

**実施内容**
- Rust 1.95.0 + cargo-tauri v2.10.1 を winget 経由でインストール
- experiments/ 配下に 5 PoC を scaffold + 3 PoC を実装/検証
- ADR 5 件を `tasks/adr-1-pty.md`〜`adr-5-bundler.md` として確定

**検証結果**
| ADR | 結果 | 備考 |
|---|---|---|
| 1 PTY | ✅ portable-pty 0.9 + tokio batcher 動作、ConPTY 起動確認 | EOF 伝搬は Phase 1 で master drop 順序を厳密化 |
| 2 Canvas | ✅ 20 ノード描画、@xyflow/react 採用確定 | FPS 実測は実ブラウザで再評価必要 |
| 3 TeamHub | ✅ tokio TCP + 64B/15ms inject 動作、PowerShell smoke test pass | 長メッセージのチャンク分割は Phase 1 で再検証 |
| 4 Updater | ✅ 設計確定 | プレリリース v0.1.0-tauri-alpha で本番検証 |
| 5 Bundler | ✅ 設計確定 | Phase 1 完了時に `cargo tauri build --bundles nsis` 検証 |

**ADR からの主要決定事項**
- PTY: portable-pty 0.9 + tokio multi-thread + 16ms/32KB batcher
- Canvas: @xyflow/react v12 + xterm DOM 埋め込み + onlyRenderVisibleElements 仮想化
- TeamHub: tokio::net + serde JSON line protocol + 64B/15ms inject
- Updater: tauri-plugin-updater v2 + GitHub Releases + 専用 keypair
- Bundler: Tauri 2 NSIS bundler + tauri-plugin-single-instance + カスタム NSIS template

**技術選定変更なし** → Phase 1 着手可能

### Phase 1 後半 全 Step 完了レビュー (2026-04-17)

**完了範囲**
- Step 1: PTY (portable-pty + 16ms batcher + capabilities)
- Step 2: TeamHub (tokio TCP + 7 MCP tools + 64B/15ms inject + bridge.js 同梱)
- Step 3: MCP config (Claude .claude.json / Codex .codex/config.toml の差分マージ)

**実装ファイル (新規)**
- `src-tauri/src/team_hub/{mod,inject,protocol,bridge}.rs` (4 ファイル)
- `src-tauri/src/mcp_config/{mod,claude,codex}.rs` (3 ファイル)
- `src-tauri/capabilities/default.json` (renderer 権限)

**動作確認**
- ✅ Tauri 起動時に TeamHub が `127.0.0.1:<random_port>` で listen 開始 (`[teamhub] listening on 127.0.0.1:NNNN`)
- ✅ `~/.vibe-editor/team-bridge.js` を自動生成
- ✅ Claude Code が起動すると bridge を spawn し TeamHub に TCP 接続 → `[teamhub] client authed` ログ
- ✅ ハンドシェイクトークン (24-byte hex) で認証
- ✅ JSON-RPC tools/list で 7 ツール返答可能

**Cargo deps 追加**
- `rand = "0.8"` (token 生成用)

**全 Phase 1 完了 — 次は Phase 2 (Zustand 化 + 無限キャンバス基盤)**

### Phase 1 後半 Step 1 完了レビュー (2026-04-17)

**実施内容**
- `src-tauri/src/pty/{mod,session,registry,batcher}.rs` 作成 (新規 4 ファイル)
- `state.rs` に `pty_registry: Arc<SessionRegistry>` 追加
- `lib.rs` に `mod pty;` 追加、setup で DevTools 自動オープン (debug)、RUST_LOG デフォルトを debug に
- `commands/terminal.rs` を stub から実装に切替 (4 commands + savePastedImage)
- `which::which` で Windows PATHEXT 解決 (`claude` → `claude.cmd`)
- **`src-tauri/capabilities/default.json` 追加** — renderer 側 event listen を許可

**動作確認**
- ✅ Claude Code v2.1.112 が Tauri 内 xterm で完全描画
- ✅ ANSI カラー、ボックス文字、Unicode 全て正常
- ✅ Rust 側 batcher が継続的にデータ emit (4B → 294B → 1500B → 2813B 等)
- ✅ Renderer 側 listen で受信 → xterm に書き込み成功

**真因**:
1. `claude` → `claude.cmd` の PATH 解決を Win32 `CreateProcessW` がサポートしない → `which::which` で解決
2. Tauri 2 のデフォルト capabilities では renderer 側 event listen が許可されない → `capabilities/default.json` で `core:event:default` 等を明示

**次セッション TODO (Phase 1 後半 Step 2/3)**
1. team_hub/ モジュール (TeamHub Rust 化)
2. mcp_config/ モジュール (claude.json / config.toml 操作)
3. claude_watcher (~/.claude/projects/<encoded>/*.jsonl 監視)
4. updater pubkey 生成 + active 化

### Phase 1 前半 レビュー (2026-04-17)

**実施内容**
- src-tauri/ 完全 scaffold (Cargo.toml + tauri.conf.json + main.rs + lib.rs + state.rs)
- 8 commands モジュール全てに #[tauri::command] 関数定義 (camelCase serde 互換)
- src/renderer/src/lib/tauri-api.ts (window.api 互換層 + 自動 bootstrap)
- vite.config.ts (Tauri 用 renderer-only)
- package.json に dev:vite/build:vite/dev:tauri/build:tauri 追加
- @tauri-apps/api + 5 plugins (dialog/opener/process/shell/updater) を npm install
- src-tauri/icons/ にアイコン配置 (build/icon.* から copy)
- Electron との並存運用 (src/main, src/preload は残置)

**検証結果**
- ✅ cargo build 成功 (23 秒、dev profile)
- ✅ cargo tauri dev → vite (657ms) + Tauri build (30s) → WebView2 起動
- ✅ vibe-editor.exe 5 プロセス、メモリ 50〜180MB (Electron 200〜500MB 比 大幅減)
- ⚠️ terminal_* 系は stub のまま (Phase 1 後半で portable-pty 統合)
- ⚠️ team_mcp / team_hub_info も stub (Phase 1 後半)
- ⚠️ MCP config 操作 (claude-mcp.ts / codex-mcp.ts) 未移植

**主要決定**
- 並存運用方針: dev (Electron) / dev:tauri (Tauri) を共存、Phase 1 完了時に Electron 削除
- frontendDist は dist/ プレースホルダで cargo build を通せる
- IPC 命名: TS の `app:getProjectRoot` → Rust の `app_get_project_root` (snake_case)
- camelCase JSON 互換は `#[serde(rename_all = "camelCase")]` で自動

**次セッション TODO (Phase 1 後半)**
1. terminal.rs に portable-pty + session_registry + batcher 統合
2. team_hub/ モジュール追加 (PoC コードを移植)
3. mcp_config/ モジュール追加
4. tauri-plugin-updater pubkey 生成 + active 化
5. e2e シナリオ手動検証 + Electron 削除

### Phase 2 レビュー
_(未着手)_

### Phase 3 レビュー
_(未着手)_

### Phase 4 レビュー
_(未着手)_

### Issue #353 ステータスマスコット調整レビュー (2026-05-01)

**実施内容**
- 22px 拡大時にスプライトシート本体とフレーム移動量が 16px 固定だった問題を修正。
- マスコットを 32px の整数スケールにし、`--shell-status` を 40px に広げて崩れを防止。
- `status__mascot-track` を追加し、状態別に横移動アニメーションを設定。
- `running` はトラック幅いっぱいを左右に往復、`dirty` / `reviewing` は中距離、`editing` は短距離で移動。

**検証結果**
- ✅ `npm run typecheck`
- ✅ `npx vitest run src/renderer/src/lib/__tests__/status-mascot.test.ts`
- ✅ `git diff --check`
- ✅ `npm run build:vite`

**Next Tasks**
- 実機で動きが強すぎる場合は `--mascot-track-width` と animation duration を微調整する。

---

## Issue #342 最終実装計画 v2 実施

### 計画
- [x] `origin/main` を最新化し、既存 Phase 1/3 実装の有無を確認する
- [x] `feature/issue-342` ブランチで作業する
- [x] `TeamMessage` に送信時解決済み recipient を保持し、`team_read` を recipient ベース判定へ変更する
- [x] pending recruit の handshake で `team_id` 一致を検証する
- [x] v2 で求められた fail-fast 経路が最新 Phase 1 実装で満たされているか確認し、不足があれば補う
- [x] `cargo check` / `cargo build` / `npm run typecheck` / `npm run build:vite` / `cargo test team_hub` で検証する

### Next Steps
- 実装差分をレビューし、手動 smoke で worker -> leader の送受信と dismiss -> re-recruit の挙動を確認する

### 進捗
- 最新 `origin/main` は `36a87da` で、Phase 1/3 の recruit ack fail-fast 実装が投入済みだったため、renderer 側の追加変更は不要と判断した
- `TeamMessage.recipient_agent_ids` を追加し、`team_send` で解決済み recipient を保存、`team_read` は recipient 優先で判定するよう変更した
- `resolve_pending_recruit` に `team_id` 引数を追加し、pending recruit と異なる team からの handshake を拒否するよう変更した
- Rust unit test を追加し、recipient 優先判定・legacy fallback・pending recruit の team/role mismatch を検証対象にした
- Windows の Rust test harness が `TaskDialogIndirect` を import する一方で Common Controls v6 manifest が無く、`cargo test team_hub` が `STATUS_ENTRYPOINT_NOT_FOUND (0xc0000139)` で起動前失敗していたため、build.rs で共通 manifest を `/MANIFESTINPUT` として埋め込むよう修正した

### 検証
- `cargo check --manifest-path src-tauri\Cargo.toml`: PASS
- `cargo build --manifest-path src-tauri\Cargo.toml`: PASS
- `npm run typecheck`: PASS
- `npm run build:vite`: PASS（既存の chunk size / dynamic import warning あり）
- `cargo test --manifest-path src-tauri\Cargo.toml team_hub --no-run`: PASS
- `cargo test --manifest-path src-tauri\Cargo.toml team_hub -- --no-capture`: PASS（15 tests）
- `git diff --check`: PASS

### Next Tasks
- 手動 smoke で worker -> leader の `team_send` / `team_read({ unread_only: false })` と dismiss -> re-recruit の挙動を確認する
- PR 作成後に CodeRabbit と人間レビューを待つ

---

## Issue #359 リーダー軸ハンドオフ実装計画

### 計画
- [x] `feature/issue-359` で作業し、Issue コメント v2 の「同じ teamId に新リーダーを参加させる」方針に合わせる
- [x] ハンドオフ本文を Canvas localStorage へ入れず、Rust 側 `~/.vibe-editor/handoffs/...` に JSON / Markdown として保存する
- [x] `TeamHistoryEntry` と Canvas card payload には最新 handoff の参照だけを保持する
- [x] Agent card に `Create handoff` と `Start fresh from handoff` を追加し、新リーダー / 新ワーカーへ handoff summary + path を初期指示として注入する
- [x] 交代中の `team_send("leader")` 二重配送を避けるため、TeamHub に active leader 指定を追加し、leader 宛先は active leader を優先する
- [x] 新 agent から `handoff_ack:<handoffId>` が届いたら旧 agent card を `cascadeTeam: false` で退役させる
- [x] `npm run typecheck`、`cargo check --manifest-path src-tauri/Cargo.toml`、関連テストで検証する

### Next Steps
- Rust command / shared types / renderer API の順に永続化基盤を追加する
- Agent card UI と handoff ack listener を実装する
- 最後に TeamHistory 同期、型チェック、Rust check、差分確認を実施する

### 進捗 (2026-05-02)
- Rust command `handoffs_create/list/read/update_status` を追加し、handoff を JSON / Markdown で保存するようにした
- TeamHub に `active_leader_agent_id` を追加し、role 宛先解決と task assign で active leader を優先するようにした
- Agent card から handoff 作成、新規 agent 起動、ack 受信後の旧 card 退役までの UI flow を追加した
- Recent restore / TeamHistory に最新 handoff 参照を保存し、本文はファイル参照だけにした

### 検証
- `cargo check --manifest-path src-tauri\Cargo.toml`: PASS
- `npm run typecheck`: PASS
- `npm run test`: PASS (12 files / 83 tests、既存の jsdom canvas warning あり)
- `npm run build:vite`: PASS (既存の chunk size / dynamic import warning あり)
- `cargo test --manifest-path src-tauri\Cargo.toml handoffs -- --no-capture`: PASS (2 tests)
- `git diff --check`: PASS

### Next Tasks
- Tauri 実機で Agent card の handoff 作成、新規セッション起動、`handoff_ack:<handoffId>` による旧 card 自動退役を smoke 確認する
- PR 作成後に CodeRabbit と人間レビューを待つ。自動マージは禁止
