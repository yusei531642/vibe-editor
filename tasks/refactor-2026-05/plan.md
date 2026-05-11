# vibe-editor リファクタ計画 (2026-05)

調査日: 2026-05-09
調査者: Leader (Claude Opus 4.7)
調査範囲: Canvas (xyflow) / PTY (xterm + portable-pty) / TeamHub / vibe-team mcp / IPC commands / Updater / Sessions / Dialog / Role profiles / Settings / Image paste / その他

## 概要

5 並列 subagent (windows-pty-reviewer + general-purpose×4) で `src-tauri/` 配下と `src/renderer/src/` の主要モジュールを横断レビューし、**60+ findings** を抽出した。直近 #507〜#527 / #572〜#588 で大量の hardening が走ったが、`team_update_task` の認可欠落 / `data` fence の bypass / Canvas データ損失 / mcp_config の半端 rollback など、構造的に閉じていない経路が複数残存していることが判明。

本ドキュメントは:

1. 全 findings を **Tier S/A/B/C/D** で優先度付け
2. 実装 sprint 計画 (Tier S+A を最優先で並列実装)
3. 既存 open issue (#585 / #586 / #591 / #592 / #593) への補足方針
4. 起票リスト (`gh issue create` 用テンプレート)

をまとめる。Tier D (LOW / refactor opportunities ~15 件) は **roadmap issue 1 件** にバンドルし、個別起票しない。

## Tier S — CRITICAL (5件) — 即時修正

データ損失または容易な権限昇格に直結する。worker 並列実装の最初の wave で全件着手する。

| # | Title | File | 簡易説明 |
|---|---|---|---|
| S-1 | `[security] team-hub: team_update_task に assignee 検証を追加して任意 worker による task done 化を防ぐ` | `src-tauri/src/team_hub/protocol/tools/update_task.rs:156-292` | 同 team の任意 worker が他者 task を `done` 化 + `done_evidence` 捏造可能。`team_report` (#572) で塞いだ穴の再発 |
| S-2 | `[bug] canvas: EditorCard の未保存内容が close / Clear で確認なく失われる` | `src/renderer/src/components/canvas/cards/EditorCard.tsx:18-93`, `CardFrame.tsx:60-67`, `stores/canvas.ts:199-227`, `layouts/CanvasLayout.tsx:509-516` | IDE 側 `confirmDiscardEditorTabs` 相当が Canvas に欠落 |
| S-3 | `[bug] canvas: AgentNodeCard の unreadInboxCount が連続 handoff で undercount する (closure stale)` | `src/renderer/src/components/canvas/cards/AgentNodeCard/CardFrame.tsx:559-606` | useTeamInboxRead も同パターン。督促判定が壊れる |
| S-4 | `[bug] backend: codex 側の MCP setup 失敗時に rollback できない (claude-only snapshot で半端書き残存)` | `src-tauri/src/commands/app/team_mcp.rs:131-170`, `src-tauri/src/mcp_config/codex.rs:60-92` | codex には `snapshot/restore` API 自体が存在しない。`~/.codex/config.toml` の他セクションを破壊するリスク |
| S-5 | `[bug] sync: TeamOrchestrationState.teamReports が TS 側に未定義 (team_state.rs:215 と shared.ts のズレ)` | `src-tauri/src/commands/team_state.rs:128-215`, `src/types/shared.ts:724-737` | #572 で導入した `team_reports` が renderer に silent drop |

## Tier A — HIGH security (11件)

権限昇格 / 情報漏洩 / 検証 bypass。Tier S と同 sprint で着手する。

| # | Title | 領域 |
|---|---|---|
| A-1 | `[security] team-hub: file_locks の normalize_path が .. と絶対 path を許可・team あたりの lock 数上限なし` | rust / team-hub |
| A-2 | `[security] backend: team_state_read で active project_root 一致を検証 (cross-project leak 防止)` | rust / backend |
| A-3 | `[security] backend: team_diagnostics_read を active team set に限定 (renderer impersonation 防止)` | rust / backend |
| A-4 | `[security] team-hub: data fence に nonce 付与 + sanitize_for_paste で 0-width / RTL / homoglyph を除去` | rust / team-hub |
| A-5 | `[security] team-hub: socket / named pipe で peer UID/SID 検証を追加 (token 盗難の局所封じ込め)` | rust / team-hub |
| A-6 | `[security] team-hub: dynamic_role replay で lint_all を強制 (role-profiles.json#dynamic[] 経由の deny 句注入封じ)` | rust / team-hub / persistence |
| A-7 | `[security] backend: terminal_create attach_if_exists で team_id 一致を検証 (scrollback 漏洩防止)` | rust / backend / pty |
| A-8 | `[security] backend: handoffs_* IPC で active project_root 一致を検証 (cross-project read 防止)` | rust / backend |
| A-9 | `[security] terminal: --resume <id> 注入時の sessionId を UUID-form で validate` | rust / pty |
| A-10 | `[security] backend: atomic_write に mode 引数を追加し mcp_config (~/.claude.json / ~/.codex/config.toml) を 0o600 強制` | rust / backend / security |
| A-11 | `[security] updater: endpoints を二重化 + minisign 署名失敗を 1 回だけユーザー通知` | rust / javascript / dependencies |

## Tier B — HIGH bug (15件)

ユーザー作業を頻繁に阻害するバグ。Tier S+A 完了後の wave で並列実装。

### Canvas (8件)

| # | Title | 関連 |
|---|---|---|
| B-1 | `[bug] canvas: Background grid の color が CSS variable のため SVG attribute で評価されず固定色になる` | #585 (関連) |
| B-2 | `[bug] canvas: Team preset (#522) の Apply が teamId/agentId/setupTeamMcp 抜きで standalone agent を作る` | #522 (regression) |
| B-3 | `[bug] canvas: CanvasSidebar の handleResumeTeam が古いピッチ + placement 抜きで重複配置する` | UX |
| B-4 | `[bug] canvas: Canvas の Ctrl+Shift+K/I/N が IDE モード中も発火し DevTools / IDE 操作を奪う` | UX |
| B-5 | `[bug] canvas: 狭い画面で HUD ボタンが flex-shrink+word-break で日本語縦書き化` | #586 (関連) |
| B-6 | `[bug] canvas: HUD / TeamDashboard が複数 team の集約に対応していない (dual preset で片方の dead count が消える)` | UX |
| B-7 | `[bug] canvas: Pane 右クリックメニューが mousedown の伝播競合で開かない / 閉じない` | #593 (関連) |
| B-8 | `[bug] filetree: primaryRoot を workspace から外す UI が存在しない` | #591 (関連) |

### PTY (4件)

| # | Title | 関連 |
|---|---|---|
| B-9 | `[bug] pty: Windows ConPTY 出力が CP932 シェルで U+FFFD 化する (#120 を batcher に拡張)` | encoding |
| B-10 | `[bug] teamhub: inject() 中の user 入力混入を防ぐため set_injecting(true/false) を必ず呼ぶ` | race |
| B-11 | `[bug] pty: inject_codex_prompt_to_pty が tokio worker をブロックする (spawn_blocking 経由に揃える)` | race |
| B-12 | `[bug] pty: SessionHandle::drop が Mutex poison で kill を silently スキップする` | leak |

### IPC / 横断 (3件)

| # | Title | 関連 |
|---|---|---|
| B-13 | `[security] backend: git_diff の path 検証を safe_join 単独に統一 (substring contains 削除)` | rust / backend |
| B-14 | `[security] backend: paste image を 0o600 に絞り user-only 読み取りに限定` | rust / security |
| B-15 | `[security] backend: IPC 入力サイズ・charset を共通 helper で gate (DoS / log injection 抑止)` | rust / backend |

## Tier C — MEDIUM (20件)

軽微な race / 性能リグレッション / hardening。次次 sprint で消化、bot review 効率を見ながら適宜並列度を増やす。

### Canvas (5件)

| # | Title |
|---|---|
| C-1 | `[bug] canvas: clear() 後 xyflow の viewport が store と desync する` |
| C-2 | `[perf] canvas: AgentNodeCard の teamMembersSig が drag 中も全 agent でフル走査` |
| C-3 | `[perf] canvas: useCanvasTeamRestore が node 追加のたびに O(N) チーム集計を再実行` |
| C-4 | `[bug] canvas: DiffCard / ChangesCard.refresh が unmount 後 setState する` |
| C-5 | `[bug] canvas: subscribeOnVisible が短時間の focus パカパカで誤発火し recruit warning toast が早期 flush する` |

### PTY (4件)

| # | Title |
|---|---|
| C-6 | `[refactor] pty: window CloseRequested で in-flight inject task を待ってから kill_all する` |
| C-7 | `[security] util: vibe_root() が HOME 不在時に CWD 相対パスへ写真を書き出しうる` |
| C-8 | `[refactor] pty: claude_watcher の deadline を session 寿命に追従させ orphan watcher を減らす` |
| C-9 | `[bug] pty: attach 経路で snapshot 〜 listener 登録の窓に emit されたバイトが lost する` |

### TeamHub (5件)

| # | Title |
|---|---|
| C-10 | `[security] team_update_task / team_status: 頻度制限と長さ上限・control char 除去 (autoStale 偽装緩和)` |
| C-11 | `[security] team_assign_task: description 内偽プロトコル injection を fence 化で防御` |
| C-12 | `[security] spool_long_payload: project_root 検証なし、canonicalize 失敗時の素 path フォールバック` |
| C-13 | `[refactor] agent_role_bindings: team_id 次元を持たないため cross-team で role 上書きの余地` |
| C-14 | `[bug] file_locks: socket 異常切断で lock が残留、自動解放経路が dismiss MCP 呼び出しのみ` |

### IPC / 横断 (6件)

| # | Title |
|---|---|
| C-15 | `[security] backend: app_set_project_root に is_safe_watch_root と同水準の path 検証を導入` |
| C-16 | `[bug] backend: team_history_save の disk write 失敗時に cache が rollback されない` |
| C-17 | `[refactor] backend: settings_save に schema_version 互換性ガードを追加` |
| C-18 | `[bug] team-history: 手編集と並行する auto-save で外部変更がロストする (mtime 検知)` |
| C-19 | `[refactor] logging: vibe-editor.log を日次回転 + 古い世代の自動削除 (DoS 経路を塞ぐ)` |
| C-20 | `[refactor] settings/role-profiles: .bak をタイムスタンプ + 世代回転に変更` |

## Tier D — LOW / Refactor opportunities (15件)

個別 issue を作らず、**roadmap issue 1 件** にまとめて進捗管理する。

- pty: subscribeEvent (sync) を非推奨化、Codex inject の 1.8s 固定 sleep を prompt 検出に置換、scrollback continuation skip の CP932 副作用、reader thread 終了理由の trace、resolve_valid_cwd の symlink 拒否、codex instructions temp file の cleanup
- canvas: pulseEdge id 重複、clear() に lastRecruitFocus を含める、addCard fallback grid の重複ロジック
- ipc/backend: SAVE_LOCK 4 重定義、handoffs/team_state の safe_segment 重複、apply_window_effects の effect kind enum 化、is_codex_command の Windows 拡張子テスト
- 横断: marked + dompurify の `ADD_ATTR: ['target']` 撤廃、command palette themeOrder の hardcoded 3 ファイル、role-profiles-context の HMR 残存、setWindowEffects IPC coalescing、i18n fallback chain en 統一、App.tsx の Ctrl+B を useKeybinding に集約

各項目の詳細はこのドキュメントの末尾に「Detailed findings」として残す。roadmap issue から本 plan.md を参照する。

## 既存 open issue への補足方針

| 既存 | 関連 finding | 対応 |
|------|--------------|------|
| #585 (背景縦線) | B-1 | **新規 issue B-1 を起票** + #585 に「B-1 で根本対応する」cross-reference comment を追記 |
| #586 (HUD 表示変) | B-5 + B-6 | **新規 issue B-5 / B-6 を起票** + #586 に cross-reference + 「複数の sub-issue に分割した」と追記 |
| #591 (フォルダ外せない) | B-8 | **新規 issue B-8 を起票** + #591 に「B-8 で対応する」cross-reference |
| #592 (右クリックメニュー機能不足) | (直接対応 finding 無し) | 残置 (UX 機能追加リクエストなので別 sprint) |
| #593 (右クリックメニュー閉じれない) | B-7 | **新規 issue B-7 を起票** + #593 に「B-7 で根本対応」cross-reference |

## sprint 計画

bot review が直列 merge である制約上、worker 並列度 5 でも実質 PR スループットは 5/日 程度。

### Wave 1 (Tier S 5 件 + Tier A 11 件 = 16 件、3 PR/日 × 5-6 日)

worker 編成:

```
Leader: 自分 (claude opus 4.7)
HR: claude haiku 4.5 wait_policy=strict
integrator: claude opus 4.7 wait_policy=standard
implementer×3: claude opus 4.7 wait_policy=standard
  - rust_specialist (Tier S-1, A-1〜A-6, A-10)
  - canvas_specialist (Tier S-2, S-3)
  - cross_specialist (Tier S-4, S-5, A-7〜A-9, A-11)
verifier: codex (claude が書いたコードを別視点で diagnose)
```

bot 自動 merge 経路 (vibe-editor-reviewer) を pullrequest skill のフローで完走させる。

### Wave 2 (Tier B 15 件、3-4 PR/日 × 4-5 日)

Wave 1 で得た worker 編成をそのまま使い、各 specialist の領域継続でこなす。

### Wave 3 (Tier C 20 件、必要なら次月以降)

Wave 1+2 完了時点でユーザー再評価。`/loop` で長期スパンの段階的 merge を回す可能性あり。

## 起票リスト (gh issue create テンプレート)

各 issue body は以下のテンプレに従う:

```markdown
## 概要 / Summary

(現象 1〜2 行)

## 根本原因 / Root cause

(File:Line 単位で具体的に)

## 再現手順 / Repro

1. ...
2. ...

## 影響範囲 / Impact

(誰の何が壊れるか、severity 根拠)

## 修正方針 / Fix proposal

(実装案、複数案あれば併記)

## Done criteria

- [ ] ...
- [ ] vibe-editor-reviewer (bot) が APPROVED で auto-merge
```

ラベル付け規則 (label-and-issue-workflow に従う):

- 種類 (必須 1 つ): `bug` / `enhancement` / `refactor` / `security` / `performance` / `documentation`
- 領域 (必須 1+): `canvas` / `ui` / `settings` / `persistence` / `rust` / `javascript` / `backend` / `i18n` / `a11y` / `dependencies`
- 例外: `security` は `bug` と併記する (両方付ける)

## 検証 / Done criteria for this plan

- [ ] 個別 issue が Tier S+A+B+C で 51 件起票され、それぞれ正しいラベル付き
- [ ] roadmap issue が 1 件起票され、Tier D 全項目を内包
- [ ] 既存 #585 / #586 / #591 / #593 に cross-reference comment 追記
- [ ] vibe-team で 5 worker 並列起動、Wave 1 (16 件) を 1 セッション内で着手
- [ ] Wave 1 PR が vibe-editor-reviewer bot で順次 auto-merge 完走

---

## Detailed findings (referenced by Tier D roadmap)

(以下、subagent が出した raw findings を 5 つのサブセクションに整理した参照ドキュメント。Tier D の項目はここを single source of truth として roadmap issue から link する)

### PTY / xterm

(windows-pty-reviewer の出力を保存。Tier D に該当する LOW finding を抜粋)

- subscribeEvent (sync) を terminal.* で公開しているが、新規 spawn でうっかり使うと #285 が再発する
- inject_codex_prompt_to_pty が固定 1.8 秒 sleep で TUI 準備を待つ「magic timing」
- safe_utf8_boundary は UTF-8 boundary しか守らないが scrollback が CP932 を含むと先頭 skip が無限消費する潜在
- terminal_create 失敗時の codex temp file が tempdir に残留する
- reader thread が read() Err 時に break するが理由を記録しない
- resolve_valid_cwd の Path::new(p).is_dir() は symlink を辿る (TOCTOU + symlink-attack 余地)

### Canvas

- pulseEdge の id が `handoff-${messageId}-${Date.now()}` で同 messageId の重複が dedup されない
- clear() が arrangeGap と lastRecruitFocus を残す
- addCard の fallback grid (no position) と CanvasLayout.stagger で同じロジックが二重実装

### TeamHub

- dispatch_tool に "team-hub/keepalive" 以外の任意 method で id 既知の場合に Method not found 応答が leak
- handshake で 1 hello_line.len() check が char_count ではなく byte len で 1024 を判定 (DoS のセーフティ強化)
- cleanup_old_spools が race で worker が読みかけのファイルを削除
- team_create_leader と team_recruit が同 semaphore を共有、4 連続 leader 切替で starvation
- team_diagnostics の serverLogPath が VIBE_TEAM_LOG_PATH 経由で reduce_home_prefix される前に env を信頼
- team_send.handoff_id が control char 含めて record_handoff_lifecycle に渡る
- resolve_targets で role/agent_id が trim 済み input と完全一致になり、Unicode 正規化していない

### IPC commands

- handoffs.rs:safe_segment と team_state.rs:safe_segment が重複定義 (DRY 違反)
- is_codex_command は path-style command で codex.bat codex.cmd 等の Windows 拡張を検出できない
- dialog_open_folder の result.map(|p| p.to_string()) は Tauri 2 の FilePath の正規化結果を捨てる
- team_presets_load / team_presets_list で file 名と preset.id の一致判定があるが、case-insensitive な FS で同 id の重複登録を防げていない
- logs_open_dir は OS opener に直接 path を渡し、サニタイズなし
- app_recruit_ack の phase=None && ok=false 経路が未知 phase と区別されない
- terminal_kill / terminal_resize / terminal_write は renderer 由来の id を is_valid_terminal_id でバリデートしない
- app_check_claude は通った command を which::which で PATH 解決後、戻り値の path 文字列をそのまま renderer に返す
- fs_watch::start_for_root の generation 監視が thread spawn 経由で leak しうる
- apply_window_effects (Windows) は EffectState::Active を Acrylic に必須で渡しているが、Mica / Tabbed への切替経路がない
- files_write で expected_content_hash を持っていても safe_join 後の race window でファイル差し替え攻撃が成立する

### Cross-domain

- silent updater check が署名失敗を silent に
- OnboardingWizard の chooseFolder ピックフォルダパスが is_path_safe_to_query を経由しない
- app_open_external は scheme allowlist 済みだが、app_reveal_in_file_manager のパス長検証が緩く .lnk / Windows shortcut chain を解釈する
- marked.parse(source, { async: false }) の同期モードが marked v18 では deprecated 経路 — XSS 起動口を増やす可能性
- bridge.js の pendingOut が JSON-RPC line を on-disk に持つ前にメモリでバッファ — Hub 不在時の 256 件上限を超えた以降は black-hole
- team_history の MAX_ENTRIES_PER_PROJECT = 20 だが、hydrate_orchestration_summary がエントリ毎に同期 disk read を走らせ N×file I/O
- role-profiles の composeWorkerProfile() が dynamic state を保持するため、HMR / unmount 時に file.dynamic[] が 2 重で in-memory に残る
- グローバル keydown listener が capture phase 固定で、xterm 内 Ctrl+B 等が dim される (useKeybinding と App.tsx:648 の二重登録)
- i18n translate の fallback chain が translations.ja[key] ?? key 固定で、英語 only の key 漏れが日本語に fallback してしまう
- applyTheme 内の triggerSetWindowEffects が seq だけで dedup し、glass→glass 連打で IPC が無駄に並ぶ
- dialog_is_folder_empty の denylist が Linux で /var を拒否 — 一般ユーザーの /var/tmp 配下プロジェクトを誤拒否する
- command palette の themeOrder が app-commands.ts:6 で固定配列、テーマ追加時に palette と OnboardingWizard の更新箇所が 3 つに分散
- SAVE_LOCK パターンが settings/role_profiles/team_history/team_presets で 4 重定義 — 抽出余地

## Refactor opportunities (Tier D に統合される設計改善案)

### PTY pipeline
- エンコーディング pipeline の分離 (raw bytes → decoded UTF-8 → scrollback の 3 stage)
- inject の責務統一 (team_hub::inject + terminal::inject_codex_prompt の DRY 化)
- Windows 抽象 (pty/windows.rs / pty/unix.rs の trait 分離)
- listener registration の serialization (attemptPreSubscribe と terminal_create の入口を逆転)

### TeamHub
- prompt injection 防御の集約 (`team_hub::sanitize` 共通 helper)
- agent_id 検証の中央化 (`validate_agent_id` helper)
- file_locks の永続化 (Hub 再起動を跨ぐ orphan 防止)
- Hub state machine の整理 (`enum RecruitState { ... }`)
- engine 抽象 (`enum Engine { Claude, Codex }`)
- socket 接続切断時の lock 解放 hook

### IPC
- IPC 認可中央化 (`commands/authz.rs` で project_root 一致を helper 化)
- path 検証 helper 統合 (`commands/path_guard.rs`)
- atomic_write を「設定永続化 facade」に昇格 (`PersistableStore<T>`)
- settings migration インフラ (Rust 側 schema 整合)
- git wrapper 統一 (`GitCommand::run_text` / `run_bytes`)
- CommandError variant 拡張 (`Authz` / `SizeLimit` / `TooManyRequests`)
- 引数 wrap 規約統一 (`{ args }` vs flat の混在解消)

### Renderer / Theme / i18n
- THEMES Object を single source of truth に
- i18n fallback chain を `en → key` に統一 + 訳キー対称性 test
- role-profiles-context の load を完全置換に
- setWindowEffects IPC の coalescing
- App.tsx の Ctrl+B を useKeybinding に集約

### Logging / Updater
- tracing-appender::rolling::daily + 古い世代削除 pruner
- updater endpoints の二重化 + 署名失敗の silent toast 修正
- bridge.js の overflow 時 JSON-RPC error 返却

---

このリファクタ計画書は `tasks/refactor-2026-05/plan.md` に保存され、roadmap issue から参照される。Tier S/A/B/C の各 issue は本ドキュメントを `Related plan: tasks/refactor-2026-05/plan.md` として cross-reference する。
