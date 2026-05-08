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

---

## Issue #443 IDEモード初期ターミナル表示修正

Issue: https://github.com/yusei531642/vibe-editor/issues/443

### 計画
- [x] Issue本文・plannedコメントを確認し、症状が IDE モード初期起動時の xterm/PTY サイズ決定レースであることを整理する。
- [x] `src/renderer/src/lib/use-pty-session.ts` の `loadInitialMetrics` を確認し、IDE モードでは `document.fonts.ready` を待たずに `fit.fit()` と `terminal_create` が走る現状を確認する。
- [x] `src/renderer/src/lib/use-fit-to-container.ts` の fonts.ready effect を確認し、`unscaledFit` のときだけ後追い refit する現状を確認する。
- [x] `src/renderer/src/lib/use-xterm-instance.ts` の font/theme 反映経路を確認し、フォント実体ロード完了イベントでは同値再代入・再計測が走らない現状を確認する。
- [x] `feature/issue-443` ブランチを作成して作業する。
- [x] `use-pty-session.ts` で IDE モードも 300ms timeout 付き `document.fonts.ready` 待機後に初期 `fit.fit()` を実行する。
- [x] `use-fit-to-container.ts` で IDE モードにも fonts.ready 後の 1 回 refit を許可し、初期フォントメトリクスずれを補正する。
- [x] `use-xterm-instance.ts` で fonts.ready 後に `fontFamily` の同値再代入、必要な `fit()` / `refresh()` / WebGL atlas clear を行い、xterm のセル寸法キャッシュを再測定させる。
- [x] Canvas モード (`unscaledFit=true`) の transform 対応経路は維持し、IDE 向け変更が Canvas の `computeUnscaledGrid` 経路に混入しないことを確認する。
- [x] `npm run typecheck`、`npm run build:vite`、`git diff --check` を実行する。
- [ ] 可能なら `npm run dev` で Tauri を起動し、IDE モード初期ターミナルの重複表示・初期崩れ・ドラッグ選択ずれを確認する。

### Next Steps
- ユーザー確認後、上記計画に沿って実装へ進む。
- 実装完了後、このセクションへ「進捗」「検証」「Next Tasks」を追記する。

### 進捗
- `feature/issue-443` で実装。
- `use-pty-session.ts` の初期サイズ算出で IDE モードも `document.fonts.ready` を最大 300ms 待つように変更。初期 `fit.fit()` 後の cols/rows を `lastScheduledRef` に seed し、初回 visible refit の重複 resize を抑止。
- `use-fit-to-container.ts` の fonts.ready 後 refit を IDE モードにも展開。
- `use-xterm-instance.ts` で fonts.ready 後に最新設定の fontFamily/fontSize を再代入し、WebGL atlas clear、IDE 経路の `fit()`、全行 refresh を行う補正パスを追加。
- `use-pty-session-fonts.test.tsx` を追加し、IDE モードで fonts.ready 前に `terminal.create` が呼ばれないことと、初期サイズ seed が行われることを検証。

### 検証
- `npm ci`: PASS
- `npm run typecheck`: PASS
- `npx vitest run src/renderer/src/lib/__tests__/use-pty-session-fonts.test.tsx src/renderer/src/lib/__tests__/use-pty-session-hmr.test.ts`: PASS (2 files / 9 tests)
- `npm run test`: PASS (23 files / 143 tests)。既存の jsdom canvas `getContext` 未実装 stderr は継続発生するが、テストは全件 PASS。
- `npm run build:vite`: PASS。既存の chunk size / dynamic import warning は継続。
- `git diff --check`: PASS

### Next Tasks
- Tauri 実機 (`npm run dev`) で IDE モード初期起動の Claude #1 banner が 1 回のみ、Team 作成後の残りペインも 1 回のみ、ドラッグ選択矩形ずれなしを手動 smoke する。
- PR 作成後に CodeRabbit と人間レビューを待つ。自動マージは禁止。

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

---

## Release v1.4.7 計画

Issue: #361

### 計画
- [x] `origin/main` を最新化し、`chore/release-1.4.7` ブランチを作成する
- [x] `package.json` / `package-lock.json` / `src-tauri/Cargo.toml` / `src-tauri/Cargo.lock` / `src-tauri/tauri.conf.json` を `1.4.7` に揃える
- [x] `npm run typecheck`、`npm run build:vite`、`cargo check --manifest-path src-tauri\Cargo.toml --all-targets` を通す
- [ ] release bump PR を作成し、CI / bot review の完了と merge を待つ
- [ ] merge 後の `origin/main` に `v1.4.7` タグを作成して push し、release workflow を起動する
- [ ] draft release の成果物と `latest.json` を確認し、問題なければ publish する

### Next Steps
- ユーザー確認後、release bump ブランチ作成とバージョン更新に進む
- release workflow 完了後、成果物一覧・検証結果・残課題をここへ追記する

### 検証
- `npm run typecheck`: PASS
- `npm run build:vite`: PASS (既存の chunk size / dynamic import warning あり)
- `cargo check --manifest-path src-tauri\Cargo.toml --all-targets`: PASS
- `git diff --check`: PASS

---


## Issue #452 初回PR計画（QA No-Go差戻し修正 / 2026-05-04）

Issue: https://github.com/yusei531642/vibe-editor/issues/452
Authoritative repo: `C:\Users\zooyo\Documents\GitHub\vibe-editor`
Branch: `feature/issue-452`
編集対象（計画タスク）: `tasks/todo.md` のみ

### 調査結果サマリ
- [x] Issue #452 は OPEN。ラベルは `ui` / `canvas` / `planned` / `refactor`。
- [x] GitHub 上に Issue #452 紐づき PR / remote `feature/issue-452` は未検出。
- [x] open PR #431-#439 は dependabot 系で、初回PR主要候補ファイルとの重複は未検出。
- [x] authoritative repo は `C:\Users\zooyo\Documents\GitHub\vibe-editor`。`HEAD=abfde302ce4350ecfb0e378e748e7106638ff8f9` で `origin/main` と一致。
- [x] `C:\Users\zooyo\Downloads\vibe-editor-dist` は fetch 後も `main...origin/main [behind 43]` の stale main のため実装対象 No-Go。
- [x] `main.protected=false` を GitHub API で確認。merge 前ブロッカーとして Owner 確認・Branch Protection 復旧が必要。
- [x] 既存未追跡 `tasks/*` は `git status --short` 表示で 18 entries、`--untracked-files=all` では 21 leaf files。未操作・PR混入 No-Go。

### 採用スコープ（初回PR = Phase A+B のみ）
- [x] Phase A: Glass CSS 集約。
- [x] Phase B: drag-region CSS 集約。
- [x] `src/renderer/src/index.css` を必須対象に含める。旧 Glass whitelist / root tint / drag-no-drag 残存を見落とすと再発するため No-Go。
- [x] `tokens.css` は Glass 値、`glass.css` は Glass 効果、`drag-region.css` は drag/no-drag の SSOT とする。
- [x] `glass.css` import 位置は component CSS 後、`tweaks.css` / `image-preview.css` 前を第一候補にする。
- [x] `lint` / E2E script 追加や CI lint 導入は初回PRから除外する。

### 明示的に除外する follow-up
- [ ] `App.tsx` の 600 行以下化 / JSX 巨大分割。
- [ ] `CanvasLayout.tsx` の header/menu/stage 分割。
- [ ] `.claude/skills/theme-customization/SKILL.md` 更新、新規 `.claude/skills/drag-region/SKILL.md` など skill/docs 整備。
- [ ] xterm / terminal 表示・scroll 共通化。
- [ ] Rust / TeamHub / i18n / CI lint 導入。
- [ ] 上記は別 PR / 別 Issue として Leader が別途割り当てる。

### 計画
- [ ] Phase 0: 変更前棚卸し
  - [ ] `backdrop-filter` / `-webkit-backdrop-filter` / `glass-surface` / `data-theme='glass'` / `app-region` / `-webkit-app-region` / `data-tauri-drag-region` を全検索する。
  - [ ] `index.css` の旧 Glass whitelist、root tint、drag/no-drag 残存を棚卸し対象に含める。
  - [ ] `menu.css` / `modal.css` / `palette.css` と `canvas.css` の `.tc__hud-*` / arrange popover blur は意図的例外候補として理由を記録する。
- [ ] Phase A: Glass CSS 集約（Implementation A）
  - [ ] `src/renderer/src/styles/components/glass.css` を新設する。
  - [ ] `tokens.css` に Glass の値を残し、root tint / `.glass-surface` / Glass 効果は `glass.css` に移動する。
  - [ ] `index.css` の旧 Glass whitelist は撤去または `glass.css` へ移動する。
  - [ ] `shell.css` / `canvas.css` の Glass 直書き blur は `glass.css` へ集約する。
  - [ ] `canvas.css` の `.tc__hud-*` / arrange popover blur は非 Glass でも意図された表現の可能性があるため、初回PRでは例外として残すことを優先する。削る場合は理由と手動 smoke を必須にする。
- [ ] Phase B: drag-region CSS 集約（Implementation A）
  - [ ] `src/renderer/src/styles/components/drag-region.css` を新設する。
  - [ ] `[data-tauri-drag-region]` / `.topbar` / `.canvas-header` と no-drag 対象を `drag-region.css` に集約する。
  - [ ] no-drag は drag より後に置く。
  - [ ] `button` / `input` / menu / WindowControls / popover trigger / resize handle 等を no-drag に明示登録する。
  - [ ] `main.tsx` に `glass.css` / `drag-region.css` import を追加し、import 順を説明可能にする。
  - [ ] `shell.css` / `canvas.css` / `index.css` の `app-region` / `-webkit-app-region` 重複を整理する。
  - [ ] `Topbar.tsx` は必要最小の属性調整のみ対象にする。
  - [ ] `CanvasLayout.tsx` は既存 `data-tauri-drag-region` の確認のみを基本とする。変更が必要な場合は理由・対象行・手動確認観点を PR に明記する。

### A/B 分担（QA No-Go修正後の一本化）
- [ ] Implementation A: production Phase A+B 担当。
  - [ ] Glass production: `glass.css` 新設、`main.tsx` import、`tokens.css` / `index.css` / `shell.css` / `canvas.css` 整理。
  - [ ] drag production: `drag-region.css` 新設、drag/no-drag SSOT、`main.tsx` import、`shell.css` / `canvas.css` / `index.css` の app-region 整理、必要最小 `Topbar.tsx` 属性調整。
- [ ] Implementation B: 静的契約テストのみ担当。
  - [ ] `src/renderer/src/styles/__tests__/glass-css-contract.test.ts`
  - [ ] `src/renderer/src/styles/__tests__/drag-region-css-contract.test.ts`
  - [ ] production CSS/TSX は編集しない。
