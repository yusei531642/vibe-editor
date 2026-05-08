# Release v1.5.5

## 計画

- PR #565 の IDE 初期表示 hidden terminal 修正を含むパッチとして `v1.5.5` を作成する。
- `main` は PR #565 merge commit `f28e078` まで同期済み。
- version files を `1.5.5` に更新する。
- release PR を作成し、CI と reviewer bot の承認を待つ。
- PR merge 後に local `main` を同期する。
- `v1.5.5` annotated tag を merge commit に作成して push する。
- `release.yml` の build を監視する。
- draft release の assets と `latest.json` を確認し、publish する。

## Next Steps

- [x] `package.json` / `package-lock.json` / `src-tauri/Cargo.toml` / `src-tauri/tauri.conf.json` を `1.5.5` に更新する。
- [x] `src-tauri/Cargo.lock` を `1.5.5` に同期する。
- [x] `npm run typecheck`、`npm run build:vite`、`cargo check` を実行する。
- [ ] release PR を作成する。
- [ ] release workflow を監視し、draft release を publish する。

## 進捗

- [x] `main` が PR #565 merge commit `f28e078` を含むことを確認。
- [x] `chore/release-v1.5.5` ブランチを作成。
- [x] `package.json` / `package-lock.json` を `1.5.5` に更新。
- [x] `src-tauri/Cargo.toml` / `src-tauri/Cargo.lock` / `src-tauri/tauri.conf.json` を `1.5.5` に更新。
- [x] ローカル品質ゲートを通過。

## 検証結果

- [x] `npm run typecheck`: PASS
- [x] `npm run build:vite`: PASS
- [x] `C:\Users\zooyo\.cargo\bin\cargo.exe check --manifest-path src-tauri\Cargo.toml`: PASS（既存 warning: `LockResult::has_conflicts` / `TemplateReport::{warnings,warn_message}`）
- [x] `git diff --check`: PASS

## Next Tasks

- release PR を作成し、CI と reviewer bot を確認する。
- PR merge 後に `main` を同期し、`v1.5.5` tag を push する。
- release workflow を監視し、draft release の assets と `latest.json` を確認する。
- draft release を publish する。
