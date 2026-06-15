# Release v1.6.6

Issue: https://github.com/yusei531642/vibe-editor/issues/1047

## 計画

- `v1.6.5` の startup blocker 対策を含む hotfix release として `v1.6.6` を作成する。
- `main` は PR #1041 / #1043 / #1046 merge commit まで同期済み。
- version files を `1.6.6` に更新する。
- release PR を作成し、CI と reviewer bot の承認を待つ。
- PR merge 後に local `main` を同期する。
- `v1.6.6` annotated tag を merge commit に作成して push する。
- `release.yml` の build を監視する。
- draft release の assets と `latest.json` を確認し、publish する。

## Next Steps

- [x] `package.json` / `package-lock.json` / `src-tauri/Cargo.toml` / `src-tauri/tauri.conf.json` を `1.6.6` に更新する。
- [x] `src-tauri/Cargo.lock` を `1.6.6` に同期する。
- [x] `npm run typecheck`、`npm run build:vite`、`cargo check`、`git diff --check` を実行する。
- [x] release PR を作成し、CI / reviewer bot を確認する。
- [x] PR merge 後に `v1.6.6` tag を push する。
- [x] release workflow を監視し、draft release の assets と `latest.json` を確認する。
- [x] draft release を publish する。

## 進捗

- [x] `chore/release-v1.6.6` ブランチを作成。
- [x] `package.json` / `package-lock.json` を `1.6.6` に更新。
- [x] `src-tauri/Cargo.toml` / `src-tauri/Cargo.lock` / `src-tauri/tauri.conf.json` を `1.6.6` に更新。
- [x] ローカル品質ゲートを通過。
- [x] PR #1048 を作成し、reviewer bot 承認と CI 全PASSを確認。
- [x] PR #1048 が自動マージされ、Issue #1047 が close されたことを確認。
- [x] `v1.6.6` annotated tag を merge commit `80f5361` に作成して push。
- [x] Release workflow run `27518218007` が Linux / Windows / macOS すべて成功。
- [x] Draft release の assets 13個と `latest.json` の `version: 1.6.6` を確認。
- [x] GitHub Release `v1.6.6` を publish。

## 検証結果

- [x] `npm run typecheck`: PASS
- [x] `npm run build:vite`: PASS
- [x] `cargo check --offline --manifest-path src-tauri/Cargo.toml --all-targets`: PASS（`Cargo.lock` 同期）
- [x] `cargo check --locked --manifest-path src-tauri/Cargo.toml --all-targets`: PASS
- [x] `cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`: PASS
- [x] `npm run test`: PASS on rerun (79 files / 478 tests)
- [x] `git diff --check`: PASS
- [x] PR #1048 CI: `verify` / `cargo-cfg (windows-latest)` / `cargo-cfg (macos-latest)` / `secrets-scan`: PASS
- [x] Release workflow `27518218007`: Linux / Windows / macOS build jobs: PASS
- [x] Published release: https://github.com/yusei531642/vibe-editor/releases/tag/v1.6.6
