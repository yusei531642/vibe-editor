# Issue #525 訂正版実装計画

作成日: 2026-05-08  
対象: https://github.com/yusei531642/vibe-editor/issues/525

## 計画

- #525 本文を正とし、既存の planned コメントは別Issue向けの誤計画として扱う。
- 既存コードを再調査し、「ロックが無い」という初期仮説を疑う。
- #526 で入った advisory lock を前提に、なぜ #525 の症状が残るかを最終原因として特定する。
- `/issue-planner` 形式で、Issue #525 に訂正版の実装計画を投稿する。

## Next Steps

- Issue #525 にこの内容を「訂正版実装計画」としてコメントする。
- bug / enhancement / security の3バッチ実行では、#525 の旧コメントではなく本計画を使う。
- 実装時は `bug/issue-525-file-ownership-guardrails` ブランチを切り、最小差分で進める。

## 調査結果

### 既存 planned コメントの扱い

Issue #525 の既存 planned コメントは、HR の委譲レベルを導入する計画になっている。  
これは #525 本文の「複数 worker が同じファイルを編集して衝突する」と一致しない。

したがって、#525 では既存 planned コメントを採用しない。  
この訂正版計画を正とする。

### 疑った仮説と結論

| 仮説 | 判定 | 根拠 |
|------|------|------|
| ファイルロック機構が全く無い | 棄却 | `src-tauri/src/team_hub/file_locks.rs:1`、`src-tauri/src/team_hub/protocol/tools/file_lock.rs:67`、`src-tauri/src/team_hub/protocol/mod.rs:150` に既存実装がある |
| `team_assign_task` はロック競合で割当を止める | 棄却 | `src-tauri/src/team_hub/protocol/schema.rs:68` と `:70` が optional / advisory と明記している |
| worker は必須プロンプトだけで lock tool を知る | 棄却 | `src/renderer/src/lib/role-profiles-builtin.ts:26` から `:32` のツール一覧に `team_lock_files` / `team_unlock_files` が無い |
| 競合イベントは UI で見える | 棄却 | Rust は `team:file-lock-conflict` を emit するが、renderer 側検索では購読箇所が無い。`toast-context.tsx:134` から `:146` は `team:role-lint-warning` のみ購読 |
| #525 の本質は「既存 lock の強制力不足」 | 採用 | lock は advisory で、task 状態にも prompt にも UI にも file ownership が一級データとして残っていない |

## RCA結果

- RCA Mode: Root Cause Confirmed
- 症状: 複数 worker が同じファイルを編集しても、TeamHub が必ず事前検知・停止・可視化する構造になっていない。
- 再現: Issue #525 本文の例に加え、`.claude/skills/vibe-team/SKILL.md:519` から `:525` に、実際の uncommitted changes 消失事例が記録されている。
- 原因箇所:
  - `src-tauri/src/team_hub/file_locks.rs:8` から `:11`
  - `src-tauri/src/team_hub/protocol/schema.rs:66` から `:85`
  - `src-tauri/src/team_hub/protocol/tools/assign_task.rs:44` から `:56`
  - `src-tauri/src/team_hub/protocol/tools/assign_task.rs:197` から `:211`
  - `src-tauri/src/team_hub/protocol/tools/assign_task.rs:279` から `:317`
  - `src/renderer/src/lib/role-profiles-builtin.ts:26` から `:32`
  - `src/renderer/src/lib/role-profiles-builtin.ts:132` から `:167`
  - `src/renderer/src/lib/role-profiles-builtin.ts:465` から `:485`
  - `src/renderer/src/lib/team-prompts.ts:46` から `:66`
  - `src/renderer/src/lib/toast-context.tsx:134` から `:146`
- 原因経路: Leader が `team_assign_task` を `target_paths` 無しで呼ぶ、または worker が `team_lock_files` を呼ばずに編集する。Hub はそれを hard fail しない。競合を検出しても assign は成功し、UI 側にも確実には見えない。
- 独立証拠:
  - #526 のコメントとコードが advisory / optional / warn 同梱を明記している。
  - `.claude/skills/vibe-team/SKILL.md:525` が過去の file-level 消失事例を記録している。
  - renderer 検索で `team:file-lock-conflict` の購読が無く、Rust emit と UI の間がつながっていない。
- 除外した代替原因:
  - 「ロック機構そのものが未実装」は誤り。#526 の `e9075d3` で file lock と assign 時 peek は導入済み。
  - 「Rust 側の path 正規化不足」も主因ではない。`file_locks.rs:13` と `.claude/skills/vibe-team/SKILL.md:398` から `:407` に正規化ルールがある。