- [x] 古い B production 分担案（B が `drag-region.css` / `shell.css` / `canvas.css` / `index.css` / `Topbar.tsx` / `CanvasLayout.tsx` を編集する案）は obsolete。採用しない。

### 変更候補ファイル（初回PR対象）
- [ ] `src/renderer/src/styles/tokens.css` — Glass 値の SSOT。
- [ ] `src/renderer/src/styles/components/glass.css` — 新規。Glass 効果の SSOT。
- [ ] `src/renderer/src/styles/components/drag-region.css` — 新規。drag/no-drag の SSOT。
- [ ] `src/renderer/src/index.css` — 旧 Glass whitelist、root tint、drag/no-drag 残存の整理対象。
- [ ] `src/renderer/src/styles/components/shell.css` — topbar / Glass blur / drag 重複撤去対象。
- [ ] `src/renderer/src/styles/components/canvas.css` — canvas header / Glass blur / drag 重複撤去対象。`.tc__hud-*` / arrange popover blur は例外候補。
- [ ] `src/renderer/src/main.tsx` — CSS import 順の調整対象。
- [ ] `src/renderer/src/components/shell/Topbar.tsx` — 必要最小の drag 属性調整が必要な場合のみ。
- [ ] `src/renderer/src/layouts/CanvasLayout.tsx` — 原則確認のみ。変更が必要なら理由を明記して最小差分。
- [ ] `src/renderer/src/styles/__tests__/glass-css-contract.test.ts` — B担当の契約テスト新規候補。
- [ ] `src/renderer/src/styles/__tests__/drag-region-css-contract.test.ts` — B担当の契約テスト新規候補。

### 変更候補ファイル（follow-up / 初回PR対象外）
- [ ] `src/renderer/src/App.tsx` — JSX巨大分割は別PR。
- [ ] `src/renderer/src/layouts/CanvasLayout.tsx` の header/menu/stage 分割 — 別PR。初回PRでは分割しない。
- [ ] `.claude/skills/theme-customization/SKILL.md` — skill更新は別PR。
- [ ] `.claude/skills/drag-region/SKILL.md` — skill新設は別PR。
- [ ] `src/renderer/src/lib/themes.ts` — 原則読み取り / 例外判定のみ。最小変更では触らない。
- [ ] `src/renderer/src/styles/components/menu.css` — 原則読み取り / 例外判定のみ。
- [ ] `src/renderer/src/styles/components/modal.css` — 原則読み取り / 例外判定のみ。
- [ ] `src/renderer/src/styles/components/palette.css` — 原則読み取り / 例外判定のみ。
- [ ] xterm / Rust / TeamHub / i18n / CI lint 関連ファイル — 別Issue。

### 初回PR 受け入れ条件
- [ ] Glass 値は `tokens.css`、Glass 効果は `glass.css` に集約されている。
- [ ] `index.css` の旧 Glass whitelist は撤去または `glass.css` へ移動済み。
- [ ] `shell.css` / `canvas.css` / `index.css` に残る `backdrop-filter` は、`glass.css` または例外理由付きの意図的残存のみ。
- [ ] `drag-region.css` が drag/no-drag の SSOT になっている。
- [ ] no-drag が drag より後に定義され、button/input/menu/window controls/popover trigger/resize handle が no-drag 対象になっている。
- [ ] `src/renderer/src/styles/__tests__/glass-css-contract.test.ts` と `drag-region-css-contract.test.ts` が追加され、SSOT・残存例外・import順の契約を検証している。
- [ ] Glass smoke: `npm run dev` で IDE / Canvas の白濁・紫濁り・過剰 blur がないことを手動確認する。
- [ ] Drag smoke: IDE Topbar と Canvas header の空白領域で window drag が効き、ボタン / input / menu / WindowControls / popover / resize handle がクリック可能なことを手動確認する。
- [ ] 未追跡 `tasks/*` が PR 差分に混入していない。
- [ ] Branch Protection `main.protected=false` の Owner確認・復旧方針が merge 前ブロッカーとして残っている。

### 検証コマンド候補
- [ ] `git status --short --branch`
- [ ] `git diff --check`
- [ ] `npm run typecheck`
- [ ] `npm run test`
- [ ] `npm run build:vite`
- [ ] `cargo check --locked --manifest-path src-tauri\Cargo.toml --all-targets`
- [ ] `cargo test --locked --manifest-path src-tauri\Cargo.toml`
- [ ] `rg -n "backdrop-filter|-webkit-backdrop-filter|glass-surface|data-theme=['\"]glass|app-region|-webkit-app-region|data-tauri-drag-region" src/renderer/src`
- [ ] `npm run dev`（Windows/Tauri 実機 smoke）
- [ ] `lint` / E2E は現行 `package.json` に script 未定義のため、未実行を誤報告しない。必要なら別Issue / 別PRで script 整備を扱う。

### No-Go / 安全制約
- [ ] authoritative path 以外で実装しない: `C:\Users\zooyo\Documents\GitHub\vibe-editor` / `feature/issue-452` のみ。
- [ ] `C:\Users\zooyo\Downloads\vibe-editor-dist` は stale main のため実装対象 No-Go。
- [ ] `tasks/todo.md` 以外の計画タスク編集は禁止。
- [ ] 未追跡 `tasks/*` を add / 編集 / 削除しない。
- [ ] reset / clean / stash / drop / 削除は禁止。
- [ ] 初回PRでは App/CanvasLayout分割、skill/docs、xterm/Rust/TeamHub/i18n/CI lint を混ぜない。

### Next Steps
- [ ] QA にこの修正版計画を再レビュー依頼する。
- [ ] QA Go 後、Leader が Implementation A に production Phase A+B を割り当てる。
- [ ] A の production 変更後、Leader が Implementation B に `styles/__tests__/*` の契約テスト追加を割り当てる。
- [ ] 実装Go前に A/B とも `C:\Users\zooyo\Documents\GitHub\vibe-editor` / `feature/issue-452` であることを `git status --short --branch` で確認する。

### 実装後進捗（最終状態反映 / 2026-05-04）
- [x] Implementation A: production Phase A+B 実装完了。
- [x] Implementation B: 静的契約テスト 2 件追加完了。
- [x] QA A+B 差分レビュー: 条件付き Go。
- [x] A Task #13: cargo 検証完了。
- [x] QA Task #14: Tauri 実機 smoke は未実証として判定。
- [x] QA Task #16: 既存アプリを閉じない前提の代替 smoke 整理完了。

#### 変更ファイル概要
- production 変更:
  - `src/renderer/src/components/shell/Topbar.tsx`
  - `src/renderer/src/index.css`
  - `src/renderer/src/main.tsx`
  - `src/renderer/src/styles/components/canvas.css`
  - `src/renderer/src/styles/components/shell.css`
  - `src/renderer/src/styles/tokens.css`
  - `src/renderer/src/styles/components/glass.css`（新規）
  - `src/renderer/src/styles/components/drag-region.css`（新規）
- test 追加:
  - `src/renderer/src/styles/__tests__/glass-css-contract.test.ts`
  - `src/renderer/src/styles/__tests__/drag-region-css-contract.test.ts`

#### 検証結果（代替で PASS 済み）
- [x] `git diff --check`: PASS
- [x] `npm run typecheck`: PASS
- [x] `npm run build:vite`: PASS（既存警告あり）
- [x] targeted Vitest: PASS（2 files / 11 tests）
- [x] `npm run test`: PASS（26 files / 185 tests、既存 jsdom `getContext` stderr あり、exit 0）
- [x] rg 残存確認: 実行済み（例外あり）
- [x] `cargo check --locked --manifest-path src-tauri\Cargo.toml --all-targets`: PASS
- [x] `cargo test --locked --manifest-path src-tauri\Cargo.toml`: PASS（93 passed / 0 failed、他ターゲット 0 tests も PASS）

#### Tauri 実機 smoke の最終扱い
- [ ] feature branch の Tauri 実機 smoke は未実行扱い。
- [x] 既存 `vibe-editor  Downloads` が single-instance として稼働中。
- [x] ユーザーが「閉じられない」と明示。
- [x] repo 内にコード / config 変更なしで安全に single-instance を回避する既存 script / flag / 別 identifier 手順は確認できず。
- [x] QA により `npm run dev` は Vite ready / Rust dev build / `target\debug\vibe-editor.exe` 起動試行まで到達。
- [ ] feature branch window を検出できず、Glass / drag / clickability / PTY smoke は未実証。
- [x] ユーザー作業中の可能性があるため、既存アプリは停止しない判断。

#### 未実証項目
- [ ] Native window drag / app-region hit testing。
- [ ] Glass + WebView2 Acrylic 実視覚。
- [ ] WindowControls / popover / resize handle clickability。
- [ ] IDE / Canvas 切替時の PTY 保持。

#### PR判断 / merge前ゲート
- [x] 未実行理由を PR 本文に明記する条件で、条件付き PR 可能。
- [ ] 完全 Go ではない。merge 前は Branch Protection 復旧、reviewer / CodeRabbit 相当レビュー、人間承認が必須。
- [ ] Branch Protection `main.protected=false` は merge 前ブロッカー。Owner 確認・保護設定復旧が必要。
- [ ] reviewer / CodeRabbit 相当レビュー + 人間承認まで merge 不可。
- [ ] `lint` / E2E は package.json に script 未定義のため、未実行を誤報告しない。必要なら別Issue / 別PR。

#### ユーザー目視チェックリスト（参考確認）
- [ ] Glass 見た目。
- [ ] window drag。
- [ ] WindowControls / popover / resize handle clickability。
- [ ] IDE / Canvas 切替時の PTY 保持。
- [ ] 既存アプリのみ確認する場合は feature 差分の証跡ではなく参考確認として記録する。

#### PR前 add 対象 / 禁止対象
- [ ] add 対象候補:
  - production 変更 6 件: `Topbar.tsx`, `index.css`, `main.tsx`, `canvas.css`, `shell.css`, `tokens.css`
  - 新規 CSS 2 件: `glass.css`, `drag-region.css`
  - 契約テスト 2 件: `glass-css-contract.test.ts`, `drag-region-css-contract.test.ts`
  - ドキュメント: `tasks/todo.md`
- [ ] add 禁止:
  - 既存未追跡 `tasks/*`
  - `.env*`
  - secret / token / private key 類

#### Next Tasks
- [ ] PR 本文に Tauri 実機 smoke 未実行理由を明記する。
- [ ] PR 本文に代替 PASS 済み検証（typecheck / build:vite / Vitest / cargo check / cargo test / diff check）を記録する。
- [ ] PR 作成時に `git add` 対象を上記 add 対象候補に限定する。
- [ ] 既存アプリで参考確認する場合は、feature 差分の証跡ではないことを明記する。
- [ ] merge 前に Branch Protection `main.protected=false` の Owner 確認・復旧方針を明記する。

