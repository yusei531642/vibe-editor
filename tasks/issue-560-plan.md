# Issue #560 - Windows npm shim resolution

## 計画

- v1.5.3 のログから、resolver が `~/AppData/Roaming/npm/codex` / `claude` の拡張子なし shell shim を選ぶ症状を確認する。
- `src-tauri/src/pty/session.rs` の Windows resolver で、bare command の候補順を PATHEXT 優先へ変える。
- `.cmd` / `.bat` を選んだ場合は既存どおり `cmd.exe /C` で起動する。
- 同じディレクトリに `codex` と `codex.cmd` があるケースを回帰テストに追加する。
- targeted Rust test、`cargo check`、Rust lib test、frontend check、build、diff check を通す。

## Next Steps

- [x] `candidate_paths()` の候補順を修正する。
- [x] `spawn_command_resolution_tests` に npm shell shim 再現ケースを追加する。
- [ ] Issue #560 用 PR を作成し、CI と reviewer bot を確認する。

## 進捗

- [x] Windows の bare command 解決では `which::which(command)` を避け、アプリ側の探索順で PATHEXT 候補を優先する。
- [x] `codex` と `codex.cmd` が同じディレクトリにある場合、`.cmd` を選び `cmd.exe /C` で起動する。
- [x] `tasks/lessons.md` に npm extensionless shim の再発防止を追記した。

## 検証結果

- [x] `cargo test --manifest-path src-tauri\Cargo.toml spawn_command_resolution_tests --lib`: PASS (4 tests)
- [x] `cargo check --manifest-path src-tauri\Cargo.toml`: PASS
- [x] `cargo test --manifest-path src-tauri\Cargo.toml --lib`: PASS (294 tests)
- [x] `npm run typecheck`: PASS
- [x] `npm run test`: PASS (45 files / 288 tests)
- [x] `npm run build:vite`: PASS
- [x] `git diff --check`: PASS

## Next Tasks

- [x] `cargo check --manifest-path src-tauri\Cargo.toml`
- [x] `cargo test --manifest-path src-tauri\Cargo.toml --lib`
- [x] `npm run typecheck`
- [x] `npm run test`
- [x] `npm run build:vite`
- [x] `git diff --check`
- [ ] PR を作成し、CI と reviewer bot を確認する。
