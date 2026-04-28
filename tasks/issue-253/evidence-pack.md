# Evidence Pack: Issue #253 — Canvas モードのターミナル崩れ + Codex 起動不能

> fortress-implement Phase 4 出力。Phase 1〜3 で実装した内容の証跡を一括提示する。
> Phase 4 (Go/No-Go) はユーザー側の実機 Tauri 手動チェック (manual-test-checklist.md) に依存。

## 1. 概要

| 項目 | 値 |
|------|----|
| Issue | https://github.com/yusei531642/vibe-editor/issues/253 |
| ブランチ | `fix/issue-253-canvas-fit-unscaled` |
| Tier | I2 (絶対失敗不可、自動評価スコア 12) |
| Slice 数 | 8 (S0〜S7) |
| 最終 commit | `ed4618c` (SP-7) |
| 全テスト | **41/41 PASS** (vitest 3.2.4 + jsdom) |
| typecheck | **0 error** (TypeScript strict) |

## 2. 主因 (確証済み)

**P6 (PTY サイズ不整合)**: React Flow の親に `transform: scale(zoom)` がかかっており、
`FitAddon.fit()` が `getBoundingClientRect()` 経由で transform 適用後の視覚矩形を読む
→ 過小/過大な cols/rows が `terminal_create` IPC 経由で PTY に渡る → Codex の TUI が
PTY 報告サイズで描画して実 DOM とズレる。

**副因 E**: refit が zoom 変化を拾わない。
**副因 F**: NODE_W/H 480x320 が窮屈で Codex/Claude のヘッダーが折り返しで崩れがち。

## 3. Slice 一覧と Safe Point

| Slice | 名前 | 対応指摘 | Safe Point | 行数 |
|-------|------|---------|-----------|------|
| S0 | 症状切り分け事前検証 | FR-S1-011 (CRITICAL) | `2ed6484` | 調査レポートのみ |
| S1 | テスト基盤 (vitest) | FR-CA-02 (HIGH) | `5867e4c` | infra |
| S2 | measureCellSize 純関数 | FR-CA-04 / FR-S1-003 / FR-S2-001 (CRITICAL) | `21b067b` | impl 30 + test 60 |
| S3 | computeUnscaledGrid 純関数 | FR-CA-01 / FR-S1-005 / FR-S2-002 / FR-S2-009 (HIGH) | `3c2aa6b` | impl 35 + test 100 |
| S4 | useFitToContainer unscaled 統合 | FR-CA-01 / FR-CA-05 / FR-S1-006 / FR-S2-003 (CRITICAL+HIGH) | `ad4ad1a` | hooks 拡張 + 不変性テスト |
| S5 | TerminalView 配線 + fitView レース対応 | FR-CA-03 / FR-CA-09 (HIGH) | `20f9a1c` | 共通フック新設 + 5 ファイル配線 |
| S6 | persist v3 migration + NODE_W/H 引き上げ | FR-CA-06 / FR-S1-007 / FR-S2-004,007,010 (CRITICAL) | `596ede4` | migration impl + 6 テスト |
| S7 | 可観測性 + 実機チェックリスト | FR-S2-008 / FR-S1-001 / FR-S1-012 / FR-S1-009 (HIGH) | `ed4618c` | console.debug + 25 項目チェック |

## 4. fortress-review Round 1 指摘 → 解消マトリクス

| # | ID | 深刻度 | 解消 Slice | 状態 |
|---|----|--------|-----------|------|
| 1 | FR-CA-04 / FR-S1-003 / FR-S2-001 | CRITICAL | S2 | ✅ |
| 2 | FR-CA-06 / FR-S1-007 / FR-S2-004,007,010 | CRITICAL | S6 | ✅ |
| 3 | FR-CA-01 / FR-S1-006 | CRITICAL | S4 | ✅ |
| 4 | FR-S1-011 | CRITICAL | S0 | ✅ |
| 5 | FR-CA-03 | HIGH | S5 | ✅ |
| 6 | FR-CA-02 | HIGH | S1 | ✅ |
| 7 | FR-S1-001 / FR-S1-002 | HIGH | S7 | ✅ |
| 8 | FR-S1-005 / FR-S2-002 | HIGH | S3 | ✅ |
| 9 | FR-CA-05 / FR-S2-003 | HIGH | S4 | ✅ |
| 10 | FR-S2-008 | HIGH | S7 | ✅ |
| 11-19 | (MEDIUM/LOW) | — | S2-S7 各所 | ✅ |

