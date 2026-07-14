# Release v1.6.8

Issue: https://github.com/yusei531642/vibe-editor/issues/1238

## 計画

- `v1.6.7` 以降 `main` に入った変更をまとめ、`v1.6.8` を作成する。
- version files を `1.6.8` に同期する。
- release PR の CI と reviewer bot の承認を確認してマージする。
- merge commit に annotated tag `v1.6.8` を作成して push する。
- release workflow の成果物と updater metadata を確認し、draft release を publish する。

## 主な変更

- **security / persistence**: project root・team history・PTY/MCP 起動境界の認可と TOCTOU 対策を強化。
- **terminal / PTY**: 復元、resize、watcher、終了競合、Windows WSL 解決を安定化。
- **team / canvas**: Skill attach、追加エージェント、再開予約、message log 永続化を改善。
- **UI / i18n / a11y**: テーマ配色、オンボーディング、診断文言、modal focus 境界を改善。
- **CI / dependencies**: release quality gate、Windows PTY test、依存単一化と再発検知を追加。

## Next Steps

- [x] `package.json` / `package-lock.json` / `src-tauri/Cargo.toml` / `src-tauri/Cargo.lock` / `src-tauri/tauri.conf.json` を `1.6.8` に更新する。
- [x] release 前チェックを実行する。
- [ ] release PR を作成し、CI / reviewer bot を確認する。
- [ ] PR merge 後に `v1.6.8` tag を push する。
- [ ] release workflow を監視し、draft release の assets と `latest.json` を確認する。
- [ ] draft release を publish する。

## 検証結果

- [x] `npm run typecheck`: PASS
- [x] `npm run build:vite`: PASS
- [x] `npm run test`: PASS（105 files / 602 tests）
- [x] `npm run lint:release-workflow`: PASS
- [x] `npm run lint:file-size`: PASS
- [x] `npm audit --omit=dev --audit-level=high`: PASS（0 vulnerabilities）
- [x] `cargo check --locked --manifest-path src-tauri/Cargo.toml --all-targets`: PASS
- [x] `cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`: PASS
