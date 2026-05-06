# Release v1.4.11

## 計画

- [x] Issue #470 / PR #472 / CI / Issue close 状態を確認する。
- [x] 最新 release と tag を確認し、次の patch version を `v1.4.11` と判断する。
- [x] `chore/release-1.4.11` で `package.json` / `package-lock.json` / `src-tauri/Cargo.toml` / `src-tauri/tauri.conf.json` / `src-tauri/Cargo.lock` を `1.4.11` に更新する。
- [x] `npm run typecheck` / `npm run test` / `npm run build:vite` / `cargo check --manifest-path src-tauri/Cargo.toml` / `cargo check --locked --manifest-path src-tauri/Cargo.toml` / `git diff --check` を実行する。
- [ ] Release PR を作成し、CI / reviewer を確認する。
- [ ] Release PR merge 後に `v1.4.11` annotated tag を push して release workflow を起動する。
- [ ] draft release と成果物を確認し、publish 可能な状態まで進める。

## Next Steps

- [x] バージョン bump を実施する。
- [x] 品質ゲートを通す。
- [ ] Release PR を作成する。
- [ ] PR merge 後に tag push で release workflow を起動する。

## 進捗

- [x] `npm version 1.4.11 --no-git-tag-version` で npm 側を同期。
- [x] `src-tauri/Cargo.toml` / `src-tauri/tauri.conf.json` を `1.4.11` に更新。
- [x] `cargo check --manifest-path src-tauri/Cargo.toml` で `src-tauri/Cargo.lock` の `vibe-editor` package version を `1.4.11` に更新。

## 検証結果

- [x] `cargo check --manifest-path src-tauri\Cargo.toml`: PASS
- [x] `npm run typecheck`: PASS
- [x] `npm run test`: PASS (30 files / 199 tests)
- [x] `npm run build:vite`: PASS
- [x] `cargo check --locked --manifest-path src-tauri\Cargo.toml`: PASS
- [x] `git diff --check`: PASS
- [x] Note: 初回の `cargo check --locked` は `npm run build:vite` と並列実行したため `dist` asset 読み取り競合で失敗。`build:vite` 完了後の単独再実行で PASS。

## Next Tasks

- [ ] Release PR を作成し、CI / reviewer を確認する。
- [ ] PR merge 後に `v1.4.11` annotated tag を作成して push する。
- [ ] release workflow 完了後、draft release の成果物と `latest.json` を確認する。