- 修正方針: 新しいロックエンジンを作らない。既存 #526 実装を、task state / prompt / UI / tests の4箇所で「使われる形」に引き上げる。
- 判定: A=YES, B=YES, C=YES, D=YES

## 実装計画 / Implementation Plan

> この計画は自動生成されました（issue-planner + Codex local investigation）
> 既存 planned コメントは #525 本文と不一致のため、この訂正版を正とします。

### 概要

- **Issue**: #525 `[bug] vibe-team で複数 worker が同じファイルを編集して衝突する (ロック / 分担強制が無い)`
- **分類**: bug
- **工数見積**: M(2-8h)
- **優先度**: P1(今スプリント)
- **影響度**: 高

<!-- issue-planner-meta
tier: B
tier_score: 8
tier_breakdown: data=2,auth=0,arch=2,scope=2,ops=2
reviewer_count: 1
review_completion_rate: 1/1
composite_grade: B
critical_open: 0
final_check: pass
grok_used: false
grok_status: skipped
grok_signals: none
grok_timeout_ms: 600000
-->

### 原因分析

最終原因は、既存 file lock が「任意の advisory lock」に留まり、TeamHub のタスク割当・worker 必須プロンプト・Canvas UI のどこにも、ファイル所有権が強制的に残らないことです。

`team_assign_task` の `target_paths` は任意です。`src-tauri/src/team_hub/protocol/tools/assign_task.rs:44` から `:56` で未指定なら空配列になります。  
競合検知も `src-tauri/src/team_hub/protocol/tools/assign_task.rs:279` から `:317` の peek と event emit に留まり、assign 自体は成功します。  
さらに `TeamTask` には `target_paths` が保存されません。`src-tauri/src/team_hub/state.rs:401` から `:415` にファイル所有情報がありません。

worker 側も、必須プロンプトだけでは lock tool を確実に知りません。  
`src/renderer/src/lib/role-profiles-builtin.ts:26` から `:32` の MCP tool 一覧に `team_lock_files` / `team_unlock_files` がありません。  
`src/renderer/src/lib/role-profiles-builtin.ts:132` から `:167` の絶対ルールにも、編集前 lock 取得がありません。  
`.claude/skills/vibe-team/SKILL.md:411` から `:414` には運用ルールがありますが、`role-profiles-builtin.ts:166` から `:167` では参照が任意です。

UI 側も、Rust が emit する `team:file-lock-conflict` を拾っていません。  
`src-tauri/src/team_hub/protocol/tools/assign_task.rs:313` で event は出ますが、`src/renderer/src/lib/toast-context.tsx:134` から `:146` は `team:role-lint-warning` のみ購読しています。

### 状態・表示ソース補足

| 観点 | 内容 | 根拠 |
|------|------|------|
| 時間/状態ゲート | lock は in-memory only。TTL は無い。Hub 再起動で clear される | `src-tauri/src/team_hub/file_locks.rs:8`、`src-tauri/src/team_hub/state.rs:52` |
| 表示ソース | lock 一覧取得 helper はあるが、現状は caller が無く UI 表示に届かない | `src-tauri/src/team_hub/state.rs:529` から `:537` |
| メタデータ境界 | `TeamTaskSnapshot` に target paths / lock conflicts が無い | `src-tauri/src/commands/team_state.rs:20` から `:40`、`src/types/shared.ts:609` から `:623` |

### 影響範囲

| ファイル | 変更種別 | 複雑度 | 概要 |
|---------|---------|--------|------|
| `src-tauri/src/team_hub/state.rs` | 修正 | 中 | `TeamTask` に `target_paths` と最新 `lock_conflicts` を追加し、snapshot に投影する |
| `src-tauri/src/commands/team_state.rs` | 修正 | 中 | `TeamTaskSnapshot` に file ownership 情報を追加する |
| `src/types/shared.ts` | 修正 | 低 | renderer 側の `TeamTaskSnapshot` 型を同期する |
| `src-tauri/src/team_hub/protocol/tools/assign_task.rs` | 修正 | 中 | `target_paths` を task に保存し、conflict あり時の response / warning を明確化する |
| `src/renderer/src/lib/role-profiles-builtin.ts` | 修正 | 中 | Leader/worker の必須ルールに `target_paths` と `team_lock_files` を追加する |
| `src/renderer/src/lib/team-prompts.ts` | 修正 | 低 | fallback prompt に lock tools と編集前 lock ルールを追加する |
| `src/renderer/src/lib/toast-context.tsx` | 修正 | 低 | `team:file-lock-conflict` を購読し warning toast を出す |
| `.claude/skills/vibe-team/SKILL.md` | 修正 | 低 | 「recommended」表現を、必須プロンプトとの関係が分かる表現に揃える |