### Issue #452 引き継ぎ対応計画（2026-05-04 / Codex）
- [ ] `git status --short --branch` で対象が `feature/issue-452` か確認する。
- [ ] 既存 `AppData\Local\vibe-editor\vibe-editor.exe` は停止せず、Tauri CLI の `--config` で一時 `identifier` / `productName` を差し替えた dev 起動を試す。
- [ ] 別 identifier の feature branch window を起動できた場合のみ、Glass / drag / clickability / IDE-Canvas 切替 PTY 保持を Tauri 実機 smoke として記録する。
- [ ] 別 identifier 起動でも実機確認できない場合は、その理由を `tasks/todo.md` と PR 本文に明記し、未実証ゲートとして残す。
- [ ] `git diff --check` と `git status --short --branch` を再確認し、PR 対象ファイルだけを明示 `git add` する。
- [ ] PR 作成・レビュー確認まで進める。merge は Branch Protection 復旧、reviewer / CodeRabbit 相当レビュー、actionable 指摘ゼロ、人間承認が揃うまで禁止。

#### Next Steps
- [ ] 一時 config を repo 外に作成し、`npm run dev -- --config <temp-config>` で起動する。
- [ ] 起動ログ・window 検出・目視 / 操作確認の結果をこの TODO に追記する。
- [ ] PR 本文には smoke の実施方法、通過項目、未実証項目、merge 前ブロッカーを明記する。

### Tauri実機smoke結果（2026-05-04 / 既存アプリ非停止）
- [x] 既存 `C:\Users\zooyo\AppData\Local\vibe-editor\vibe-editor.exe` は停止せず維持。
- [x] repo 外の一時 config `tauri-issue452-glass-smoke.config.json` で `identifier` / `productName` を差し替え、single-instance を回避。
- [x] `npm run dev -- --config <temp-config>`: PASS（Vite `http://localhost:5173/` ready、`target\debug\vibe-editor.exe` 起動）。
- [x] feature branch window 検出: PASS（`target\debug\vibe-editor.exe`, title `vibe-editor — vibe-editor`）。
- [x] feature UI表示: PASS（Git branch `feature/issue-452` と対象差分一覧が表示されることをスクリーンショットで確認）。
- [ ] Glass見た目: PARTIAL。Glass透過は確認できるが、既存アプリが最大化され背面に写り込むため、Acrylic / blur の厳密な目視判定は保留。
- [ ] IDE Topbar / Canvas header の手動 window drag: 未実証。
- [ ] WindowControls / popover / resize handle clickability: 未実証。
- [ ] IDE / Canvas 切替時の PTY 保持: 未実証（xterm focus がショートカットを吸う状態があり、確証なし）。
- [x] 一時的に退避した `C:\Users\zooyo\.vibe-editor\settings.json` は元設定へ復元済み（first bytes `123,10,32`、BOMなし）。

#### Next Tasks
- [ ] PR 本文に「既存アプリ非停止のため完全な native hit-testing smoke は未実証」と明記する。
- [ ] merge 前に人間が feature branch window で drag / clickability / PTY保持を確認する。
- [ ] merge 前に Branch Protection `main.protected=false` の復旧を確認する。

---

## Issue Autopilot Batch: Canvas/UI 低リスクグループ計画（2026-05-04 / Codex）

対象: https://github.com/yusei531642/vibe-editor/issues

### 調査結果
- [x] `planned` ラベル付き open Issue は 7 件: #457, #456, #455, #454, #453, #451, #441。
- [x] #451 は `fortress-review-required` 付きの Tier A 相当で初回バッチから除外。
- [x] #454 は backend / generated bridge / MCP startup を含む Tier B で初回バッチから除外。
- [x] #456 は prompt / skill / schema を横断する Tier B で、#451 周辺差分との競合注意があるため初回バッチから除外。
- [x] #455 は Canvas 配置ロジックの Tier C だが、spawn preset / restore / viewport focus まで見るため初回の最小グループからは後続候補にする。
- [x] open PR は dependabot 系 #431-#439 のみで、Canvas/UI 対象ファイルとの直接競合は現時点で未検出。
- [x] `vibeeditor` / `pullrequest` skill と `CLAUDE.md` を確認済み。リポジトリ方針に従い `main` 直接 push / 手動 merge はしない。

### 初回バッチ対象
- [ ] #457: Canvas モード各ターミナル/Agent ヘッダーのフォントサイズ・高さを改善する。
- [ ] #453: Canvas モードで `Ctrl+Shift+P` の CommandPalette が見えるよう portal / z-index を修正する。
- [ ] #441: Canvas HUD の「間隔」ボタンを押した直後に再配置し、`arrangeGap: "wide"` の永続化正規化を修正する。

### 採用理由
- [x] 3 件とも `canvas` / `ui` 中心で、renderer 側の CSS / React / zustand store に閉じる。
- [x] Issue 計画上は #457, #453 が Tier C / score 4、#441 も小規模な Canvas HUD + store 修正で低リスク。
- [x] 変更対象が Canvas 表示・HUD・global overlay にまとまり、検証を Canvas 起点で一括化できる。
- [x] Rust / MCP / TeamHub / 外部プロセス起動の変更を含まないため、初回バッチとして安全。

### 実装計画
- [ ] ブランチは `feature/issue-441-canvas-ui-batch` を作成し、1 PR にまとめる場合は PR 本文に `Closes #441`, `Closes #453`, `Closes #457` を明記する。
- [ ] #457: `CardFrame.tsx` の header inline style を CSS クラス化し、`canvas.css` の Agent header / role / status 周辺を `--text-md` / `--text-xs` ベースへ底上げする。
- [ ] #453: `CommandPalette.tsx` を `createPortal(..., document.body)` で body 直下に描画し、`.cmdp-backdrop` を global overlay として `display:flex`, `position:fixed`, `z-index: var(--z-palette)` に揃える。
- [ ] #453: `tokens.css` の `--z-palette` が `--z-canvas-root` より上か確認し、不足があれば最小修正する。
- [ ] #441: `normalizeCanvasState()` の `arrangeGap` 許可値を `tight | normal | wide` に修正する。
- [ ] #441: `StageHud.tsx` の gap ボタン押下で `setArrangeGap(g.id)` 後に `tidyTerminalCards(g.id)` を呼び、見た目を即時反映する。
- [ ] #441: 既存 `canvas-arrange.test.ts` / `canvas-restore-normalize.test.ts` へ回帰テストを追加し、必要なら CommandPalette portal の軽量テストを追加する。

### 検証計画
- [ ] `npx vitest run src/renderer/src/lib/__tests__/canvas-arrange.test.ts src/renderer/src/stores/__tests__/canvas-restore-normalize.test.ts`
- [ ] 追加した場合: `npx vitest run <CommandPalette portal test>`
- [ ] `npm run typecheck`
- [ ] `npm run build:vite`
- [ ] UI 変更のため `npm run dev` で Canvas モードを起動し、#457/#453/#441 の操作フローを手動確認する。
- [ ] `git diff --check`

### Next Steps
- [ ] ユーザー確認後、`feature/issue-441-canvas-ui-batch` を作成して実装する。
- [ ] 実装完了後、このセクションへ「進捗」「検証結果」「Next Tasks」を追記する。
- [ ] PR 作成前に差分対象を確認し、未関係の `tasks/*` や secret を混入させない。
- [ ] PR 作成後はレビュー結果を確認し、人間承認・QA 合意なしに merge しない。

### 進捗 (2026-05-04 / Codex 続き)
- [x] `feature/issue-441-canvas-ui-batch` を作成。
- [x] #441: `arrangeGap` 正規化を `tight | normal | wide` に修正し、HUD gap 押下で即時再配置するよう修正。
- [x] #453: CommandPalette を body portal 化し、Canvas より前面の fixed overlay / z-index に修正。
- [x] #457: Canvas card header の CSS 化と Terminal / Agent header の可読性改善を実装。
- [x] dev/browser/custom Tauri smoke で `getCurrentWindow()` が metadata 不在時に render crash しないよう安全化。
- [x] 検証用プロセス停止と `C:\Users\zooyo\.vibe-editor\settings.json` のバックアップ復元。

### 検証結果 (2026-05-04)
- [x] `npx vitest run src/renderer/src/lib/__tests__/canvas-arrange.test.ts src/renderer/src/stores/__tests__/canvas-restore-normalize.test.ts src/renderer/src/components/__tests__/CommandPalette.test.tsx`: PASS (3 files / 21 tests)
- [x] `npm run typecheck`: PASS
- [x] `npm run build:vite`: PASS。既存の chunk size / ineffective dynamic import warning は継続。
- [x] `git diff --check`: PASS
- [ ] UI smoke: PARTIAL。別 identifier Tauri 起動では IPC injection が不完全で settings load が default へ落ちるため、Canvas 操作の完全な手動確認は未完了。

### Next Tasks (2026-05-04 更新)
- [ ] 通常の `npm run dev` または人間の確認用環境で Canvas を開き、#457/#453/#441 の手動 smoke を実施する。
- [ ] PR 本文に `Closes #441`, `Closes #453`, `Closes #457` と検証結果、UI smoke 未完了理由を記載する。
- [ ] CodeRabbit / reviewer / 人間承認 / QA 合意なしに merge しない。

---

## Issue #455 追補計画 (2026-05-04 / Codex)

Issue: https://github.com/yusei531642/vibe-editor/issues/455
Branch: `feature/issue-441-canvas-ui-batch`
PR: https://github.com/yusei531642/vibe-editor/pull/459

### 判断
- [x] PR #459 は Draft / CI `verify` SUCCESS / review・comments なし。
- [x] #455 は Tier C で、#441/#457 と同じ Canvas 配置・表示領域に閉じる。
- [x] 未マージの Canvas 差分と衝突しやすいため、別ブランチではなく現在の Draft PR #459 へ追補する。
- [x] 既存カードは動かさず、新規チーム起動バッチだけを非衝突位置へ offset する。

### 実装計画
- [ ] `src/renderer/src/lib/canvas-placement.ts` を追加し、既存 node bbox と追加予定 batch bbox から非衝突 offset を決める helper を実装する。
- [ ] helper は `NODE_W` / `NODE_H` を fallback にし、既存 node の `style.width` / `style.height` がある場合は bbox 計算へ反映する。
- [ ] `CanvasLayout.applyPreset()` で `presetPosition()` の相対配置を維持したまま helper を通し、`addCards()` 後に先頭カードへ `notifyRecruit()` する。
- [ ] `restoreRecent()` でも saved position / fallback position の batch 全体を同じ helper に通し、復元直後の重なりを避ける。
- [ ] 手動 `+` 追加の `stagger()` は今回の対象外として維持する。

