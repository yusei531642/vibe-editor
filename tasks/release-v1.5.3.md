# Release v1.5.3

## 計画

- 最新公開リリース `v1.5.2` の次パッチとして `v1.5.3` を作成する。
- `main` は Issue #556 修正 PR #557 merge commit `0292dbd` まで同期済み。
- version files を `1.5.3` に更新する。
- release PR を作成し、CI と reviewer bot の承認を待つ。
- PR merge 後に local `main` を同期する。
- `v1.5.3` annotated tag を merge commit に作成して push する。
- `release.yml` の build を監視する。
- draft release の assets と `latest.json` を確認し、publish する。

## Next Steps

- `package.json` / `package-lock.json` / `src-tauri/Cargo.toml` / `src-tauri/tauri.conf.json` を `1.5.3` に更新する。
- `src-tauri/Cargo.lock` を cargo で同期する。
- `cargo check --manifest-path src-tauri\Cargo.toml`、`npm run typecheck`、`npm run test`、`npm run build:vite`、`git diff --check` を実行する。
- release PR を作成する。

## 進捗

- [x] `chore/release-v1.5.3` ブランチを作成。
- [x] `package.json` / `package-lock.json` を `1.5.3` に更新。
- [x] `src-tauri/Cargo.toml` / `src-tauri/Cargo.lock` / `src-tauri/tauri.conf.json` を `1.5.3` に更新。
- [x] 品質ゲートを実行。
- [x] Release PR #558 を作成し、CI と reviewer bot approval を確認。
- [x] PR #558 の bot merge 後に `main` を同期。
- [x] `v1.5.3` annotated tag を push。
- [x] Release workflow run `25540716934` を監視し、全 matrix build の成功を確認。
- [x] Draft release の assets と `latest.json` を確認。
- [x] Draft release を publish。

## 検証結果

- [x] `cargo check --manifest-path src-tauri\Cargo.toml`: PASS
- [x] `cargo test --manifest-path src-tauri\Cargo.toml --lib`: PASS (293 tests)
- [x] `npm run typecheck`: PASS
- [x] `npm run test`: PASS (45 files / 288 tests)
- [x] `npm run build:vite`: PASS
- [x] `git diff --check`: PASS
- [x] GitHub Actions `ci / verify`: PASS (run `25540482890`)
- [x] Release workflow: PASS (run `25540716934`)
- [x] `latest.json`: `version` が `1.5.3`、platforms が `darwin-aarch64` / `linux-x86_64` / `windows-x86_64`

## Next Tasks

- [x] release PR を作成し、CI と reviewer bot を確認する。
- [x] PR merge 後に `main` を同期し、`v1.5.3` tag を push する。
- [x] release workflow を監視し、draft release の assets と `latest.json` を確認する。
- [x] draft release を publish する。

## 完了結果

- [x] PR #558: https://github.com/yusei531642/vibe-editor/pull/558
- [x] Release: https://github.com/yusei531642/vibe-editor/releases/tag/v1.5.3
- [x] Assets: Windows `.exe`、macOS `.dmg` / `.app.tar.gz`、Linux `.AppImage` / `.deb` / `.rpm`、SBOM、signatures、`latest.json`
- [x] Published at: 2026-05-08T06:38:55Z
