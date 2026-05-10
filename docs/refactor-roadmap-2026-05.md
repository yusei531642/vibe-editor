# vibe-editor リファクタリング roadmap (2026-05)

調査時期: 2026-05-09 / Tracking issue: [#645](https://github.com/yusei531642/vibe-editor/issues/645)

## 位置付け

2026-05 の脆弱性・バグ調査 (`tasks/refactor-2026-05/plan.md` および `findings.md`) で抽出した
**Tier D (LOW findings + 設計改善案)** を 1 つの roadmap に集約したもの。

- Tier S/A/B/C は個別 issue を起票し、bot による自動 merge で順次解消する。
- Tier D は **個別 issue を立てず**、本ドキュメントと issue [#645](https://github.com/yusei531642/vibe-editor/issues/645) の checkbox で進捗管理する。
- 各項目に対応する PR が出るたび、issue #645 の checkbox を check し、本ドキュメントの「Status / 関連 PR」列を更新する。
- 全項目 100% 完了時に issue #645 を close する。

## 関連ドキュメント

| ファイル | 役割 |
|---|---|
| `tasks/refactor-2026-05/plan.md` | Tier 全体計画 (S/A/B/C/D の優先度付け / sprint 計画) |
| `tasks/refactor-2026-05/findings.md` | 5 領域 subagent の raw findings (60+ findings の詳細) |
| `docs/refactor-roadmap-2026-05.md` (本ファイル) | Tier D 集約 + 進捗 tracking |

> 注: `tasks/refactor-2026-05/` 配下は調査時の作業ログとして untracked のまま参照する。
> 本 roadmap の各項目から findings.md に link を張り、根拠を引けるようにしている。

## ラベル運用

issue #645 には次のラベルを付与する。

- 種類: `refactor`
- 集約系: `plan`
- 文書: `documentation`

個別 PR が起票される場合 (本 roadmap 由来の項目を片付ける PR) は、`refactor` + 領域ラベル
(`rust` / `javascript` / `canvas` / `ui` / `settings` / `persistence` / `i18n` / `a11y` 等)
の組み合わせで貼る。

---

## Tier D: PTY pipeline (LOW findings 6 件)

| # | 項目 | 関連 file:line | Status / 関連 PR |
|---|------|----------------|------------------|
| PTY-1 | `subscribeEvent` (sync) を `terminal.*` で公開しているが、新規 spawn でうっかり使うと #285 が再発する | `src/renderer/src/lib/tauri-api/terminal.ts:28-35` | open |
| PTY-2 | `inject_codex_prompt_to_pty` が固定 1.8 秒 sleep で TUI 準備を待つ「magic timing」 | `src-tauri/src/commands/terminal.rs:99-100` | open |
| PTY-3 | `safe_utf8_boundary` は UTF-8 境界しか守らないため scrollback が CP932 を含むと先頭 skip が無限消費する潜在 | `src-tauri/src/pty/scrollback.rs:65-72` | open |
| PTY-4 | `terminal_create` 失敗時の codex temp file が tempdir に残留 | `src-tauri/src/commands/terminal/codex_instructions.rs:12-28` | open |
| PTY-5 | reader thread が `read()` Err 時に `break` するが理由を記録しない | `src-tauri/src/pty/session.rs:1046-1060` | open |
| PTY-6 | `resolve_valid_cwd` の `Path::new(p).is_dir()` は symlink を辿る (TOCTOU + symlink-attack 余地) | `src-tauri/src/pty/session.rs:197-201` | open |

詳細は `tasks/refactor-2026-05/findings.md` の「領域 1: PTY / xterm」を参照。

---

## Tier D: Canvas (LOW findings 3 件)

| # | 項目 | 関連 file:line | Status / 関連 PR |
|---|------|----------------|------------------|
| CV-1 | `pulseEdge` の id が `handoff-${messageId}-${Date.now()}` で同 messageId の重複が dedup されない | `src/renderer/src/components/canvas/Canvas.tsx:304-311` | open |
| CV-2 | `clear()` が `arrangeGap` と `lastRecruitFocus` を残す | `src/renderer/src/stores/canvas.ts:258-265` | open |
| CV-3 | `addCard` の fallback grid (no position) と `CanvasLayout.stagger` で同じロジックが二重実装 | `src/renderer/src/stores/canvas.ts`, `src/renderer/src/layouts/CanvasLayout.tsx` | open |

詳細は `tasks/refactor-2026-05/findings.md` の「領域 2: Canvas」を参照。

---

## Tier D: TeamHub (LOW findings 7 件)

| # | 項目 | 関連 file:line | Status / 関連 PR |
|---|------|----------------|------------------|
| TH-1 | `dispatch_tool` の Unknown tool error から tool 名が漏れる (recon 抑止) | `src-tauri/src/team_hub/protocol/mod.rs:69-73` | open |
| TH-2 | handshake で `hello_line.len()` check が byte len で 1024 を判定 (BufReader capacity を絞って DoS 強化) | `src-tauri/src/team_hub/mod.rs:153-176` | open |
| TH-3 | `cleanup_old_spools` が race で worker が読みかけのファイルを削除 | `src-tauri/src/team_hub/spool.rs:95-146` | open |
| TH-4 | `team_create_leader` と `team_recruit` が同 semaphore を共有 (4 連続 leader 切替で starvation) | `src-tauri/src/team_hub/state.rs:889-914` | open |
| TH-5 | `team_diagnostics` の `serverLogPath` が `VIBE_TEAM_LOG_PATH` 経由で `reduce_home_prefix` される前に env を信頼 | `src-tauri/src/team_hub/state.rs:140-154` | open |
| TH-6 | `team_send.handoff_id` が control char 含めて `record_handoff_lifecycle` に渡る | `src-tauri/src/team_hub/protocol/tools/send.rs:243`, `state.rs:1312-1358` | open |
| TH-7 | `resolve_targets` で role/agent_id の Unicode 正規化が抜けている | `src-tauri/src/team_hub/protocol/helpers.rs:10-38` | open |

詳細は `tasks/refactor-2026-05/findings.md` の「領域 3: TeamHub / vibe-team mcp」を参照。

---

## Tier D: IPC commands (LOW findings 11 件)

| # | 項目 | 関連 file:line | Status / 関連 PR |
|---|------|----------------|------------------|
| IPC-1 | `is_codex_command` の Windows 拡張子 (`.bat` / `.cmd`) テスト追加 | `src-tauri/src/commands/terminal/command_validation.rs:191-198` | open |
| IPC-2 | `dialog_open_folder` の `result.map(|p| p.to_string())` が Tauri 2 の `FilePath` の正規化結果を捨てる | `src-tauri/src/commands/dialog.rs:16-19` | open |
| IPC-3 | `team_presets` の case-insensitive FS 衝突検出 | `src-tauri/src/commands/team_presets.rs:113-150` | open |
| IPC-4 | `logs_open_dir` のサニタイズ追加 | `src-tauri/src/commands/logs.rs:103-116` | open |
| IPC-5 | `app_recruit_ack` の `phase=None && ok=false` 経路の区別 | `src-tauri/src/commands/app/team_mcp.rs:354-364` | open |
| IPC-6 | `terminal_kill` / `terminal_resize` / `terminal_write` が `is_valid_terminal_id` をかけていない | `src-tauri/src/commands/terminal.rs:439-491` | open |
| IPC-7 | `app_check_claude` の戻り値 path を `redact_home` でマスク | `src-tauri/src/commands/app/window.rs:27-55` | open |
| IPC-8 | `fs_watch` generation 切替を cancel token 化して即時停止 | `src-tauri/src/commands/fs_watch.rs:110-227` | open |
| IPC-9 | `apply_window_effects` を effect kind enum 化 | `src-tauri/src/commands/app/window.rs:111-150` | open |
| IPC-10 | `handoffs` / `team_state` の `safe_segment` / `project_key` を共通化 (DRY) | `src-tauri/src/commands/handoffs.rs:120-134`, `team_state.rs:277-291` | open |
| IPC-11 | `files_write` の symlink follow を廃止 (TOCTOU 経路の閉鎖) | `src-tauri/src/commands/files.rs:286-333` | open |

詳細は `tasks/refactor-2026-05/findings.md` の「領域 4: IPC commands」を参照。

---

## Tier D: Updater / Markdown / i18n / theme (LOW findings 13 件)

| # | 項目 | 関連 file:line / 関連 issue | Status / 関連 PR |
|---|------|------------------------------|------------------|
| X-1 | silent updater check の署名失敗を 1 回だけユーザー通知 | `src/renderer/src/lib/updater-check.ts:86-87` (関連: [#609](https://github.com/yusei531642/vibe-editor/issues/609)) | open |
| X-2 | `reveal_in_file_manager` の `.lnk` / `.exe` / `.bat` / `.cmd` / `.scr` / `.url` 等を弾く | `src-tauri/src/commands/app/window.rs:267-305` | open |
| X-3 | team-bridge の `pendingOut` overflow 時に JSON-RPC error を返す | `src-tauri/src/team_hub/bridge.rs:69-75` | open |
| X-4 | `team_history.hydrate_orchestration_summary` を並列化 (N×file I/O 解消) | `src-tauri/src/commands/team_history.rs:195-201, 240-242` | open |
| X-5 | role-profiles-context の load 完全置換 (HMR 残存解消) | `src/renderer/src/lib/role-profiles-context.tsx` | open |
| X-6 | `App.tsx` の `Ctrl+B` を `useKeybinding` に集約 (xterm passthrough) | `src/renderer/src/main.tsx`, `src/renderer/src/lib/keybindings.ts:65`, `App.tsx:648-658` | open |
| X-7 | i18n fallback chain を `en → key` に統一 + 訳キー対称性 test | `src/renderer/src/lib/i18n.ts:1311-1315` | open |
| X-8 | `applyTheme` の `triggerSetWindowEffects` coalescing (glass→glass 連打抑止) | `src/renderer/src/lib/themes.ts:299-321` | open |
| X-9 | `dialog_is_folder_empty` で `/var` を一律拒否しない (Linux `/var/tmp` プロジェクト誤拒否) | `src-tauri/src/commands/dialog.rs:62-69` | open |
| X-10 | command palette `themeOrder` を `THEMES` Object 単一ソース化 | `src/renderer/src/lib/app-commands.ts:6-13` | open |
| X-11 | `SAVE_LOCK` パターンを `atomic_write` 側 helper に集約 (settings / role_profiles / team_history / team_presets の 4 重定義) | `src-tauri/src/commands/settings.rs`, `role_profiles.rs`, `team_history.rs`, `team_presets.rs` | open |
| X-12 | `MarkdownPreview` の `ADD_ATTR: ['target']` 撤廃 + marked v18 async モード見直し | `src/renderer/src/components/MarkdownPreview.tsx` | open |
| X-13 | dependency 監視: `cargo audit` を CI に追加 (関連: [#97](https://github.com/yusei531642/vibe-editor/issues/97), [#205](https://github.com/yusei531642/vibe-editor/issues/205), [#218](https://github.com/yusei531642/vibe-editor/issues/218)) | `.github/workflows/*.yml` | open |

詳細は `tasks/refactor-2026-05/findings.md` の「領域 5: Cross-domain」および各領域の Tier D セクションを参照。

---

## 設計改善 (Refactor opportunities, 18 件)

LOW findings の延長として、構造的な改善案。これらは「個別 PR で改善案を一括導入」または
「対応する Tier S/A/B/C の修正に乗せて段階的に導入」のいずれかで進める。

### PTY pipeline

| # | 改善案 | Status / 関連 PR |
|---|--------|------------------|
| R-1 | PTY エンコーディング pipeline 分離 (raw bytes → decoded UTF-8 → scrollback の 3 stage) | open |
| R-2 | inject の責務統一 (`SessionHandle::inject_text` 共通 helper / `team_hub::inject` + `terminal::inject_codex_prompt` の DRY 化) | open |
| R-3 | Windows 抽象 (`pty/windows.rs` / `pty/unix.rs` の trait 分離) | open |

### TeamHub

| # | 改善案 | Status / 関連 PR |
|---|--------|------------------|
| R-4 | prompt injection 防御の集約 (`team_hub::sanitize` 共通 helper) | open |
| R-5 | `agent_id` 検証の中央化 (`validate_agent_id` helper) | open |
| R-6 | `file_locks` の永続化 (Hub 再起動を跨ぐ orphan 防止) | open |
| R-7 | Hub state machine の整理 (`enum RecruitState { ... }`) | open |
| R-8 | engine 抽象 (`enum Engine { Claude, Codex }`) | open |
| R-9 | socket 接続切断時の lock 解放 hook | open |

### IPC

| # | 改善案 | Status / 関連 PR |
|---|--------|------------------|
| R-10 | IPC 認可中央化 (`commands/authz.rs` で `project_root` 一致を helper 化) | open |
| R-11 | path 検証 helper 統合 (`commands/path_guard.rs`) | open |
| R-12 | `atomic_write` を「設定永続化 facade」に昇格 (`PersistableStore<T>`) | open |
| R-13 | settings migration インフラ (Rust 側 schema 整合) | open |
| R-14 | git wrapper 統一 (`GitCommand::run_text` / `run_bytes`) | open |
| R-15 | `CommandError` variant 拡張 (`Authz` / `SizeLimit` / `TooManyRequests`) | open |
| R-16 | IPC 引数 wrap 規約統一 (`{ args }` vs flat の混在解消) | open |

### Logging / Updater

| # | 改善案 | Status / 関連 PR |
|---|--------|------------------|
| R-17 | `tracing-appender::rolling::daily` + 古い世代削除 pruner (関連: [#643](https://github.com/yusei531642/vibe-editor/issues/643)) | open |
| R-18 | updater endpoints の二重化 (Tier A の延長として再掲 / 関連: [#609](https://github.com/yusei531642/vibe-editor/issues/609)) | open |

---

## 進捗管理ルール

1. 各項目に対応する PR を出すたびに issue [#645](https://github.com/yusei531642/vibe-editor/issues/645) の checkbox を check する。
2. PR が merge されたら、本 roadmap の対応行の `Status / 関連 PR` 列を `Resolved by #<PR>` に書き換える。
3. issue [#645](https://github.com/yusei531642/vibe-editor/issues/645) 末尾に `Resolved by #<PR>` を追記する。
4. 全項目 (PTY-1〜6, CV-1〜3, TH-1〜7, IPC-1〜11, X-1〜13, R-1〜18) が `Resolved by ...` になった時点で issue #645 を close する。

bot review が直列 merge である制約上、Tier D は急がず Tier S+A+B+C の sprint と並行で消化する。
