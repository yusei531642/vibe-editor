# Issue #373 Refactor 引き継ぎ書

最終更新: 2026-05-02 (Phase 2 完了時点 / Phase 3 設計確定済み・実装未着手)

このドキュメントは Issue #373 (God File 解体ロードマップ) の進捗状況と、次のセッションが続きを引き取るための申し送り事項をまとめたもの。

---

## 現状

### 完了 PR

| PR | 内容 | 状態 |
|---|---|---|
| #380 | Phase 0 ベースライン (`tasks/refactor-smoke.md` + `tasks/refactor-clippy-baseline.md`) | ✅ MERGED |
| #382 | Phase 0 fix (CodeRabbit 指摘: 集計表の数値訂正) | ✅ MERGED |
| #384 | **Phase 1-1** `use-project-loader.ts` 切り出し | ✅ MERGED |
| #389 | **Phase 1-2** `use-file-tabs.ts` 切り出し (editor / diff tab) | ✅ MERGED |
| #390 | **Phase 1-3** `use-terminal-tabs.ts` 切り出し (terminal tab + DnD) | ✅ MERGED |
| #391 | **Phase 1-4** `use-team-management.ts` + `team-prompts.ts` 切り出し | ✅ MERGED |
| #392 | **Phase 1-5** `use-layout-resize.ts` 切り出し (panel resize) | ✅ MERGED |
| #393 | **Phase 1-6** `use-app-shortcuts.ts` 切り出し (グローバルショートカット + Shift+wheel zoom) | ✅ MERGED |
| #394 | **Phase 1-7** `use-claude-check.ts` 切り出し (CLI 検査 + 起動時 updater 遅延 effect) | ✅ MERGED |
| #395 | **Phase 1-8** UI state を `useUiStore` に統一 (`paletteOpen` / `status` 追加) | ✅ MERGED |
| #396 | **Phase 1-9** `commands` useMemo を `lib/app-commands.ts` の pure 関数に切り出し | ✅ MERGED |
| #399 | **Phase 2** `team_hub/protocol.rs` (1729 行) を `protocol/{tools/*,helpers,schema,consts,permissions,dynamic_role}` に分割 | ✅ MERGED |

### 未完了 follow-up issue

| Issue | 内容 |
|---|---|
| #381 | clippy ベースライン 15 件の解消 (機械的修正 13 件 + 構造変更が必要 2 件は別 Phase) |

### 行数推移