### 検証計画
- [ ] `npx vitest run src/renderer/src/lib/__tests__/canvas-placement.test.ts src/renderer/src/lib/__tests__/workspace-presets.test.ts`
- [ ] `npm run typecheck`
- [ ] `npm run build:vite`
- [ ] `git diff --check`
- [ ] UI smoke は PR #459 と同じ制約あり。可能なら通常 Tauri 環境で「チーム起動」新カードが既存カードと重ならず、viewport が新Leaderへ寄ることを確認する。

### Next Steps
- [ ] helper とテストを実装する。
- [ ] 検証結果を `tasks/todo.md` と引き継ぎ書へ追記する。
- [ ] PR #459 の本文・タイトルを #455 追補込みへ更新する。
- [ ] CodeRabbit / reviewer / QA 合意なしに merge しない。

### 進捗 (2026-05-04 / Codex)
- [x] `src/renderer/src/lib/canvas-placement.ts` を追加。既存 node bbox と追加 batch bbox を比較し、重なる場合は既存 bbox の右側 / 下側 / grid scan の順で新規 batch だけを移動する。
- [x] 既存 node の `style.width` / `style.height` を bbox 計算に反映。未指定時は `NODE_W` / `NODE_H` を fallback にする。
- [x] `CanvasLayout.applyPreset()` と `restoreRecent()` に helper を接続し、`addCards()` 後に先頭カードへ `notifyRecruit()` を発火する。
- [x] `src/renderer/src/lib/__tests__/canvas-placement.test.ts` を追加し、leader-only / 複数member / style寸法 / relative spacing の回帰を固定した。
- [x] full Vitest の未処理 rejection を潰すため、`webview-zoom.ts` の host IPC 呼び出しを `window` 存在確認つきに安全化した。

### 検証結果 (2026-05-04 / #455追補)
- [x] `npx vitest run src/renderer/src/lib/__tests__/canvas-placement.test.ts src/renderer/src/lib/__tests__/workspace-presets.test.ts`: PASS (2 files / 8 tests)
- [x] `npx vitest run src/renderer/src/lib/__tests__/canvas-arrange.test.ts src/renderer/src/stores/__tests__/canvas-restore-normalize.test.ts src/renderer/src/components/__tests__/CommandPalette.test.tsx src/renderer/src/lib/__tests__/canvas-placement.test.ts src/renderer/src/lib/__tests__/workspace-presets.test.ts`: PASS (5 files / 29 tests)
- [x] `npm run test`: PASS (28 files / 191 tests)。既存の jsdom `HTMLCanvasElement.getContext` stderr は出るが exit 0。
- [x] `npm run typecheck`: PASS
- [x] `npm run build:vite`: PASS。既存の chunk size / ineffective dynamic import warning は継続。
- [x] `git diff --check`: PASS
- [ ] UI smoke: 未実施。PR #459 と同じく、通常 Tauri 環境での手動確認が必要。

### Next Tasks (2026-05-04 / #455追補)
- [ ] PR #459 の title/body を `Closes #455` と今回の検証結果込みへ更新する。
- [ ] 変更を commit / push し、CI と CodeRabbit を確認する。
- [ ] 通常 Tauri 環境で「チーム起動」新カードが既存カードと重ならず、viewport が新 Leader へ寄ることを手動 smoke する。
- [ ] CodeRabbit / reviewer / QA 合意なしに merge しない。

### 追加UI Smoke (2026-05-04 / Playwright MCP)
- [x] `npm run dev:vite -- --host 127.0.0.1 --port 5177` で renderer を起動し、Playwright MCP で Canvas へ遷移できることを確認。
- [x] #453: Canvas 上で `Ctrl+Shift+P` を押下し、`.cmdp-backdrop` が 1 件、`body > .cmdp-backdrop` が 1 件、`z-index=9600` で表示されることを確認。
- [x] #455: 「チーム起動」を 2 回実行し、React Flow node が 2 件、bbox は `[-423,279,640,400]` と `[249,279,640,400]`、overlap=false を確認。
- [x] #457: `.canvas-agent-card__header` が 2 件、computed style は `font-size: 14px`, `min-height: 42px`, `height: 44.8px` を確認。
- [x] #441: HUD「整理」メニューで「広い」をクリックし、`aria-checked=true`、カード間隔が 672px から 688px へ即時変化することを確認。
- [x] screenshot: `issue-459-canvas-smoke.png`
- [x] 検証用 Vite port 5177 は停止済み。

### 完了処理 Next Tasks (2026-05-04)
- [x] PR #459 を Ready for review に変更する。
- [x] 最新push後の GitHub Actions `verify`: PASS。
- [x] #441 / #453 / #455 / #457 に完了コメントを投稿し、`completed` として close する。
- [x] 最終PR/Issue状態を確認する。

### 最終状態 (2026-05-04)
- PR #459: Ready for review / OPEN / MERGEABLE / CI `verify` SUCCESS。
- Closed: #441, #453, #455, #457。
- Merge は未実施。CodeRabbit / reviewer / 人間承認 / QA 合意後に人間が判断する。
---

## Issue Autopilot Batch: TeamHub / MCP / Codex-only planned issues (2026-05-04 / Codex)

### 進捗 (2026-05-04 / Codex)

- [x] #456: Codex-only / same-engine 指示を Leader / HR prompt と vibe-team skill に明示し、HR / worker の `team_recruit` で `engine:"codex"` を省略しない回帰テストを追加。
- [x] #454: standalone Codex / Claude タブで vibe-team env が未注入でも MCP `initialize` / `tools/list` が no-op で成功し、`tools/call` のみ明示的な tool error を返すように修正。
- [x] #451: `team_send` の「端末へ配送成功」と recipient の実アクティビティを分離。受信側 `lastSeenAt` は配信だけでは更新せず、`team_read` / `team_status` / `team_update_task` 等の明示操作で更新。
- [x] #451: `team_diagnostics` に `pendingInbox`, `pendingInboxCount`, `oldestPendingInboxAgeMs`, `stalledInbound`, `lastAgentActivityAt` を追加し、delivered-but-unread を可視化。
- [x] #451: `team_send` response に `acknowledged: false` と `acknowledgedAtPerRecipient` を追加し、delivery と ACK を混同しない契約に更新。
- [x] MCP schema / embedded skill / `.claude/skills/vibe-team/SKILL.md` を、delivery は ACK ではない前提に更新。

### 検証結果 (2026-05-04)

- [x] `npx vitest run src/renderer/src/lib/__tests__/team-prompts-liveness.test.ts`: PASS (12 tests)
- [x] `cargo test --manifest-path src-tauri/Cargo.toml team_hub::protocol::tools -- --nocapture`: PASS (8 tests)
- [x] `cargo test --manifest-path src-tauri/Cargo.toml bridge::tests -- --nocapture`: PASS (2 tests)
- [x] `npm run typecheck`: PASS
- [x] `cargo check --manifest-path src-tauri/Cargo.toml`: PASS
- [x] `git diff --check`: PASS
- [x] `npm run test`: PASS (28 files / 194 tests)。既存の jsdom `HTMLCanvasElement.getContext` stderr は出るが exit 0。
- [x] `npm run build:vite`: PASS。既存の chunk size / ineffective dynamic import warning は継続。
- [x] `cargo test --manifest-path src-tauri/Cargo.toml`: PASS (99 tests)

### Next Tasks (2026-05-04)

- [ ] PR を作成する場合は本文に `Closes #451`, `Closes #454`, `Closes #456` と上記検証結果を記載する。
- [ ] PR 作成後は CodeRabbit / reviewer / 人間承認 / QA 合意を待つ。自動マージしない。

### 計画

- 対象 Issue は open かつ `planned` の 3 件に限定する。
  - #451: `team_send` 配信成功後に Worker 側でメッセージが処理されず長時間停止する問題。
  - #454: スタンドアロン Codex / Claude タブで `vibe-team MCP startup failed` が表示される問題。
  - #456: Codex-only チーム展開指示でも HR が ClaudeCode で採用される問題。
- 作業ブランチは `feature/issue-451` とする。#451 が Tier A で、#454/#456 も TeamHub / MCP / prompt 周辺に触れるため、重複差分を避けて 1 PR にまとめる。
- 実装順はリスクの低い順に固定する。
  1. #456: prompt / skill / schema の engine 制約を補強し、Codex-only 時に `engine:"codex"` を省略しない回帰テストを追加する。
  2. #454: bridge の env 不足 fallback を no-op MCP handshake に変更し、standalone 起動で startup failure を出さない Node/Rust テストを追加する。
  3. #451: delivery と recipient activity を分離し、pending / stalled inbound を diagnostics と response に出す。`delivered=true` を処理完了と誤認しない状態モデルに更新する。
- 変更候補ファイル:
  - `src/renderer/src/lib/role-profiles-builtin.ts`
  - `src/renderer/src/lib/team-prompts.ts`
  - `src/renderer/src/lib/__tests__/team-prompts-liveness.test.ts`
  - `.claude/skills/vibe-team/SKILL.md`
  - `src-tauri/src/commands/vibe_team_skill_body.md`
  - `src-tauri/src/team_hub/bridge.rs`
  - `src-tauri/src/team_hub/protocol/schema.rs`
  - `src-tauri/src/team_hub/protocol/tools/{send,diagnostics,read,status,update_task}.rs`
  - `src-tauri/src/team_hub/mod.rs`
- 検証は最低限以下を実行する。
  - `npx vitest run src/renderer/src/lib/__tests__/team-prompts-liveness.test.ts`
  - 追加した Rust / bridge / TeamHub 単体テスト
  - `npm run typecheck`
  - `cargo check --manifest-path src-tauri/Cargo.toml`
  - `git diff --check`
- 可能なら追加 smoke:
  - standalone Codex / Claude の MCP startup warning が出ないこと。
  - Canvas の Codex-only プリセットで HR / worker が Codex になること。
  - `team_diagnostics` が delivered-but-not-active を pending / stalled として報告すること。

### Next Steps

- [ ] ユーザーがこの計画を確認し、実装開始を承認する。
- [ ] 承認後、#456 -> #454 -> #451 の順に Red/Green で実装する。
- [ ] 実装後、本セクションに進捗・検証結果・残課題を追記する。
- [ ] PR を作成する場合は `Closes #451`, `Closes #454`, `Closes #456` を本文に含め、CodeRabbit と人間承認を待つ。自動マージはしない。
## Issue #460 ビルド/テスト時の既存警告整理 計画（2026-05-05 / Codex）

### Fortress Review
- 対象: https://github.com/yusei531642/vibe-editor/issues/460
- Tier: C（スコア 3）
- 判定根拠: DB migration / 認証 / 課金 / 公開 API 契約変更なし。対象は Vitest setup、`@tauri-apps/api/event` import 整理、Vite chunk warning 設定または分割方針の調整に限定する。
- RCA 判定: PASS。`npm run test` で `HTMLCanvasElement.prototype.getContext` stderr、`npm run build:vite` で chunk size / ineffective dynamic import / plugin timings warning を再現済み。
- 判定: 条件付き Go。実装前に本計画の確認を受ける。