### 依存関係

- 前提Issue: #526 は実装済み。#525 では再実装せず強制力と可視性を補う。
- 外部依存: なし。

### 実装ステップ

#### Step 1: task state に file ownership を保存する

- 対象:
  - `src-tauri/src/team_hub/state.rs`
  - `src-tauri/src/commands/team_state.rs`
  - `src/types/shared.ts`
- 変更内容:
  - `TeamTask` に `target_paths: Vec<String>` を追加する。
  - 必要なら `lock_conflicts: Vec<LockConflictSnapshot>` も snapshot に入れる。
  - 既存タスク復元に影響しないよう、serde default / TS optional を使う。

#### Step 2: `team_assign_task` の file ownership 経路を強化する

- 対象: `src-tauri/src/team_hub/protocol/tools/assign_task.rs`
- 変更内容:
  - `target_paths` を task に保存する。
  - `target_paths` 未指定時は従来通り許容するが、response に `targetPathsMissing: true` 相当の warning を返すか、既存 `boundaryWarnings` に入れる。
  - conflict がある時は `lockConflicts` だけでなく warning message も一貫して返す。

#### Step 3: Leader / worker の必須プロンプトを更新する

- 対象:
  - `src/renderer/src/lib/role-profiles-builtin.ts`
  - `src/renderer/src/lib/team-prompts.ts`
- 変更内容:
  - MCP tool 一覧に `team_lock_files` / `team_unlock_files` を追加する。
  - Leader の委譲ルールを `team_assign_task(assignee, description, target_paths)` に更新する。
  - worker の絶対ルールに「Edit / Write / MultiEdit 前に `team_lock_files`、完了/失敗時に `team_unlock_files`」を追加する。
  - conflict があれば編集を止めて Leader へ調整依頼する、と明記する。

#### Step 4: Canvas UI に file-lock conflict を表示する

- 対象: `src/renderer/src/lib/toast-context.tsx`
- 変更内容:
  - `team:file-lock-conflict` を購読する。
  - `message` があれば warning toast で表示する。
  - 既存 `team:role-lint-warning` と同じ bridge / duration 方針に揃える。

#### Step 5: tests を追加する

- Rust:
  - `team_assign_task` が `target_paths` を task snapshot に残すこと。
  - lock conflict が response / task snapshot / event payload に反映されること。
  - 既存 `file_locks.rs` の partial success / peek tests は維持する。
- TS/Vitest:
  - role profile prompt に `team_lock_files` / `team_unlock_files` と編集前 lock ルールが含まれること。
  - fallback prompt も同じツール名を含むこと。
  - toast provider が `team:file-lock-conflict` を warning として表示すること。

### リスク評価

| リスク | 確率 | 対策 |
|--------|------|------|
| 既存タスク snapshot の互換性が崩れる | 中 | Rust は default、TS は optional で追加する |
| prompt が長くなりすぎる | 中 | lock ルールは短く、絶対ルールに最小文で追加する |
| advisory を hard lock と誤解させる | 中 | UI と response では「競合あり、調整が必要」と表現し、強制停止ではないことを明記する |
| stale lock が残る | 低 | 今回は既存設計に従い、`team_dismiss` 自動解放と手動 unlock を前提にする。TTL はスコープ外 |

### エッジケース防御

| 防御項目 | チェック内容 | 対策パターン |
|---------|------------|------------|
| 空 path | `target_paths` / `paths` に空文字が混ざる | 既存 `normalize_path` / parse guard を利用する |
| Windows path | `src\foo.rs` と `src/foo.rs` が別物になる | 既存 path 正規化を使う |
| 複数 assignee | assignee が role / all のとき holder filter が決めにくい | 既存どおり filter 無しで全 holder を返し、Leader 判断にする |
| conflict partial success | 一部だけ lock 済みになる | worker prompt で conflict 時は編集停止、必要なら unlock する |

### テスト計画

- [x] `cargo test` または対象 module の Rust test を実行する。
- [x] `npm run typecheck` を実行する。
- [x] `npm run test -- team-prompts-liveness` 相当で prompt 断片を確認する。
- [x] toast の event 購読 test を追加し、`team:file-lock-conflict` が warning toast になることを確認する。

