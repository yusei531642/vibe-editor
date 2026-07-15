# Release v1.6.9

Issue: https://github.com/yusei531642/vibe-editor/issues/1240

## 計画

- v1.6.8の起動不能を解消したmainをv1.6.9として公開する。
- version filesを1.6.9へ同期する。
- release PRのCIとreviewer botを確認してmergeする。
- merge commitへannotated tag `v1.6.9`を作成してpushする。
- release workflowの成果物とupdater metadataを確認し、draft releaseをpublishする。
- 公開版を同一Windows PCへ導入し、Symptom Goneを確認する。

## 主な変更

- `CanvasLayout`を既存の`AppStateProvider`配下へ移し、v1.6.8起動直後のProvider guard例外を解消。
- IDEとCanvasが同じproject/tabs/team stateを共有し、Canvas/PTYの常時mount契約を維持。
- 実bootstrap treeと実Context guardを通す回帰テストを追加。

## Next Steps

- [x] `package.json` / `package-lock.json` / `src-tauri/Cargo.toml` / `src-tauri/Cargo.lock` / `src-tauri/tauri.conf.json`を1.6.9へ更新する。
- [x] release前チェックを実行する。
- [ ] release PRを作成し、CI / reviewer botを確認する。
- [ ] PR merge後に`v1.6.9` tagをpushする。
- [ ] release workflowを監視し、draft releaseのassetsと`latest.json`を確認する。
- [ ] draft releaseをpublishする。
- [ ] 公開版をWindowsへ導入してIssue #1240をcloseする。

## 検証結果

- [x] version同期
- [x] `npm run typecheck`: PASS
- [x] `npm run test`: PASS（106 files / 603 tests）
- [x] `npm run build:vite`: PASS
- [x] `npm run lint:release-workflow`: PASS
- [x] `npm run lint:file-size`: PASS
- [x] `npm audit --omit=dev --audit-level=moderate`: PASS（0 vulnerabilities）
- [x] `npm audit signatures`: PASS（285 signatures / 74 attestations）
- [x] `cargo check --locked --manifest-path src-tauri/Cargo.toml --all-targets`: PASS
- [x] `cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`: PASS
- [x] `git diff --check`: PASS

### 検証計画の更新

- 初回の全VitestはRust release前検査との並列負荷により、`main-provider-boundary.test.tsx`だけがassertion到達前に5秒timeoutした。
- GitHub CIの同一HEADでは603/603 PASS済み。ローカルは負荷を分離し、対象テストと全Vitestを順次再実行して再現性を判定する。