### 計画
- [x] Issue #460 の内容を確認し、`feature/issue-460` ブランチを作成する。
- [x] `npm ci`、`npm run test`、`npm run build:vite` で現状警告を再現する。
- [x] `src/renderer/src/test-setup.ts` に jsdom 用の Canvas 2D mock を追加し、`measureCellSize` の fallback 挙動を stderr なしで維持する。
- [x] `src/renderer/src/App.tsx` と `src/renderer/src/lib/use-files-changed.ts` の `@tauri-apps/api/event` import 経路を静的 import に統一し、ineffective dynamic import warning を解消する。
- [x] `vite.config.ts` の chunk warning を確認し、Monaco 等の意図的な大型 vendor chunk は分割または明示的な warning limit で扱う。警告抑止だけに見える変更にしないよう、理由をコメントに残す。
- [x] `npm run test` と `npm run build:vite` を再実行し、成功かつ対象警告が消えていることを確認する。
- [x] 実装後に本節へ進捗、検証結果、残課題を追記する。

### Next Steps
- [x] ユーザー確認後、上記計画に沿って最小差分で実装する。
- [ ] 実装後、必要なら PR 本文に `Closes #460` と検証結果を記載する。

### 進捗
- [x] `src/renderer/src/test-setup.ts` で `HTMLCanvasElement.prototype.getContext` を jsdom 用に no-op 化し、未実装 stderr を抑止。
- [x] `src/renderer/src/App.tsx` / `src/renderer/src/lib/use-files-changed.ts` の `@tauri-apps/api/event` を静的 import に統一。
- [x] `vite.config.ts` を `rolldownOptions` に移行し、Monaco の既知大型 chunk 向けに `chunkSizeWarningLimit` を明示。plugin timing warning は `checks.pluginTimings=false` で抑止し、ineffective dynamic import などの意味的チェックは維持。

### 検証結果
- [x] `npm run typecheck`: PASS
- [x] `npm run test`: PASS（28 files / 194 tests、`HTMLCanvasElement.getContext` stderr なし）
- [x] `npm run build:vite`: PASS（chunk size / ineffective dynamic import / plugin timings warning なし）

### Next Tasks
- [ ] PR を作成する場合は本文に `Closes #460` と上記検証結果を記載し、CodeRabbit と人間承認を待つ。自動マージはしない。
## Release v1.4.9 計画（2026-05-05 / Codex）

### 計画
- [x] 最新 `main` を取得し、`v1.4.8..origin/main` の変更範囲を確認する。
- [x] 最新リリース `v1.4.8` と release workflow のタグ起動条件を確認する。
- [x] `feature/release-1.4.9` ブランチで `package.json` / `src-tauri/Cargo.toml` / `src-tauri/tauri.conf.json` / `src-tauri/Cargo.lock` を `1.4.9` に同期する。
- [x] `tasks/todo.md` に進捗と検証結果を記録する。
- [x] `npm run typecheck` / `npm run test` / `npm run build:vite` / `cargo check --manifest-path src-tauri/Cargo.toml` / `git diff --check` を実行する。
- [ ] Release PR を作成し、CodeRabbit / reviewer / CI を確認する。
- [ ] PR merge 後に `main` を fast-forward し、`v1.4.9` annotated tag を作成して push する。
- [ ] release workflow 完了後、draft release `v1.4.9` と成果物、`latest.json` の有無を確認する。
- [ ] draft release の publish は成果物確認後に実施する。

### 変更範囲
- 対象: `v1.4.8..origin/main`
- 主な内容: Canvas/Theme/Terminal/PTY/Settings 修正、TeamHub/Codex-only MCP 修正、build/test warning 整理。
- 本番影響: Tauri updater の `latest.json` が publish 後に更新される。draft release のままではユーザー配信されない。

### Next Steps
- [ ] バージョン bump PR を作成して CI / reviewer を確認する。
- [ ] PR が merge されたら `v1.4.9` tag push で release workflow を起動する。

### 進捗
- [x] `npm version 1.4.9 --no-git-tag-version` で npm 側を同期。
- [x] `src-tauri/Cargo.toml` / `src-tauri/tauri.conf.json` を `1.4.9` に更新。
- [x] `cargo check --manifest-path src-tauri/Cargo.toml` で `src-tauri/Cargo.lock` の `vibe-editor` package version を `1.4.9` に更新。

### 検証結果
- [x] `npm run typecheck`: PASS
- [x] `npm run test`: PASS（28 files / 194 tests）
- [x] `npm run build:vite`: PASS
- [x] `cargo check --manifest-path src-tauri/Cargo.toml`: PASS
- [x] `cargo check --locked --manifest-path src-tauri/Cargo.toml`: PASS
- [x] `git diff --check`: PASS

### Next Tasks
- [ ] Release PR を作成し、CI / reviewer を確認する。
- [ ] PR merge 後、`v1.4.9` tag push で release workflow を起動する。
- [ ] draft release の成果物確認後に publish 判断を行う。

## Issue #466 Glass テーマのボタン文字コントラスト改善計画（2026-05-05 / Codex）

### 計画
- [x] Glass テーマの色定義と `var(--accent)` 背景を使うボタン CSS を調査する。
- [x] 新規 Issue を起票し、調査結果と再現手順を記載する。
- [x] Issue コメントに実装計画を投稿し、`planned` ラベルを付与する。
- [x] 実装前にユーザー確認を受ける。
- [x] `ThemeVars` にアクセント背景上の文字色トークンを追加し、全テーマへ値を設定する。
- [x] `setThemeColorVars()` から `--accent-foreground` を公開する。
- [x] `.toolbar__btn--primary` / `.onboarding__btn--primary` / `.canvas-btn--primary` などの白系固定文字色を `var(--accent-foreground)` へ置き換える。
- [x] Glass の `#00FFFF` 背景と濃色 foreground のコントラストが 4.5:1 以上であることを確認する。
- [x] `npm run typecheck` / `npm run test` / `npm run build:vite` / Vite smoke で動作と見た目を確認する。

### Next Steps
- [ ] ユーザー確認後、`feature/issue-466` ブランチを作成して最小差分で実装する。
- [ ] PR を作成する場合は本文に `Closes #466` と検証結果を記載し、CodeRabbit と人間承認を待つ。自動マージはしない。

### 進捗
- [x] Issue: https://github.com/yusei531642/vibe-editor/issues/466
- [x] Plan comment: https://github.com/yusei531642/vibe-editor/issues/466#issuecomment-4378224994
- [x] Labels: `bug`, `ui`, `a11y`, `planned`
- [x] `feature/issue-466` ブランチを作成し、Issue ラベルを `implementing` に更新。
- [x] `src/renderer/src/lib/themes.ts` に `accentForeground` を追加し、Glass は `#050714` に設定。
- [x] `src/renderer/src/lib/__tests__/theme-contrast.test.ts` を追加し、Glass accent / hover と foreground の 4.5:1 以上を検証。
- [x] Vite smoke で `.toolbar__btn--primary` / `.onboarding__btn--primary` / `.canvas-btn--primary` / `.rail__badge` の計算コントラスト 16.0:1 を確認。

### 検証結果
- [x] `npm run typecheck`: PASS
- [x] `npm run test -- theme-contrast`: PASS（2 tests）
- [x] `npm run test`: PASS（29 files / 196 tests）
- [x] `npm run build:vite`: PASS
- [x] `git diff --check`: PASS
- [x] Browser smoke: `http://127.0.0.1:5173/` で Glass 変数を適用し、主要ボタン/バッジの文字色 `rgb(5, 7, 20)`、背景 `rgb(0, 255, 255)`、contrast `16.0` を確認。

### Next Tasks
- [x] 実装時は `--bg` が Glass で透明になる点を避け、アクセント背景専用の foreground token を使う。
- [ ] PR を作成し、CodeRabbit / CI を確認する。

## Release v1.4.10 計画（2026-05-05 / Codex）

### 計画
- [x] 最新 `main` とタグを取得し、最新リリースが `v1.4.9` であることを確認する。
- [x] `v1.4.9..origin/main` の変更範囲を確認する。
- [x] release workflow が `v*` タグ push で draft release を作成する構成であることを確認する。
- [x] `chore/release-1.4.10` ブランチで `package.json` / `package-lock.json` / `src-tauri/Cargo.toml` / `src-tauri/tauri.conf.json` / `src-tauri/Cargo.lock` を `1.4.10` に同期する。
- [x] `npm run typecheck` / `npm run test` / `npm run build:vite` / `cargo check --manifest-path src-tauri/Cargo.toml` / `cargo check --locked --manifest-path src-tauri/Cargo.toml` / `git diff --check` を実行する。
- [ ] Release PR を作成し、CI / reviewer を確認する。
- [ ] PR merge 後に `main` を fast-forward し、`v1.4.10` annotated tag を作成して push する。
- [ ] release workflow 完了後、draft release `v1.4.10` と成果物、`latest.json` の有無を確認する。
- [ ] draft release の publish は成果物確認後に実施する。

### 変更範囲
- 対象: `v1.4.9..origin/main`
- 主な内容: Issue #466 / PR #467 Glass テーマのアクセント文字色改善。
- 本番影響: Tauri updater の `latest.json` が draft release publish 後に更新される。draft のままではユーザー配信されない。

### Next Steps
- [x] バージョン bump を実施して品質ゲートを通す。
- [ ] PR merge 後、`v1.4.10` tag push で release workflow を起動する。

### 進捗
- [x] `npm version 1.4.10 --no-git-tag-version` で npm 側を同期。
- [x] `src-tauri/Cargo.toml` / `src-tauri/tauri.conf.json` を `1.4.10` に更新。
- [x] `cargo check --manifest-path src-tauri/Cargo.toml` で `src-tauri/Cargo.lock` の `vibe-editor` package version を `1.4.10` に更新。

### 検証結果
- [x] `cargo check --manifest-path src-tauri/Cargo.toml`: PASS
- [x] `npm run typecheck`: PASS
- [x] `npm run test`: PASS（29 files / 196 tests）
- [x] `npm run build:vite`: PASS
- [x] `cargo check --locked --manifest-path src-tauri/Cargo.toml`: PASS
- [x] `git diff --check`: PASS

### Next Tasks
- [ ] Release PR を作成し、CI / reviewer を確認する。
- [ ] PR merge 後、`v1.4.10` tag push で release workflow を起動する。
- [ ] draft release の成果物確認後に publish 判断を行う。

## Issue #469 - Canvas mode file tree width (2026-05-06 / Codex)

計画: `tasks/issue-469/plan.md`

