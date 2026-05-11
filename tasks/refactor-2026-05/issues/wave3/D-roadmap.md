TITLE: [refactor] meta: 2026-05 リファクタリング roadmap (LOW findings + 設計改善案を集約)
LABELS: refactor,plan

## 概要

2026-05 の脆弱性・バグ調査 (`tasks/refactor-2026-05/`) で抽出した LOW 重要度の findings と設計改善案を 1 つの roadmap として集約する。個別 issue は立てず、本 issue の checklist で進捗管理する。

## 根本原因 / Root cause

N/A (集約 issue のため、各項目の詳細は `tasks/refactor-2026-05/findings.md` を参照)

## 再現手順 / Repro

N/A (集約 issue のため、各項目の詳細は `tasks/refactor-2026-05/findings.md` を参照)

## チェックリスト (Tier D 全項目)

### PTY pipeline
- [ ] subscribeEvent (sync) を terminal.* で公開しているが、新規 spawn でうっかり使うと #285 が再発する: `src/renderer/src/lib/tauri-api/terminal.ts:28-35`
- [ ] inject_codex_prompt_to_pty が固定 1.8 秒 sleep で TUI 準備を待つ「magic timing」: `src-tauri/src/commands/terminal.rs:99-100`
- [ ] safe_utf8_boundary は UTF-8 boundary しか守らないが scrollback が CP932 を含むと先頭 skip が無限消費する潜在: `src-tauri/src/pty/scrollback.rs:65-72`
- [ ] terminal_create 失敗時の codex temp file が tempdir に残留: `src-tauri/src/commands/terminal/codex_instructions.rs:12-28`
- [ ] reader thread が `read()` Err 時に `break` するが理由を記録しない: `src-tauri/src/pty/session.rs:1046-1060`
- [ ] resolve_valid_cwd の `Path::new(p).is_dir()` は symlink を辿る (TOCTOU): `src-tauri/src/pty/session.rs:197-201`

### Canvas
- [ ] pulseEdge の id が `handoff-${messageId}-${Date.now()}` で同 messageId の重複が dedup されない: Canvas.tsx:304-311
- [ ] clear() が arrangeGap と lastRecruitFocus を残す: stores/canvas.ts:258-265
- [ ] addCard の fallback grid と CanvasLayout.stagger で同じロジックが二重実装

### TeamHub
- [ ] dispatch_tool の Unknown tool error から tool 名が漏れる: `protocol/mod.rs:69-73`
- [ ] handshake で hello_line.len() check が byte len で 1024 を判定: `team_hub/mod.rs:153-176`
- [ ] cleanup_old_spools が race で worker が読みかけのファイルを削除: `team_hub/spool.rs:95-146`
- [ ] team_create_leader と team_recruit が同 semaphore を共有 (starvation): `state.rs:889-914`
- [ ] team_diagnostics の serverLogPath が VIBE_TEAM_LOG_PATH 経由で reduce_home_prefix される前に env を信頼
- [ ] team_send.handoff_id が control char 含めて record_handoff_lifecycle に渡る
- [ ] resolve_targets で role/agent_id の Unicode 正規化が抜けている: `helpers.rs:10-38`

### IPC commands
- [ ] is_codex_command の Windows 拡張子テスト追加
- [ ] dialog_open_folder の `result.map(|p| p.to_string())` が Tauri 2 の `FilePath` の正規化結果を捨てる
- [ ] team_presets の case-insensitive FS 衝突
- [ ] logs_open_dir のサニタイズなし
- [ ] app_recruit_ack の phase=None && ok=false 経路の区別
- [ ] terminal_kill / resize / write が `is_valid_terminal_id` をかけていない
- [ ] app_check_claude の戻り値 path を redact_home でマスク
- [ ] fs_watch generation 切替を cancel token 化
- [ ] apply_window_effects を effect kind enum 化
- [ ] handoffs / team_state の safe_segment / project_key を共通化
- [ ] files_write の symlink follow を廃止 (TOCTOU 経路の閉鎖)

### Updater / Markdown / i18n / theme
- [ ] silent updater check の署名失敗を 1 回だけユーザー通知
- [ ] reveal_in_file_manager の .lnk/.exe 等を弾く
- [ ] team-bridge の pending overflow 時に JSON-RPC error を返す
- [ ] team_history.hydrate_orchestration_summary を並列化
- [ ] role-profiles-context の load 完全置換 (HMR 残存解消)
- [ ] App.tsx の Ctrl+B を useKeybinding に集約 (xterm passthrough)
- [ ] i18n fallback chain を `en → key` に統一 + 訳キー対称性 test
- [ ] applyTheme の triggerSetWindowEffects coalescing
- [ ] dialog_is_folder_empty で /var を一律拒否しない
- [ ] command palette themeOrder を THEMES Object 単一ソース化
- [ ] SAVE_LOCK パターンを atomic_write 側 helper に集約
- [ ] MarkdownPreview の `ADD_ATTR: ['target']` 撤廃
- [ ] dependency 監視: `cargo audit` を CI に追加

### 設計改善 (Refactor opportunities)
- [ ] PTY エンコーディング pipeline 分離 (raw bytes → decoded UTF-8 → scrollback)
- [ ] inject の責務統一 (`SessionHandle::inject_text` 共通 helper)
- [ ] Windows 抽象 (`pty/windows.rs` / `pty/unix.rs` の trait 分離)
- [ ] prompt injection 防御の集約 (`team_hub::sanitize`)
- [ ] agent_id 検証の中央化 (`validate_agent_id`)
- [ ] file_locks の永続化 (Hub 再起動を跨ぐ orphan 防止)
- [ ] Hub state machine の整理 (`enum RecruitState`)
- [ ] engine 抽象 (`enum Engine { Claude, Codex }`)
- [ ] socket 接続切断時の lock 解放 hook
- [ ] IPC 認可中央化 (`commands/authz.rs`)
- [ ] path 検証 helper 統合 (`commands/path_guard.rs`)
- [ ] atomic_write を `PersistableStore<T>` facade に昇格
- [ ] settings migration インフラ (Rust 側 schema 整合)
- [ ] git wrapper 統一 (`GitCommand::run_text` / `run_bytes`)
- [ ] CommandError variant 拡張 (`Authz` / `SizeLimit` / `TooManyRequests`)
- [ ] IPC 引数 wrap 規約統一 (`{ args }` vs flat の混在解消)
- [ ] tracing-appender::rolling::daily + 古い世代削除 pruner
- [ ] updater endpoints の二重化 (Tier A の延長として再掲)

## 進捗管理

各項目に対応する PR を出すたびに本 issue の checkbox を check する。完了した項目があれば本 issue 末尾に「Resolved by #<PR>」を追記。

全項目 100% 完了時に本 issue を close。

## 関連

- Related plan: `tasks/refactor-2026-05/plan.md`
- Related findings: `tasks/refactor-2026-05/findings.md`