| ファイル | Phase 0 開始時 | Phase 2 完了時 | 目標 (Issue #373) |
|---|---|---|---|
| `App.tsx` | 2795 | **1275** | < 800 |
| `team_hub/protocol.rs` | 1729 | 分割 (1729 行 → 18 ファイル合計 1927 行 / +198 は mod.rs と pub use 集約・use 文重複・test 拡充による増分) | < 1000/file |
| App.tsx 累計削減 | — | **-1520** | -1995 |
| 進捗 | — | **76%** | 100% |

### 新規作成された hook / utility

| ファイル | 行数 | 責務 |
|---|---|---|
| `src/renderer/src/lib/hooks/use-project-loader.ts` | 196 | Phase 1-1: projectRoot / loadProject / refreshGit |
| `src/renderer/src/lib/hooks/use-file-tabs.ts` | 481 | Phase 1-2: editor tab / diff tab / recentlyClosed |
| `src/renderer/src/lib/hooks/use-terminal-tabs.ts` | 429 | Phase 1-3: terminal tab + DnD + activity Set |
| `src/renderer/src/lib/team-prompts.ts` | 88 | Phase 1-4: ROLE_DESC / ROLE_ORDER / generateTeamSystemPrompt (純粋関数) |
| `src/renderer/src/lib/hooks/use-team-management.ts` | 524 | Phase 1-4: teams / teamHistory / TeamHub / launch helpers |
| `src/renderer/src/lib/hooks/use-layout-resize.ts` | 171 | Phase 1-5: Claude panel / sidebar の drag resize |
| `src/renderer/src/lib/hooks/use-app-shortcuts.ts` | 121 | Phase 1-6: グローバルショートカット + Shift+wheel zoom |
| `src/renderer/src/lib/hooks/use-claude-check.ts` | 80 | Phase 1-7: Claude CLI 検査 + 起動時 updater 遅延 effect |
| `src/renderer/src/lib/app-commands.ts` | 323 | Phase 1-9: コマンドパレット用 Command[] 構築の pure 関数 |
| `src-tauri/src/team_hub/protocol/` (18 ファイル) | 1927 | Phase 2: protocol.rs 分割 |

---

### 残りの作業 (Phase 3 〜 5)

| Phase | 概要 | 状態 | 備考 |
|---|---|---|---|
| **3** | PTY 境界整理 (`commands/terminal.rs` の race 無関係 helper を sub-module に move) | **設計確定済み・実装未着手** | **race 再生産 NG。慎重に進める**。Phase 3 詳細設計は本文書末尾参照 |
| 4 | `CanvasLayout.tsx` / `SettingsModal.tsx` / `commands/files.rs` の細分化 | 未着手 | 3 PR 想定 |
| 5 | 横断クリーンアップ (`tauri-api.ts` 領域別分割等) | 未着手 | 1 PR |

---

## Phase 3 (PTY 境界整理) — 設計確定済み・実装未着手

### スコープ判定 (慎重に絞った最終案)

引き継ぎ書「**race 再生産 NG。慎重に進める**」を最優先。subagent (Explore + Plan) で慎重に調査した結果、**最小スコープ move-only PR (案 A')** を採用する方針:

#### 触ってよい (race と無関係な純関数群)

`src-tauri/src/commands/terminal.rs` (866 行) のうち、PTY race と無関係な純関数群を `commands/terminal/` 配下の sub-module に move (機械的、ロジック無変更):

| sub-module | 内容 | 推定行数 |
|---|---|---|
| `commands/terminal/paste_image.rs` | `extension_for_mime` / `MAX_PASTED_IMAGE_BYTES` / `cleanup_old_paste_images` / `terminal_save_pasted_image` 本体 + `mime_ext_tests` | ~130 |
| `commands/terminal/codex_instructions.rs` | `prepare_codex_instructions_file` / `cleanup_old_codex_instructions` | ~50 |
| `commands/terminal/command_validation.rs` | `is_valid_terminal_id` / `command_basename` / `configured_terminal_commands` / `is_allowed_terminal_command` / `reject_immediate_exec_args` / `is_codex_command` + `terminal_id_validation_tests` / `codex_command_tests` | ~130 |

`#[tauri::command]` を持つ pub async fn (`terminal_save_pasted_image` 等) は **`terminal.rs` 側に thin wrapper として残す**。これにより `lib.rs` の `invoke_handler!` 登録 (IPC コマンド名) は **1 行も変えない**。

`terminal.rs` は 866 行 → 約 530 行に縮減 (sub-module へ move する純関数群が約 310 行 + thin wrapper 化による本体短縮で約 26 行追加削減)。

#### 絶対に触らない (race 再生産リスクが大きい領域)

| 領域 | 場所 | 触らない理由 |
|---|---|---|
| pre-subscribe + client-generated id | `use-pty-session.ts:464-548` | Issue #285 / PR #291 race 再生産 NG |
| `disposed` 再判定 + `localDisposed` 二段防衛 | `use-pty-session.ts:196-203, 358-361, 417, 501-516` | 不変式 #4 |
| HMR `attached === true` の queue → replay → flush 順 | `use-pty-session.ts:581-654` | Issue #285 follow-up Codex Lane 0/1/3 修正 |
| `terminal_create` の id 衝突リトライ | `terminal.rs:579-610` | Issue #292 atomic 検出 |
| `attach_if_exists` preflight (snapshot 取得含む) | `terminal.rs:421-459` | Issue #271 + #285 follow-up |
| `inject_codex_prompt_to_pty` の 1.8s + 15ms チャンク | `terminal.rs:250-296` | TUI race の経験値 |
| 16ms / 32KB / 50ms startup delay | `batcher.rs:13-22` | renderer 60fps 維持 / cold start 取りこぼし防止 |
| `safe_utf8_boundary` / scrollback `append_scrollback` | `batcher.rs:110` / `session.rs:31` | UTF-8 文字化け / scrollback テスト一式 |
| `should_inherit_env` (ConPTY env allowlist) | `session.rs:278-323` | Issue #211 |
| `spawn_session` 全体 (reader thread / mpsc / batcher 起動) | `session.rs:492-604` | reader → mpsc → batcher → emit のタイミングが PTY race の核心 |
| `claude_watcher::spawn_watcher` 呼び出し | `terminal.rs:634-653` | jsonl 監視の race |

#### `use-pty-session.ts` (`src/renderer/src/lib/use-pty-session.ts`, 744 行) は触らない

既に effect 内で `loadInitialMetrics` / `attemptPreSubscribe` / `setupPostSubscribe` の 3 helper に分割済み。これ以上のファイル分離は:

- effect-local closure (`localDisposed` / `myGeneration` / `offData/Exit/SessionId` / `repairFrame` / `attachQueue`) を跨いで state を共有する設計を破壊し、stale closure / 二重解除 race を再生産しうる
- `subscribeEventReady` await 直後の `if (localDisposed || disposedRef.current)` 再判定は **caller 責務** (不変式 #4)。helper 化すると「helper の戻り値で disposed をどう伝えるか」の追加 API が必要で、検知漏れリスクが上がる
- ファイル内コメントが Issue #285 / #271 / Codex Lane 0/1/3 の経緯を時系列で記述しており、分割するとこの文脈が失われる

→ **`use-pty-session.ts` は完成形として今後も touch しない方針** を Phase 3 PR と本書で明記する。

### 推奨実装ステップ (Phase 3 を再開する次回セッション向け)

```text
ステップ 0  ブランチ refactor/issue-373-phase3-terminal-helpers を origin/main から切る
            (運用ルールに従い main fetch → 切る → push 直前に再 fetch)

ステップ 1  commands/terminal/paste_image.rs を作成 (move only)
            - 内部関数として `pub async fn save(base64, mime_type) -> SavePastedImageResult`
            - SavePastedImageResult struct は terminal.rs に残す (Tauri IPC で公開)
            - terminal.rs 側は #[tauri::command] async fn terminal_save_pasted_image を残し
              本体は paste_image::save に委譲する thin wrapper に
            - mime_ext_tests も移動
            検証: cargo check / cargo test mime_ext_tests / npm run typecheck

ステップ 2  commands/terminal/codex_instructions.rs を作成 (move only)
            - prepare_codex_instructions_file / cleanup_old_codex_instructions
            - terminal.rs 側は use 文だけで参照
            - inject_codex_prompt_to_pty は terminal.rs に残す (race-sensitive)
            検証: cargo check

ステップ 3  commands/terminal/command_validation.rs を作成 (move only)
            - 6 つの純粋バリデータ + 2 つの test mod
            検証: cargo check / cargo test terminal_id_validation_tests codex_command_tests

ステップ 4  terminal.rs 冒頭に mod 宣言 + use 整理
            - mod command_validation; mod codex_instructions; mod paste_image;
            - 関数の並べ替えは行わない (diff を最小に)

ステップ 5  cargo clippy --workspace --all-targets で新規警告 0 を確認
```

各ステップで `git diff` を見て **「関数本体の 1 文字も変えていない」** ことを目視確認 (signature・doc コメント・cfg・型注釈すべて bit identical)。

### Phase 3 検証 (`tasks/refactor-smoke.md` Phase 3 必須)

※ smoke 項目番号 (#1, #2, ...) の定義は `tasks/refactor-smoke.md` を参照。

| # | 項目 | 重点確認 |
|---|---|---|
| #1 | IDE 初回ターミナルで Claude banner 欠落なし | pre-subscribe race が再生産していないこと |
| #2 | Canvas で Claude / Codex agent カードを spawn → 初回出力 | `inject_codex_prompt_to_pty` の 1.8s + 15ms チャンク不変 |
| #3 | Canvas ↔ IDE 切替 で PTY 生存 | `attach_if_exists` preflight + scrollback snapshot |
| #5 | HMR で xterm が attach replay される | `hmrPtyCache` + queue → replay → flush 順序 |

---

## 不変式 (Issue #373 — 全 Phase 通して絶対に壊さない)

リファクタ中に **これらの 1 つでも壊れたら revert する**:

1. **`shared.ts` ⇄ Rust struct ⇄ `tauri-api.ts` の三点同期** (型・関数名・camelCase 規約)
2. **既存 IPC コマンド名と event 名は一切変えない**
3. **`subscribeEventReady` + client-generated id の pre-subscribe パターンを維持** (Issue #285 / PR #291 race 再生産禁止)
4. **`subscribeEventReady` await 解決直後の disposed 再判定を維持** (caller 責務、helper 側で検知不可)
5. **Canvas は常時マウント前提を崩さない** (`CanvasLayout.tsx` の `display:none` 切替を unmount に変えない — PTY が kill される)
6. **設定永続化の Single Source of Truth は Rust 側 `~/.vibe-editor/settings.json`**
7. **Renderer から OS リソースに直接触らない** (fs / 外部プロセス / network は必ず Rust IPC 経由)

---

## 運用ルール

### ブランチ命名

- `refactor/issue-373-phase<N>-<M>-<short-name>` (例: `refactor/issue-373-phase1-2-file-tabs`)
- docs 系は `docs/issue-373-<short-name>`

### コミット message

- Conventional Commits 厳守: `refactor(app): #373 Phase 1-X ...` / `refactor(team-hub): #373 Phase 2 ...` / `docs(refactor): #373 ...`
- Claude / Anthropic クレジット行は **絶対に付けない** (CLAUDE.md ルール)
- 末尾に `Refs #373` を付与 (最後の Phase 5 完了 PR のみ `Closes #373`)

### PR レビューループ

1. PR を出したら `vibe-editor-reviewer` (GitHub bot) が自動レビュー
2. 指摘があれば修正 → 再 push → 再レビューが merge まで自動
3. CodeRabbit は **任意** (いずれの Phase でも WSL Ubuntu の `coderabbit review --prompt-only --base main --type committed --no-color` で実行可、hourly cap あり)
4. **trivial 判定で即 merge されることがある** → CodeRabbit 指摘修正は別 PR に分けるのが安全
5. Phase 1 〜 2 の経験では **多くは初回 LGTM で即 merge**。Phase 1-2 のみ proofread Warning が 1 件出て fixup PR で吸収した

### 検証コマンド (Phase 完了ごと)

```bash
npm run typecheck
cargo check --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --no-deps
```

3 つすべて green が PR 提出の最低条件。`cargo clippy` は **新規警告ゼロ** が判定基準 (既存件数の最新値は `tasks/refactor-clippy-baseline.md` を参照)。

`cargo test` は team_hub 触る Phase 2 / PTY 触る Phase 3 では必須。それ以外は影響範囲によって判断。

### CRLF → LF 正規化

PowerShell から Write tool で書いたファイルは CRLF になることがある。commit 前に必ず:

```powershell
$content = [System.IO.File]::ReadAllText($path)
$lf = $content -replace "`r`n", "`n"
[System.IO.File]::WriteAllText($path, $lf)
```

で LF に正規化する (Phase 1-2 で `git stash` 経由のトラブルを引き起こした実績あり)。

### Phase ごとの手動 smoke

`tasks/refactor-smoke.md` の対応表に従う:

| Phase | 必須項目 | 任意項目 |
|---|---|---|
| Phase 1 各 hook 切り出し PR | #1, #4, #7 | #2, #3, #5, #6 |
| Phase 2 (team_hub) | #6 | #1, #2 |
| Phase 3 (PTY 境界) | #1, #2, #3, #5 | — |
| Phase 4 / 5 | 全項目 | — |

---

## 「やらないこと」(Issue #373 out of scope)

- ❌ `i18n.ts` (1047 行) の分割
- ❌ `subscribeEvent` / `subscribeEventReady` API の統合
- ❌ zustand への全 state 移行 (`SettingsContext` / `ToastContext` は永続層境界として残す)
- ❌ Tailwind 導入 / CSS フレームワーク変更
- ❌ 機能追加 / バグ修正の同梱 (見つけたら別 issue を切る)
- ❌ **`use-pty-session.ts` のさらなる分割** (Phase 3 設計で確定: race 再生産リスクが見返りに見合わない)
- ❌ **`pty/{session,batcher,registry,claude_watcher}.rs` の責務再分割** (Phase 3 では Rust 側 commands 層の純関数 helper のみ移動)

---

## 既知のリスク・注意点

### Phase 1 系で解消されたリスク

- ✅ ref ブリッジ (`confirmDiscardRef` / `projectSwitchedRef` / `projectLoadedRef`) は Phase 1-1 〜 1-7 で順次縮小。Phase 1-4 完了時点で残るのは **`closeTeamRef` 1 本のみ** (`useTerminalTabs.opts.closeTeam` → `useTeamManagement.doCloseTeam` の唯一の逆方向参照)。これは use-terminal-tabs と use-team-management の本質的な依存方向のため Phase 1 系では解消できない (Phase 5 で再検討余地あり)
- ✅ Phase 1-8 で `paletteOpen` / `settingsOpen` / `status` が `useUiStore` に集約され、`useAppShortcuts.opts` が 9 keys → 5 keys、`useProjectLoader.opts` が 4 keys → 3 keys に縮小

### Phase 3 のリスク (Phase 3 PR を出す次回セッション向け)

- **paste_image / codex_instructions / command_validation の純関数群は race と完全に独立** (調査済み)。move 後も `terminal_create` 内の呼び出しタイミング・await 位置は不変
- **`SavePastedImageResult` struct は `terminal.rs` に残す** (Tauri IPC で公開する型のため、`commands/terminal/paste_image.rs` から `pub use` するか、struct 自体は terminal.rs に残して `paste_image::save(...)` の戻り値で参照する)
- **`#[tauri::command]` 関数は terminal.rs に残し、本体を sub-module の `pub async fn save(...)` 等に委譲する thin wrapper にする**。これにより `lib.rs` の `invoke_handler!` 登録は無変更
- **`inject_codex_prompt_to_pty` は move しない** (`tauri::async_runtime::spawn` 内で `Arc<SessionRegistry>` を受けて 1.8s sleep する race-sensitive 経路)
- 各 sub-module 移行ごとに `cargo check` / `cargo test` を必ず通し、move 中の `use` 文漏れを防ぐ
- レビュアー bot が trivial 判定で即 merge することがある → CodeRabbit 指摘吸収用の追跡 PR を出す覚悟で進める

### Phase 4 (CanvasLayout / SettingsModal / commands/files.rs) のリスク

- 「Canvas は常時マウント前提を崩さない」(不変式 #5) を絶対に守る。`display:none` 切替を unmount に変えると PTY が kill される
- `SettingsModal.tsx` は settings 各種項目の UI が密集しているので、サブコンポーネント化する際に value/setter のドリリングが増えないように注意
- `commands/files.rs` の責務分割は機械的だが、`atomic_write` / `fs_watch` / `role_profiles` 等の隣接ファイルとの import 関係を確認する

### Phase 5 (横断クリーンアップ)

- `lib/tauri-api.ts` を領域別 (`tauri-api/{git,fs,terminal,sessions,...}.ts`) に分割するなど
- 引き継ぎ書 (`tasks/refactor-handoff.md`) の最終更新と、ベースラインタグ `refactor-baseline-v1.4.7` を main に打つ作業も Phase 5 完了時に行う

---

## 参考リンク

- Issue: https://github.com/yusei531642/vibe-editor/issues/373
- 関連 PR (merged): #380, #382, #384, #389, #390, #391, #392, #393, #394, #395, #396, #399
- 関連 follow-up issue: #381 (clippy)
- ベースラインタグ予定: `refactor-baseline-v1.4.7` (※ まだ打っていない、Phase 5 完了時に main で打つ)

---

## Phase 1-1 〜 Phase 2 で確立した流儀 (新規 hook を書くときの参考)

### opts ref パターン

```ts
export function useXxx(opts: UseXxxOptions): UseXxxResult {
  const optsRef = useRef(opts);
  optsRef.current = opts;  // 毎 render 更新

  const someCallback = useCallback(() => {
    const o = optsRef.current;  // 最新値を読む
    // ...
  }, []);  // ← deps を最小化
}
```

これにより:
- `useEffect` / `useCallback` の deps を `[]` または最小限に保てる
- TDZ (Temporal Dead Zone) 問題を回避できる (forward ref パターン)
- 子コンポーネントへの callback identity が安定 (memo 効率化)

### useT / useSettingsValue は hook 内で直接呼ぶ

opts を肥大化させず、`settings-context.tsx` の流儀に揃える。

### resetForProjectSwitch を expose

projectSwitchedRef.current から呼べるようにすることで、project 切替時のリセット責務を hook に閉じる。

### Phase 1-5 / 1-7 / 1-9 は opts なし

純粋に settings から読むだけの責務 (Phase 1-5) や、純粋関数 (Phase 1-9) は opts を取らない。

---

## Phase 1-9 で書いた pure 関数モジュール (参考実装)

`src/renderer/src/lib/app-commands.ts` (323 行) は **副作用なしの pure 関数 `buildAppCommands(deps)`** を export し、App.tsx 側で `useMemo(() => buildAppCommands(...), [deps])` で memoize する流儀。

`react-hooks/exhaustive-deps` の Lint は呼び出し側で機能する。同じ流儀の先例は `src/renderer/src/lib/team-prompts.ts` (Phase 1-4)。

deps の identity 振動を防ぐため、配列を生で渡さず `*Length` や `slice` のみを受ける設計にする。

---

## Phase 2 で確立した Rust 側分割の流儀 (Phase 4 で `commands/files.rs` を分割するときの参考)

### ファイル構成

```
src-tauri/src/<domain>/
  mod.rs       — 公開 API + dispatch / entry point のみ (~100-200 行)
  consts.rs    — 定数
  schema.rs    — JSON Schema 定義 (該当する場合)
  helpers.rs   — 共通 helper + 関連する unit test
  <feature>/
    mod.rs              — pub use 集約
    <feature_a>.rs      — 個別機能の実装
    <feature_b>.rs
    ...
```

### 公開 API の保持

- 外部から見える symbol は **`mod.rs` の `pub` 関数 1 つだけ** にするのが理想 (`team_hub::protocol::handle` のパターン)
- 各 sub-module の関数は `pub` で OK (sub-module 自体が `mod xxx;` で private なら crate 外には漏れない)

### serde derive / JSON Schema は逐字保持

- `#[serde(rename_all = ...)]` 等を含む struct 定義は **絶対に文字列単位で保持**
- JSON Schema (`tools/list` や IPC コマンドの戻り値型) も逐字保持 (renderer / 外部 MCP クライアントが文字列マッチに依存する可能性)

### 各 sub-module 移行ごとに cargo check

- `mkdir` → ファイル作成 → cargo check → 不要 import 削除 → cargo check のループ
- 段階的に進めれば、import 漏れや循環参照のデバッグが集中せずに済む