- [x] Issue #469 の本文、コメント、ラベル状態を確認
- [x] IDE / Canvas の Sidebar 構造と幅定義を調査
- [x] Root Cause Confirmed: Canvas の flex 配下で `.sidebar` 幅が `--shell-sidebar-w` に固定されていない
- [x] 実装前計画と Next Steps を記録
- [x] `src/renderer/src/styles/components/canvas.css` に Canvas 限定の Sidebar 幅制約を追加する
- [x] CSS contract test / typecheck / UI smoke で動作を実証する

### Next Steps

- [x] Canvas の `.sidebar` を `var(--shell-sidebar-w)` に固定する。
- [x] IDE 側の grid 幅定義と Canvas 側の flex 幅定義が同じ token を参照することをテストで固定する。
- [x] 実装後に進捗、検証結果、Next Tasks を追記する。

### 進捗

- [x] `.canvas-layout__body > .sidebar` に `flex` / `width` / `min-width` / `max-width` の固定を追加。
- [x] `canvas-css-contract.test.ts` で `--shell-sidebar-w` 参照を検証。
- [x] Issue #469 の GitHub ラベルを `planned` から `implementing` に更新。

### 検証結果

- [x] `npx vitest run src/renderer/src/styles/__tests__/canvas-css-contract.test.ts`: PASS
- [x] `npm run typecheck`: PASS
- [x] `npm run test`: PASS (30 files / 197 tests)
- [x] `npm run build:vite`: PASS
- [x] Browser smoke: `http://127.0.0.1:5174/` で Canvas モード表示、Rail/sidebar/stage の DOM 表示を確認。Vite 単体では Tauri API 未注入の既存 error が出る。
- [x] `git diff --check`: PASS

### Next Tasks

- [ ] PR を作成する場合は本文に `Closes #469` と検証結果を記載する。
- [ ] CodeRabbit / CI / 人間レビューを待ち、自動マージは行わない。

## Issue #470 - Leader orchestration state persistence (2026-05-06 / Codex)

計画: `tasks/issue-470/plan.md`

- [x] Issue #470 の本文、計画コメント、ラベル状態を確認
- [x] `vibeeditor` / `pullrequest` / `issue-autopilot-batch` / `root-cause-guardrail` / `fortress-review` の該当手順を確認
- [x] Root Cause Confirmed: TeamHub の監督状態が in-memory only で、team-history / handoff lifecycle へ durable に接続されていない
- [x] 実装前計画と Next Steps を記録
- [x] `team-state` 永続化ストアを追加する
- [x] TeamHub mutation と handoff lifecycle を永続化へ接続する
- [x] Canvas / IDE restore で persisted agentId と orchestration summary を保持する
- [x] テストと品質ゲートで動作を実証する

### Next Steps

- [x] `team-state` helper と型を追加する。
- [x] `team_assign_task` / `team_update_task` / `team_send` / leader switch 系 tool から team-state を更新する。
- [x] `TeamHistoryMember.agentId` を保存し、復元時に fallback ではなく persisted agentId を優先する。
- [x] human gate / handoff status summary を Canvas 履歴に表示する。
- [x] 実装後に進捗、検証結果、Next Tasks を追記する。

### 進捗

- [x] `src-tauri/src/commands/team_state.rs` を追加し、TeamHub orchestration snapshot を project/team 単位で永続化。
- [x] assign/update/send/leader switch/ack handoff の各 mutation を team-state と handoff lifecycle へ接続。
- [x] team-history / shared types / Canvas restore / IDE restore に `agentId` と orchestration summary を追加。
- [x] Canvas と sessions 履歴に human gate / handoff status の状態表示を追加。

### 検証結果

- [x] `cargo check --manifest-path src-tauri\Cargo.toml`: PASS
- [x] `npm run typecheck`: PASS
- [x] `npx vitest run src\renderer\src\lib\__tests__\canvas-layout-helpers.test.ts`: PASS (5 tests)
- [x] `cargo test --manifest-path src-tauri\Cargo.toml update_task_records_structured_report_and_human_gate -- --nocapture`: PASS
- [x] `cargo test --manifest-path src-tauri\Cargo.toml pending_tasks_exclude_done_tasks -- --nocapture`: PASS
- [x] `npm run test`: PASS (30 files / 199 tests)
- [x] `npm run build:vite`: PASS
- [x] `git diff --check`: PASS

### Next Tasks

- [ ] PR を作成する場合は本文に `Closes #470` と検証結果を記載する。
- [ ] CodeRabbit / CI / 人間レビューを待ち、自動マージは行わない。
- [ ] 必要に応じて Tauri 実機起動で handoff 復元の手動 smoke を追加確認する。

## Release v1.4.11 計画（2026-05-06 / Codex）

計画: `tasks/release-v1.4.11.md`

- [x] Issue #470 / PR #472 / CI / Issue close 状態を確認する
- [x] 最新 release と tag を確認し、次の patch version を `v1.4.11` と判断する
- [x] `package.json` / `package-lock.json` / `src-tauri/Cargo.toml` / `src-tauri/tauri.conf.json` / `src-tauri/Cargo.lock` を `1.4.11` に更新する
- [x] 品質ゲートを通す
- [ ] Release PR を作成し、CI / reviewer を確認する
- [ ] PR merge 後に `v1.4.11` annotated tag を push して release workflow を起動する

### Next Steps

- [x] バージョン bump を実施する。
- [x] `npm run typecheck` / `npm run test` / `npm run build:vite` / `cargo check --manifest-path src-tauri/Cargo.toml` / `cargo check --locked --manifest-path src-tauri/Cargo.toml` / `git diff --check` を実行する。
- [ ] Release PR 作成後、CodeRabbit / CI / 人間レビューを確認する。
- [ ] PR merge 後に tag push で release workflow を起動する。

### 進捗

- [x] `npm version 1.4.11 --no-git-tag-version` で npm 側を同期。
- [x] `src-tauri/Cargo.toml` / `src-tauri/tauri.conf.json` を `1.4.11` に更新。
- [x] `cargo check --manifest-path src-tauri/Cargo.toml` で `src-tauri/Cargo.lock` の `vibe-editor` package version を `1.4.11` に更新。

### 検証結果

- [x] `cargo check --manifest-path src-tauri\Cargo.toml`: PASS
- [x] `npm run typecheck`: PASS
- [x] `npm run test`: PASS (30 files / 199 tests)
- [x] `npm run build:vite`: PASS
- [x] `cargo check --locked --manifest-path src-tauri\Cargo.toml`: PASS
- [x] `git diff --check`: PASS

### Next Tasks

- [ ] Release PR を作成し、CI / reviewer を確認する。
- [ ] PR merge 後に `v1.4.11` annotated tag を作成して push する。
- [ ] release workflow 完了後、draft release の成果物と `latest.json` を確認する。

## Issue #475 - Glass canvas background transparency (2026-05-06 / Codex)

- [x] GitHub Issue #475 closed as `COMPLETED`: https://github.com/yusei531642/vibe-editor/issues/475
- [x] Close comment posted: https://github.com/yusei531642/vibe-editor/issues/475#issuecomment-4385121557
- [x] Label updated to `implemented`.
- [ ] PR is not created. Local implementation remains on `feature/issue-475`.

## Release v1.4.12 (2026-05-06 / Codex)

Plan: `tasks/release-v1.4.12.md`

- [x] Latest release confirmed as `v1.4.11`.
- [x] Next patch version selected: `v1.4.12`.
- [x] Release workflow confirmed: `v*` tag push creates a draft release.
- [x] Commit Issue #475 implementation.
- [x] Bump app versions to `1.4.12`.
- [x] Run quality gates.
- [x] Create release PR: https://github.com/yusei531642/vibe-editor/pull/477
- [x] Resolve `origin/main` conflict after PR initially reported `DIRTY`.
- [ ] Wait for CodeRabbit, CI, and human approval before merge/tag push.

計画: `tasks/issue-475/plan.md`

- [x] Issue #475 の本文、コメント、ラベル状態を確認
- [x] `main` を調査対象ブランチとして確認し、Issue #475 参照 PR がないことを確認
- [x] Glass / Canvas の背景・surface 関連 CSS とテーマ token を調査
- [x] Root Cause Confirmed: Glass 時の Canvas root tint が IDE root と同じ強さで全面適用されている
- [x] 実装前計画と Next Steps を記録
- [x] Issue #475 へ実装計画コメントを投稿: https://github.com/yusei531642/vibe-editor/issues/475#issuecomment-4384854342
- [x] Issue #475 に `enhancement`, `ui`, `canvas`, `planned` ラベルを付与
- [x] `feature/issue-475` ブランチを作成し、Issue ラベルを `implementing` に更新
- [x] `tokens.css` に IDE / Canvas root tint token を追加
- [x] `glass.css` で Canvas root tint を IDE root から分離
- [x] `glass-css-contract.test.ts` で Canvas tint が IDE tint より低 alpha であることを固定

### Next Steps

- [x] `npm run test -- src/renderer/src/styles/__tests__/glass-css-contract.test.ts`: PASS (6 tests)
- [x] `npm run typecheck`: PASS
- [x] `npm run test`: PASS (30 files / 200 tests)
- [x] `npm run build:vite`: PASS
- [x] Browser CSS smoke: IDE root `rgba(10, 10, 26, 0.55)` / Canvas root `rgba(10, 10, 26, 0.4)` を確認
- [ ] PR 前に `npm run dev` で Tauri 実機の Glass + Canvas を smoke 確認する。

## Issue #474 - Canvas list terminal colors (2026-05-06 / Codex)

計画: `tasks/issue-474/plan.md`

- [x] Issue #474 の本文、コメント、ラベル状態を確認
- [x] `issue-planner` / `issue-plan` / `vibeeditor` の該当手順を確認
- [x] Canvas の Stage/List 表示、AgentNodeCard、role profile 解決、CSS を調査
- [x] Root Cause Confirmed: List 表示が旧 `payload.role` + builtin shim `colorOf()` を使い、Stage 表示の `roleProfileId` + `RoleProfilesContext` と同じ色解決になっていない
- [x] 実装前計画と Next Steps を `tasks/issue-474/plan.md` に記録
- [x] Issue #474 に実装計画コメントを投稿する
- [x] Issue #474 に `planned` と種別/領域ラベルを付与する
- [x] 実装開始時に状態ラベルを `planned` から `implementing` へ遷移する
- [x] `tasks/batch-pipeline-state.json` に Issue #474 の Phase A 状態を記録する

### Next Steps

- [x] `StageListOverlay` を `roleProfileId` 優先 + `RoleProfilesContext` ベースの色解決へ変更する。
- [x] リスト行の CSS 変数を Stage 側の `AgentNodeCard` と同じ意味に揃える。
- [x] 動的ロール / custom profile / legacy role fallback をテストで固定する。
- [x] `npm run typecheck`、対象 vitest、`npm run test`、`npm run build:vite`、Canvas Stage/List smoke で確認する。

