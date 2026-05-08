# Issue #568 - IDE CLI readiness must use the same resolver as spawn

## 計画

- `npm run dev` / Tauri dev で IDE モードの Claude missing banner と Codex 追加不可を再現する。
- Claude / Codex の readiness check、IDE terminal add、Canvas add の経路を分けて読む。
- #560 で直した spawn resolver と、今回の readiness / add 経路が分岐していないか確認する。
- Root Cause Confirmed になってから、原因経路へ最小修正を入れる。
- 回帰テストを追加し、Claude / Codex の Windows resolver が readiness と spawn でずれないよう固定する。
- 修正後に `npm run dev` 相当で同じ症状が消えたことを確認する。

## Next Steps

- [x] Issue #568 を作成する。
- [x] readiness check と spawn の resolver 差分を file:line で特定する。
- [x] 最小修正と回帰テストを追加する。
- [x] typecheck / cargo test / vitest を通す。
- [ ] `npm run dev` 相当で Claude missing banner と Codex 追加不可が消えたことを確認する。

## RCA メモ

- RCA Mode: Root Cause Confirmed
- 症状: IDE モードで Claude Code missing banner が出て、Codex 追加もできない。
- 真因:
  - `src-tauri/src/commands/app/window.rs` の `app_check_claude` が `which::which` を直呼びしており、spawn 側 (`pty/session.rs::resolve_windows_spawn_command`) と異なる resolver を使っていた。
  - `src/renderer/src/App.tsx` で `claudeCheck.state === 'ok'` がターミナルペインの描画必要条件になっており、Claude readiness 失敗が Codex タブまで巻き添えにしていた。
- 副次原因 (修正過程で発見):
  - `pty/session.rs::windows_search_dirs` が PATH だけ "env map と `std::env::var` の両方を加算する" 二重取り込みになっており、`env_value` 系 (APPDATA/USERPROFILE/LOCALAPPDATA) と一貫性が無かった。空 env map で呼ばれる readiness check では実害がなかったが、テスト isolation を破る設計だった。

## 検証結果

- `cargo test --lib`: 295/295 PASS（spawn_command_resolution_tests 5/5 を含む）
- `npx vitest run`: 299/299 PASS（48/48 test files）
- `npm run typecheck`: 0 error
- 新規追加テスト:
  - `src-tauri/src/pty/session.rs::spawn_command_resolution_tests::readiness_check_uses_same_windows_fallback_dirs_as_spawn`
  - `src/renderer/src/lib/__tests__/terminal-render-gate.test.ts` (2 cases)

## Next Tasks

- PR 提出 → vibe-editor-reviewer (bot) のレビュー対応 → merge 完了まで完走する。
- 任意: `npm run dev` で IDE モードを起動し、Claude/Codex タブそれぞれが意図通り動くことを目視確認する。