### 実装結果

- `TeamTask` / `TeamTaskSnapshot` / `TeamTaskSnapshot` の shared TS 型に `target_paths` と `lock_conflicts` を追加した。
- `team_assign_task` は `target_paths` を正規化して task に保存し、未指定時は `targetPathsMissing` と warning を返す。
- `team_assign_task` は既存 lock と競合した path を `lockConflicts` として response / task snapshot / event payload に残す。
- Leader prompt は `team_assign_task(assignee, description, target_paths)` を使うよう更新した。
- Worker prompt は Edit / Write / MultiEdit 前の `team_lock_files` と、終了時の `team_unlock_files` を必須ルールにした。
- fallback prompt と `.claude/skills/vibe-team/SKILL.md` も同じ file ownership ルールへ揃えた。
- ToastProvider は `team:file-lock-conflict` を購読し、warning toast で表示する。
- `subscribeEvent` は Tauri runtime が無い jsdom で `listen()` が reject しても、未処理 rejection を出さない。

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

### 検証手順

1. Leader prompt に `team_assign_task(..., target_paths)` が出ることを確認する。
2. Worker prompt に `team_lock_files` / `team_unlock_files` と編集前 lock ルールが出ることを確認する。
3. Rust test で `target_paths` が `TeamTaskSnapshot` に保存されることを確認する。
4. `team_assign_task` に既存 lock と重なる `target_paths` を渡し、`lockConflicts` と warning が返ることを確認する。
5. renderer test で `team:file-lock-conflict` event が warning toast になることを確認する。

### PR分割判断

- 推奨分割: 1 PR
- 理由: 原因経路は1つで、既存 #526 の file lock を使わせるための state / prompt / UI 補強に閉じるため。

### コード現状検証結果

| ファイル | 最終変更 | 計画前提との乖離 |
|---------|---------|-----------------|
| `src-tauri/src/team_hub/file_locks.rs` | `e9075d3` #526 | lock 実装あり。新規実装ではなく補強が必要 |
| `src-tauri/src/team_hub/protocol/tools/assign_task.rs` | `e9075d3` #526 | `target_paths` は任意、peek-only、task に保存されない |
| `src/renderer/src/lib/role-profiles-builtin.ts` | `2a44cd4` #536 / #537 | worktree 隔離は必須化済みだが file lock は必須化されていない |
| `src/renderer/src/lib/toast-context.tsx` | 既存 | role lint warning は購読済み、file lock conflict は未購読 |
| `src/types/shared.ts` | 既存 | `TeamTaskSnapshot` に file ownership 情報が無い |

### E2E受け入れ条件

**合格基準**: Leader が `target_paths` 付きで task を割り当て、worker が編集前に lock を取る導線が prompt / state / UI で確認でき、同じ path の競合が warning として可視化されること。

| # | 画面 | URL | 操作フロー | 期待結果 | 深度 | 優先度 |
|---|------|-----|-----------|---------|------|--------|
| 1 | Canvas / TeamHub | アプリ内 | Leader prompt 生成 → worker prompt 生成 | lock tools と編集前 lock ルールが必須ルールに含まれる | L1 | high |
| 2 | Canvas / Toast | アプリ内 | `team:file-lock-conflict` event を発火 | warning toast が表示される | L2 | high |
| 3 | TeamHub MCP | local | worker A が lock → Leader が worker B に同 path の `target_paths` で assign | `lockConflicts` が返り、task snapshot に target path が残る | L2 | high |

**前提条件**: Tauri TeamHub が起動できるローカル環境。Rust / Node のテスト依存が入っていること。  
**非テスト対象**: OS レベルの排他ファイルロック。今回は advisory lock の導線強化が対象。

### ロールバック戦略

- **切り戻し方法**: 対象 PR を `git revert` する。
- **DBスキーマ変更**: なし。
- **影響レコード特定**: ローカル TeamHub state の追加 field のみ。既存 snapshot 互換を保つ。

### 非対象（スコープ外）

- OS ファイルロックや git worktree の自動作成。
- lock TTL / stale lock 自動回収。
- HR delegation level の導入。これは #525 本文とは別テーマ。
- worker の実ファイル編集を TeamHub 経由に強制する大規模設計変更。

### 分割Issue提案

- なし。今回の原因は #526 の既存 lock を task / prompt / UI へ接続し切れていない一点に集約できる。