### 進捗

- [x] Issue #474 は OPEN、コメントなし、ラベルなしであることを確認。
- [x] 調査対象は Renderer の Canvas 表示に限定できると判断。Rust / IPC / PTY 起動処理は変更不要。
- [x] `AgentNodeCard` は `profile.visual.color`、List は `colorOf(payload.role)` で、色の source of truth が分岐していることを確認。
- [x] `fix/issue-474-canvas-list-terminal-colors` ブランチを作成し、Issue #474 を `implementing` に更新。
- [x] `agent-visual` helper を追加し、Stage/List/MiniMap/handoff edge の色解決を `resolveAgentVisual()` に統一。
- [x] `agent-visual.test.ts` と `canvas-css-contract.test.ts` を追加/更新し、roleProfileId 優先と list CSS 変数契約を固定。
- [x] Playwright smoke で Stage/List とも `roleProfileId=hr` の agent accent `#22c55e`、organization accent `#0ea5e9`、role label `人事`、glyph `H` を確認。

### Next Tasks

- [x] GitHub Issue コメント投稿後、コメント URL とラベル状態を確認する。
- [x] 実装フェーズへ進む場合は `fix/issue-474-canvas-list-terminal-colors` を切る。
- [ ] PR を作成する場合は本文に `Closes #474` と検証結果を記載する。
- [ ] CodeRabbit / CI / 人間レビューを待ち、自動マージは行わない。

### 投稿結果

- [x] Issue comment: https://github.com/yusei531642/vibe-editor/issues/474#issuecomment-4384844892
- [x] Labels: `planned`, `bug`, `canvas`, `ui`

### 検証結果

- [x] `npm run typecheck`: PASS
- [x] `npx vitest run src/renderer/src/lib/__tests__/agent-visual.test.ts src/renderer/src/styles/__tests__/canvas-css-contract.test.ts`: PASS (2 files / 6 tests)
- [x] `npm run test`: PASS (31 files / 204 tests)
- [x] `npm run build:vite`: PASS
- [x] `git diff --check`: PASS
- [x] Browser smoke: `http://127.0.0.1:5175/` で Stage/List の DOM/CSS 変数を確認。Vite 単体のため Tauri API 未注入由来の既存 console error は発生。

## Issue Autopilot Batch - bug / enhancement / security (2026-05-08 / Codex)

### 計画

- [x] `planned` 付き open Issue を `bug` / `enhancement` / `security` で分類する。
- [x] bug batch: #525 のみ。ただし Issue 本文は「worker 同士のファイル編集衝突」だが、planned コメントは「HR 委譲レベル」で内容が一致しない。
- [x] enhancement batch: #510, #515, #523, #527。
- [x] security batch: #520。
- [x] #525 は Issue 本文を正とする。既存 planned コメントは #525 本文と不一致のため採用しない。
- [x] #525 を再調査し、既存 #526 file lock はあるが advisory / optional のまま task state・prompt・UI に強制導線が無いことを最終原因として確認する。
- [x] #525 訂正版実装計画を `tasks/issue-525/plan.md` に作成し、Issue に投稿する: https://github.com/yusei531642/vibe-editor/issues/525#issuecomment-4402241311
- [ ] 方針確定後、各 batch を最大 5 Issue の制限内で順次実装する。
- [ ] 各 batch でラベルを `planned` -> `implementing` -> `implemented` へ遷移する。
- [ ] 各 Issue でローカル検証、PR、CI / review 確認、Issue コメント、close 根拠を残す。

### Next Steps

- [x] #525 の planned コメント不一致について、実装対象を確定する。
- [x] bug batch #525 を `fix/issue-525-file-ownership-guardrails` で開始し、単体実装する。
- [x] enhancement batch は #510 -> #515 -> #523 -> #527 の順に進める。UI/health から入り、message kind、wait policy、DoD gate の順で protocol 変更を積む。
- [x] security batch #520 は `team_send` の構造化 body と worker prompt 注入ルールの計画を `tasks/issue-520/plan.md` に記録し、`security/issue-520-structured-team-send` で開始する。
- [x] security batch #520 は `team_send` の構造化 body と worker prompt 注入ルールを実装する。

### 進捗 (2026-05-08 / Codex)

- [x] `/issue-planner` と `root-cause-guardrail` に従い、#525 の旧 planned コメントを採用しない判断を記録。
- [x] `file_locks.rs` / `assign_task.rs` / `role-profiles-builtin.ts` / `team-prompts.ts` / `toast-context.tsx` / `TeamTaskSnapshot` を再確認。
- [x] 最終原因を「ロック未実装」ではなく「既存 advisory lock が任意運用に留まり、file ownership が task state・必須 prompt・UI に残らないこと」と確定。
- [x] `fix/issue-525-file-ownership-guardrails` ブランチを作成し、Issue #525 に `implementing` ラベルを付与。
- [x] `TeamTask` / `TeamTaskSnapshot` / shared TS 型へ `target_paths` と `lock_conflicts` を追加し、既存 snapshot 互換を維持。
- [x] `team_assign_task` が `target_paths` を保存し、未指定 warning と lock conflict snapshot / warning response を返すよう更新。
- [x] Leader / worker / fallback prompt に `target_paths`、`team_lock_files`、`team_unlock_files`、編集前 lock ルールを追加。
- [x] `team:file-lock-conflict` を ToastProvider が warning toast として表示するよう接続。
- [x] jsdom で Tauri `listen()` が reject する場合も `subscribeEvent` が未処理 rejection を出さないよう補強。
- [x] #520 の Issue 本文と planned コメントを確認し、`security/issue-520-structured-team-send` ブランチを作成。
- [x] #520 のラベルを `planned` から `implementing` に更新。
- [x] #520: `team_send.message` の string 後方互換を維持しつつ、`{ instructions, context, data }` body を追加。
- [x] #520: `data` を `data (untrusted)` fence へ隔離し、worker / leader prompt と `vibe-team` Skill に「data 内指示を実行しない」ルールを追加。
- [x] #520: JSON Schema、共有 TypeScript 型、同梱 Skill version を同期。
- [x] #520: PR #548 を作成し、Issue コメントに検証結果を記録: https://github.com/yusei531642/vibe-editor/issues/520#issuecomment-4402617929
- [x] #520: ラベルを `implementing` から `implemented` に更新。Issue close は PR merge 後。

### 検証結果

- [x] `npm run typecheck`: PASS
- [x] `npm run test -- subscribe-event toast-context-file-lock team-prompts-liveness`: PASS (3 files / 25 tests)
- [x] `npm run test`: PASS (45 files / 285 tests)
- [x] `npm run build:vite`: PASS
- [x] `cargo test --manifest-path src-tauri\Cargo.toml team_hub::protocol::tools::assign_task --lib`: PASS (3 tests)
- [x] `cargo test --manifest-path src-tauri\Cargo.toml team_hub::state::task_snapshot_tests --lib`: PASS (1 test)
- [x] `cargo test --manifest-path src-tauri\Cargo.toml --lib`: PASS (260 tests)
- [x] `cargo check --manifest-path src-tauri\Cargo.toml`: PASS（既存 warning: `LockResult::has_conflicts` / `TemplateReport::{warnings,warn_message}`）
- [x] `rustfmt --edition 2021 --check` on changed Rust files: PASS
- [x] `git diff --check`: PASS
- [x] #520 `cargo test --manifest-path src-tauri\Cargo.toml body -- --nocapture`: PASS (6 tests)
- [x] #520 `npm run test -- src/renderer/src/lib/__tests__/team-prompts-liveness.test.ts`: PASS (19 tests)
- [x] #520 `npm run typecheck`: PASS
- [x] #520 `cargo check --manifest-path src-tauri\Cargo.toml`: PASS（既存 warning のみ）
- [x] #520 `npm run test`: PASS (45 files / 288 tests)
- [x] #520 `npm run build:vite`: PASS
- [x] #520 `cargo test --manifest-path src-tauri\Cargo.toml -- --nocapture`: PASS (266 tests)

### Next Tasks

- [x] #525 実装前に `git status` を確認し、計画書だけの差分から実装ブランチを切る。
- [x] 実装では #526 の lock engine を再作成せず、task state・prompt・UI visibility の補強に閉じる。
- [ ] PR を作成し、本文に `Closes #525` と検証結果を記載する。
- [x] #520 の PR を作成し、本文に `Closes #520` と検証結果を記載する: https://github.com/yusei531642/vibe-editor/pull/548
- [ ] CodeRabbit / CI / 人間レビューを待ち、自動マージは行わない。

## Issue Autopilot Batch - vibe-team governance enhancements (2026-05-08 / Codex)

### 計画

- [x] #510 は PR #544 で `main` に merge 済みと確認する。今回は重複実装せず、Issue 整理対象にする。
- [x] #515 / #523 / #527 を `planned` から `implementing` へ移す。
- [x] #515: `team_send` に `kind` を追加し、`request` は Leader に自動 CC する。
- [x] #523: worker 単位の `wait_policy` と task の `pre_approval` を追加する。
- [x] #527: task の Definition of Done と done evidence gate を追加する。
- [x] 1 Issue = 1 commit の形で差分を分ける。
- [x] Rust / TypeScript / skill 文言 / schema / UI 型を同期する。
- [x] typecheck、Rust test、関連 Vitest、build を通してから PR を準備する。

### Next Steps

- [x] 既存の `team_send` / `team_assign_task` / `team_update_task` / `team_recruit` の構造体とテストを読む。
- [x] #515 の配送仕様を最小差分で実装する。
- [x] #523 の policy / pre_approval を後方互換を保って追加する。
- [x] #527 の DoD gate は新規タスクに強制し、既存 task 互換を壊さない。

### 進捗 (2026-05-08 / Codex)

- [x] #510 は `ac48ee4` / PR #544 で `main` merge 済みと確認。今回ブランチでは重複実装しない。
- [x] #515: `team_send.kind` (`advisory` / `request` / `report`) を追加し、`request` は active Leader に自動 CC する。
- [x] #515: peer advisory を Leader summary feed に軽量記録し、`team_read` で kind を返す。
- [x] #523: `team_recruit.wait_policy` (`strict` / `standard` / `proactive`) を追加し、renderer recruit 注入に worker autonomy ルールを渡す。
- [x] #523: `team_assign_task.pre_approval` を task snapshot / shared TS / notification / prompt に同期する。
- [x] #527: `team_assign_task.done_criteria` を必須化し、欠落時は `assign_done_criteria_required` を返す。
- [x] #527: `team_update_task(..., "done")` 時に全 criteria 対応の `done_evidence` を要求し、不足時は `task_done_evidence_missing` で status を変えない。
- [x] #527: Skill version を `1.6.3` に更新し、同梱 Skill / prompt / JSON Schema / shared TS を同期する。

