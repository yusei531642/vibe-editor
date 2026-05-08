# Issue #556 - CLI resolver hotfix plan

## 計画

- 対象 Issue は #556 の 1 件だけにする。
- 原因は `terminal_create` 入口の inline flags 分離だけではなく、PTY spawn 直前の Windows CLI 解決不足として扱う。
- `SpawnOptions.command` と `SpawnOptions.args` は spawn 境界でも再正規化する。
- 再正規化後に allowlist と immediate-exec 拒否を再実行する。
- Windows では、設定済み絶対パス、`which`、`opts.env["PATH"]`、親プロセス `PATH`、代表的なユーザー CLI 配置を順に探索する。
- `.cmd` / `.bat` を解決した場合は、`CommandBuilder::new("cmd.exe")` と `args=["/C", resolved_path, ...original_args]` で起動する。
- 解決不能時は silent bare fallback を避け、home-redacted な診断ログ付きで明示エラーにする。
- INFO ログには `requested`, `resolved`, `args.len`, `path_entries`, `pathext_present` 相当だけを出す。system prompt や args 本文は出さない。
- 変更は `src-tauri/src/pty/session.rs` を中心にし、必要なら `command_validation` helper の公開範囲だけ調整する。

## Next Steps

- ユーザー確認後、`fix/issue-556-cli-resolver` ブランチを作成する。
- Issue #556 のラベルを `planned` から `implementing` へ移す。
- `tasks/batch-pipeline-state.json` に #556 単独バッチの状態を記録する。
- 実装後、次の検証を実行する。
  - `cargo test --manifest-path src-tauri\Cargo.toml command_normalization_tests --lib`
  - `cargo test --manifest-path src-tauri\Cargo.toml spawn_command_resolution_tests --lib`
  - `cargo check --manifest-path src-tauri\Cargo.toml`
  - `cargo test --manifest-path src-tauri\Cargo.toml --lib`
  - `npm run typecheck`
  - `npm run test`
  - `npm run build:vite`
  - `git diff --check`

## 調査メモ

- `src-tauri/src/commands/terminal.rs` は `normalize_terminal_command()` を入口で呼び、allowlist と immediate-exec 拒否を実行している。
- `src-tauri/src/pty/session.rs` は spawn 直前で `which::which(&opts.command)` に失敗すると `opts.command` の bare fallback に戻している。
- Issue #556 の追加コメントでは、Explorer / Start Menu 起動時の PATH 差、`.cmd` / `.bat` 直接 spawn の `error 193` リスク、silent fallback の調査しづらさが指摘されている。
- `tasks/lessons.md` にも、Windows の生 `CreateProcessW` は PATHEXT 解決をしないため、拡張子付き解決と `.cmd` 対応が必要だと記録されている。

## 進捗

- `terminal_create` 入口だけでなく、`spawn_session` 境界でも command / args を再正規化するようにした。
- spawn 境界でも allowlist と immediate-exec 拒否を再実行するようにした。
- Windows CLI resolver を追加し、`PATH`、`PATHEXT`、代表的なユーザー CLI 配置を探索するようにした。
- `.cmd` / `.bat` は `cmd.exe /C` で包んで起動するようにした。
- resolver 結果を切り分けやすい INFO ログを追加した。args 本文はログに出していない。

## 検証結果

- `cargo test --manifest-path src-tauri\Cargo.toml command_normalization_tests --lib`: PASS (7 tests)
- `cargo test --manifest-path src-tauri\Cargo.toml spawn_command_resolution_tests --lib`: PASS (3 tests)
- `cargo check --manifest-path src-tauri\Cargo.toml`: PASS（既存 warning のみ）
- `cargo test --manifest-path src-tauri\Cargo.toml --lib`: PASS (293 tests / 既存 warning のみ)
- `npm run typecheck`: PASS
- `npm run test`: PASS (45 files / 288 tests、既存 jsdom warning のみ)
- `npm run build:vite`: PASS
- `git diff --check`: PASS

## Next Tasks

- PR #557 の CodeRabbit / CI の結果を確認する。
- PR merge 後、release / packaged app 側で Codex と Claude Code の起動を確認する。
- 起動確認後、Issue #556 を close する。

## 投稿結果

- PR: https://github.com/yusei531642/vibe-editor/pull/557
- Issue comment: https://github.com/yusei531642/vibe-editor/issues/556#issuecomment-4403888408
- Issue label: `implemented`
