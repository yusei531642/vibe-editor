# Release v1.6.7

Issue: https://github.com/yusei531642/vibe-editor/issues/1095

## 計画

- `v1.6.6` 以降 `main` に入った 23 commit をまとめた release として `v1.6.7` を作成する。
- version files を `1.6.7` に更新する。
- release PR を作成し、CI と reviewer bot の承認を待つ。
- PR merge 後に local `main` を同期する。
- `v1.6.7` annotated tag を merge commit に作成して push する。
- `release.yml` の build を監視する。
- draft release の assets と `latest.json` を確認し、publish する。

## 主な変更

- **api-agents**: ローカル AI プロバイダ (Ollama / LM Studio) (#1050) / モデル自動取得 (#1056) / web_fetch (#1054) / read_file 行レンジ (#1052) / context トリミング (#1058)
- **team**: message log 永続化 + hub 再起動跨ぎ read state (#1074) / codex team_send を app-server JSON-RPC 配送 (#1063) / 配送方式の設定切替 (#1069) / leader handoff 引数削減 (#1061, #1070)
- **fix**: Hub socket stale 時の MCP initialize ローカル即答 (#1080) / API キー保存失敗の toast surface (#1060) / dompurify advisory 解消 (#1065, #1067)
- **deps**: @xyflow/react, sharp, vitest, typescript-eslint, nix, which, chrono 等

## Next Steps

- [x] `package.json` / `package-lock.json` / `src-tauri/Cargo.toml` / `src-tauri/tauri.conf.json` を `1.6.7` に更新する。
- [x] `src-tauri/Cargo.lock` を `1.6.7` に同期する。
- [x] `npm run typecheck`、`npm run build:vite`、`cargo check --locked`、`cargo clippy`、`npm run test` を実行する。
- [ ] release PR を作成し、CI / reviewer bot を確認する。
- [ ] PR merge 後に `v1.6.7` tag を push する。
- [ ] release workflow を監視し、draft release の assets と `latest.json` を確認する。
- [ ] draft release を publish する。

## 検証結果

- [x] `npm run typecheck`: PASS
- [x] `npm run build:vite`: PASS
- [x] `cargo check --locked --manifest-path src-tauri/Cargo.toml --all-targets`: PASS（Cargo.lock 同期確認）
- [x] `cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`: PASS
- [x] `npm run test`: PASS（79 files / 478 tests）
- [x] `git diff --check`: PASS