### 検証結果

- [x] `npm run typecheck`: PASS
- [x] `npm run test -- src/renderer/src/lib/__tests__/team-prompts-liveness.test.ts`: PASS (19 tests)
- [x] `npm run test`: PASS (45 files / 288 tests)
- [x] `npm run build:vite`: PASS
- [x] `cargo test --manifest-path src-tauri\Cargo.toml team_hub::protocol::tools::send --lib`: PASS
- [x] `cargo test --manifest-path src-tauri\Cargo.toml team_hub::protocol::tools::assign_task --lib`: PASS (9 tests)
- [x] `cargo test --manifest-path src-tauri\Cargo.toml team_hub::protocol::tools::update_task --lib`: PASS (6 tests)
- [x] `cargo test --manifest-path src-tauri\Cargo.toml team_hub::state::task_snapshot_tests --lib`: PASS
- [x] `cargo test --manifest-path src-tauri\Cargo.toml --lib`: PASS (283 tests / 既存 warning: `unused variable: home`)
- [x] `git diff --check`: PASS

### Next Tasks

- [x] #527 の最終テスト修正をコミットへ amend する。
- [x] ブランチを push し、PR 本文に `Closes #515` / `Closes #523` / `Closes #527` と検証結果を記載する: https://github.com/yusei531642/vibe-editor/pull/549
- [x] #510 は既存 PR #544 merge 済みとして Issue コメントとラベル整理を行う。
- [x] #515 / #523 / #527 は PR URL と検証結果を Issue コメントへ残し、`implementing` から `implemented` へ移す。
- [ ] CodeRabbit / CI / 人間レビューを待ち、自動マージは行わない。

### 投稿結果

- [x] PR: https://github.com/yusei531642/vibe-editor/pull/549
- [x] #510: PR #544 merge 済みをコメントし、`planned` -> `implemented`、Issue close。
- [x] #515: https://github.com/yusei531642/vibe-editor/issues/515#issuecomment-4402921256
- [x] #523: https://github.com/yusei531642/vibe-editor/issues/523#issuecomment-4402921223
- [x] #527: https://github.com/yusei531642/vibe-editor/issues/527#issuecomment-4402921222
- [x] #515 / #523 / #527: `implementing` -> `implemented`。Issue close は PR #549 merge 後。

## Hotfix - Issue #550 Codex command args normalization (2026-05-08 / Codex)

### 計画

- [x] Windows 起動エラーを Issue #550 として作成する。
- [x] `fix/issue-550-codex-command-args` ブランチを作成する。
- [x] Rust 側で `command` 欄に混ざった flags を起動前に `args` へ分離する。
- [x] `cmd /c` などの即時実行拒否が、分離後の args にも効くことをテストする。
- [x] Rust test / cargo check / diff check を通す。
- [x] PR を作成し、Bot merge 後に `v1.5.2` をリリースする。

### Next Steps

- [x] `src-tauri/src/commands/terminal/command_validation.rs` に command 正規化 helper と unit test を追加する。
- [x] `terminal_create` の入口で正規化 helper を使う。
- [x] 検証結果を Issue / PR / 本ファイルへ記録する。

### 検証結果

- [x] `cargo test --manifest-path src-tauri\Cargo.toml command_normalization_tests --lib`: PASS (6 tests)
- [x] `cargo check --manifest-path src-tauri\Cargo.toml`: PASS (既存 warning: `LockResult::has_conflicts` / `TemplateReport::{warnings,warn_message}`)
- [x] `npm run typecheck`: PASS
- [x] `git diff --check`: PASS
- [x] `cargo test --manifest-path src-tauri\Cargo.toml --lib`: PASS (289 tests / 既存 warning: `unused variable: home`)
- [x] `npm run test`: PASS (45 files / 288 tests、jsdom の Tauri `listen()` cleanup warning は既存)
- [x] `npm run build:vite`: PASS
- [x] GitHub Actions `ci / verify`: PASS (run `25535071998`)
- [x] GitHub Actions `release`: PASS (run `25535273228`, Windows / macOS / Linux)

### 完了結果

- [x] PR #551: https://github.com/yusei531642/vibe-editor/pull/551
- [x] Issue #550: Bot merge 後に close、`implemented` ラベルへ更新
- [x] Release `v1.5.2`: https://github.com/yusei531642/vibe-editor/releases/tag/v1.5.2
- [x] `latest.json`: `version` が `1.5.2` を返すことを確認

## Issue #553 - Claude Code inline command args regression test (2026-05-08 / Codex)

### 計画

- [x] ユーザー環境のインストール済み `vibe-editor.exe` が `1.5.1` であることを確認する。
- [x] 現行 `main` の `normalize_terminal_command()` が Claude / Codex 共通で使われることを確認する。
- [x] Claude Code の `--dangerously-skip-permissions --chrome --append-system-prompt` 実例を回帰テストに追加する。
- [x] Rust targeted test と diff check を通す。
- [x] PR を作成し、Bot merge を確認する。

### 検証結果

- [x] `cargo test --manifest-path src-tauri\Cargo.toml claude_inline_command_args --lib`: PASS (1 test)
- [x] `cargo test --manifest-path src-tauri\Cargo.toml command_normalization_tests --lib`: PASS (7 tests)
- [x] `git diff --check`: PASS
- [x] GitHub Actions `ci / verify`: PASS (run `25535950692`)

### 完了結果

- [x] PR #554: https://github.com/yusei531642/vibe-editor/pull/554
- [x] Issue #553: Bot merge 後に close、`implemented` ラベルへ更新

## Issue Autopilot Batch - Issue #556 CLI resolver hotfix (2026-05-08 / Codex)

計画: `tasks/issue-556/plan.md`

### 計画

- [x] `planned` 付き open Issue を確認し、今回の対象を #556 の単独バッチに限定する。
- [x] Issue #556 の本文、実装計画コメント、追加調査メモ、Claude Code セカンドオピニオンを確認する。
- [x] `AGENTS.md` / `CLAUDE.md` / `vibe-editor` skill / `tasks/lessons.md` を確認する。
- [x] `terminal_create` 入口の command 正規化と `spawn_session` 直前の Windows CLI 解決を確認する。
- [x] ユーザー確認後、`fix/issue-556-cli-resolver` ブランチを作成する。
- [x] Issue #556 のラベルを `planned` から `implementing` へ移す。
- [x] spawn 境界で command / args を再正規化し、allowlist と immediate-exec 拒否を再実行する。
- [x] Windows CLI resolver を追加し、`.cmd` / `.bat` は `cmd.exe /C` で起動する。
- [x] resolver と spawn 境界の Rust 回帰テストを追加する。
- [x] Rust targeted test、`cargo check`、全 Rust lib test、`npm run typecheck`、`npm run test`、`npm run build:vite`、`git diff --check` を通す。
- [x] PR を作成し、Issue コメントへ検証結果を記録する: https://github.com/yusei531642/vibe-editor/pull/557

### Next Steps

- [x] 実装開始の承認を受ける。
- [x] `fix/issue-556-cli-resolver` を切る。
- [x] `tasks/batch-pipeline-state.json` を #556 単独バッチとして初期化する。
- [x] #556 の Phase A を完了し、PR 作成後に CodeRabbit / CI を確認する。

### 進捗

- [x] `src-tauri/src/commands/terminal.rs` の `command_validation` を spawn 側から再利用できるよう `pub(crate)` 化。
- [x] `src-tauri/src/pty/session.rs` に spawn 境界の `prepare_spawn_command()` を追加。
- [x] Windows resolver で `PATH`、`PATHEXT`、`%APPDATA%\npm`、`%USERPROFILE%\.local\bin`、`%LOCALAPPDATA%\Microsoft\WindowsApps`、`%LOCALAPPDATA%\OpenAI\Codex\bin` を探索。
- [x] `.cmd` / `.bat` 解決時は `cmd.exe /C <resolved script> ...args` に変換。
- [x] INFO ログに requested / resolved / launcher / args.len / path_entries / pathext_present を出し、args 本文は出さない。

### 検証結果

- [x] `cargo test --manifest-path src-tauri\Cargo.toml command_normalization_tests --lib`: PASS (7 tests)
- [x] `cargo test --manifest-path src-tauri\Cargo.toml spawn_command_resolution_tests --lib`: PASS (3 tests)
- [x] `cargo check --manifest-path src-tauri\Cargo.toml`: PASS（既存 warning: `LockResult::has_conflicts` / `TemplateReport::{warnings,warn_message}`）
- [x] `cargo test --manifest-path src-tauri\Cargo.toml --lib`: PASS (293 tests / 既存 warning: `unused variable: home`)
- [x] `npm run typecheck`: PASS
- [x] `npm run test`: PASS (45 files / 288 tests、jsdom の Tauri `listen()` cleanup warning は既存)
- [x] `npm run build:vite`: PASS
- [x] `git diff --check`: PASS

### 投稿結果

- [x] PR: https://github.com/yusei531642/vibe-editor/pull/557
- [x] Issue comment: https://github.com/yusei531642/vibe-editor/issues/556#issuecomment-4403888408
- [x] Issue #556: `implementing` -> `implemented`。Issue close は PR merge 後。

## Release v1.5.3 (2026-05-08 / Codex)

Plan: `tasks/release-v1.5.3.md`

### 計画

- [x] 最新公開リリースが `v1.5.2` であることを確認する。
- [x] `main` が PR #557 merge commit `0292dbd` まで同期済みであることを確認する。
- [x] `chore/release-v1.5.3` ブランチを作成する。
- [x] npm / Rust / Tauri の version を `1.5.3` に更新する。
- [x] `Cargo.lock` を同期する。
- [x] 品質ゲートを通す。
- [ ] release PR を作成し、CI / reviewer bot を確認する。
- [ ] PR merge 後に `v1.5.3` tag を push する。
- [ ] release workflow を監視し、draft release の assets と `latest.json` を確認する。
- [ ] draft release を publish する。

### Next Steps

- [x] `package.json` / `package-lock.json` / `src-tauri/Cargo.toml` / `src-tauri/tauri.conf.json` を `1.5.3` に更新する。
- [x] `cargo check --manifest-path src-tauri\Cargo.toml` で `Cargo.lock` を同期する。
- [x] `npm run typecheck`、`npm run test`、`npm run build:vite`、`git diff --check` を実行する。

### 検証結果

- [x] `cargo check --manifest-path src-tauri\Cargo.toml`: PASS
- [x] `cargo test --manifest-path src-tauri\Cargo.toml --lib`: PASS (293 tests)
- [x] `npm run typecheck`: PASS
- [x] `npm run test`: PASS (45 files / 288 tests)
- [x] `npm run build:vite`: PASS
- [x] `git diff --check`: PASS