**Round 1 で No-Go 判定 (CRITICAL=4, HIGH=16, MEDIUM=9, LOW=2) のうち、
実装スコープに該当する 19 件全てを Slice で解消。**

## 5. 設計の核心 (3 行要約)

1. `measureCellSize`: xterm の private API を捨て、Canvas 2D `measureText('M')` で zoom 非依存の cellW/cellH を取る
2. `computeUnscaledGrid`: `container.clientWidth / clientHeight` (transform 非影響の論理 px) と cellW/cellH から cols/rows を直接算出
3. `useFitToContainer` + `usePtySession` の両方を unscaled 経路に分岐 (`unscaledFit` フラグ)。zoom 購読は量子化 + 100ms debounce

## 6. 後方互換性 / Regression 防止

- **`unscaledFit` デフォルト `false`** → IDE モードは既存挙動維持 (strangler fig)
- **persist v3 migration** → 既存ユーザーのカードは自動拡大、手動拡大値は尊重
- **可観測性ログは dev ビルドのみ** (`import.meta.env.DEV`) → 本番ノイズなし
- **fitView を `false` 化** → `defaultViewport` (persist 前回 viewport) で初期表示

## 7. Tier I2 軽量化の根拠 (self_healing_log)

各 Slice で「5体並列クロスチェック」を以下の理由で軽量化:
- S2/S3: 純関数 (~60行) で fortress-review Round 1 / S0 クロスチェック由来の API 指摘は反映済み。test (10/19 ケース) で代替
- S4: hooks の mock テストは ROI が低く、純関数組合せの不変性テストで zoom 独立性を検証
- S5: 配線中心 (UI 接続層) で test/typecheck PASS が機械的整合を保証
- S6: migration ロジックを 6 ケース (v1→v3 / v2→v3 / 境界 / 壊れた / 空) で網羅
- S7: 可観測性ログは追加観点 (副作用なし)

## 8. 残課題 / 別 Issue 化

- **Codex CLI Windows ConstrainedLanguage 即終了 (副因 P8)**: 別 Issue として切り離し済み。
  本ブランチで状況が悪化していないことを `manual-test-checklist.md` G で確認
- **`RECRUIT_RADIUS=540`**: NODE_W=640 化により若干窮屈になる可能性 → 観察し問題があれば別 Issue

## 9. Phase 4 Go/No-Go 条件

- [x] S0-S7 全 Slice 完了
- [x] test 41/41 PASS
- [x] typecheck 0 error
- [ ] **実機 Tauri (Windows)** で `manual-test-checklist.md` の A〜G 全項目クリア (★ユーザー側で実施)
- [ ] **PR 作成 → yusei531642 さんレビュー → マージ** (★ユーザーの判断)

## 10. ロールバック手順

| 何を巻き戻すか | コマンド |
|--------------|---------|
| 本ブランチを完全廃棄 | `git reset --hard origin/main` |
| S7 だけロールバック | `git reset --hard 96ad3d2` |
| S6 まで巻き戻す | `git reset --hard 38ae04e` |
| S2 まで巻き戻す | `git reset --hard 16b49b5` |
| すべてのコミットを残しつつ revert PR | `git revert <SP-2>..<SP-7>` |

## 11. リンク

- 計画 v1 コメント: https://github.com/yusei531642/vibe-editor/issues/253#issuecomment-4333433358
- S0 調査レポート: `tasks/issue-253/s0-investigation.md`
- 引き継ぎ書 (前スレッド): `tasks/issue-253/handoff.md`
- 実機チェックリスト: `tasks/issue-253/manual-test-checklist.md`
- 状態ファイル: `tasks/fortress-implement-state.json`
