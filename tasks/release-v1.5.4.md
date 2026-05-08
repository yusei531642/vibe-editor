# Release v1.5.4

## 計画

- `v1.5.3` の Windows CLI 起動不具合を修正した PR #561 を含むパッチとして `v1.5.4` を作成する。
- `main` は PR #561 merge commit `02947f5` まで同期済み。
- ローカル dev 版で Claude / Codex の起動ログを確認してから release PR に進む。
- version files を `1.5.4` に更新する。
- release PR を作成し、CI と reviewer bot の承認を待つ。
- PR merge 後に local `main` を同期する。
- `v1.5.4` annotated tag を merge commit に作成して push する。
- `release.yml` の build を監視する。
- draft release の assets と `latest.json` を確認し、publish する。

## Next Steps

- [x] ローカル dev 版で Claude / Codex 起動ログを確認する。
- [x] `package.json` / `package-lock.json` / `src-tauri/Cargo.toml` / `src-tauri/tauri.conf.json` を `1.5.4` に更新する。
- [x] `src-tauri/Cargo.lock` を `1.5.4` に同期する。
- [x] `npm run typecheck`、`npm run build:vite`、`cargo check` を実行する。
- [x] release PR を作成する。
- [x] release workflow を監視し、draft release を publish する。

## 進捗

- [x] `main` が PR #561 merge commit `02947f5` を含むことを確認。
- [x] 5173 が別プロジェクトで使用中のため、Tauri dev override で 5174 を使って dev 起動。
- [x] dev 版で Claude / Codex terminal restore を発火し、実起動ログを確認。
- [x] `chore/release-v1.5.4` ブランチを作成。
- [x] `package.json` / `package-lock.json` を `1.5.4` に更新。
- [x] `src-tauri/Cargo.toml` / `src-tauri/Cargo.lock` / `src-tauri/tauri.conf.json` を `1.5.4` に更新。
- [x] Release PR #562 を作成し、CI と reviewer bot approval を確認。
- [x] PR #562 の bot merge 後に `main` を同期。
- [x] `v1.5.4` annotated tag を push。
- [x] Release workflow run `25542885051` を監視し、全 matrix build の成功を確認。
- [x] Draft release の assets と `latest.json` を確認。
- [x] Draft release を publish。

## 検証結果

- [x] Local dev verification: Claude は `~/.local/bin/claude.exe` に解決。
- [x] Local dev verification: Codex は `~/AppData/Roaming/npm/codex.cmd` に解決し、launcher は `C:\WINDOWS\system32\cmd.exe`。
- [x] Local dev verification: dev app start line 34472 以降に `CreateProcessW` / `os error 193` は出ていない。
- [x] `npm run typecheck`: PASS
- [x] `npm run build:vite`: PASS
- [x] `C:\Users\zooyo\.cargo\bin\cargo.exe check --manifest-path src-tauri\Cargo.toml`: PASS
- [x] GitHub Actions `ci / verify`: PASS (run `25542614930`)
- [x] Release workflow: PASS (run `25542885051`)
- [x] `latest.json`: `version` が `1.5.4`、platforms が `darwin-aarch64` / `linux-x86_64` / `windows-x86_64`

## Next Tasks

- [x] release PR を作成し、CI と reviewer bot を確認する。
- [x] PR merge 後に `main` を同期し、`v1.5.4` tag を push する。
- [x] release workflow を監視し、draft release の assets と `latest.json` を確認する。
- [x] draft release を publish する。

## 完了結果

- [x] PR #562: https://github.com/yusei531642/vibe-editor/pull/562
- [x] Release: https://github.com/yusei531642/vibe-editor/releases/tag/v1.5.4
- [x] Assets: Windows `.exe`、macOS `.dmg` / `.app.tar.gz`、Linux `.AppImage` / `.deb` / `.rpm`、SBOM、signatures、`latest.json`
- [x] Published at: 2026-05-08T07:37:39Z
