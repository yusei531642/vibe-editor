# Issue #1161 Mission Brief

## 目的

release workflow が、対象 commit の正当性と必須品質ゲートを確認せずに署名付き draft release を生成できる経路を閉じる。

## 観測可能な合格条件

- release 対象 ref が `main` の履歴に含まれない場合、build / signing より前に失敗する。
- release build は再利用可能な CI quality gate の成功を必須依存にする。
- workflow 権限は job の責務に必要な最小範囲で定義される。
- 同一 ref の重複 release 実行を concurrency で抑止する。
- Linux RPM を含む成果物マトリクスと公開手順の記述が一致する。
- workflow 構文、静的契約テスト、既存品質ゲートが PASS する。

## Non-goals

- GitHub Organization / Repository の tag ruleset や environment protection を無断で変更すること。
- release ビルド基盤、署名方式、バージョニング方式の全面刷新。
- 過去の release workflow run の再実行・削除。

## 前提・依存

- `.github/workflows/ci.yml` を `workflow_call` 可能にし、既存 push / pull_request 動作を維持する。
- `.github/workflows/release.yml` は quality gate と ancestry guard の後だけ build を開始する。
- 古い workflow 定義を参照する tag からの実行は、workflow 内の修正だけでは完全には防げない。tag ruleset / protected environment は残存リスクとして明示し、設定変更については別途ユーザー承認を得る。
- 実装前に、この Mission Brief と Slice 境界についてユーザー承認を得る。

## Tier 判定

- Tier: I1
- スコア: 9
- 根拠: 公開 release 境界 4 点、既存の専用契約テスト不足 3 点、GitHub Actions の完全なローカル E2E が難しい 2 点。

## Slice 計画

### Slice 1: 再利用可能な CI quality gate

- RED: `workflow_call` と必須 job 契約を検証する静的テスト。
- GREEN: `ci.yml` に `workflow_call` を追加し、既存 trigger と job を維持する。
- 検証: YAML parse、契約テスト、既存 lint / typecheck / Rust gate。
- rollback: Slice 1 のコミットを revert。

### Slice 2: release の ref guard と gate dependency

- 前提: Slice 1 が PASS。
- RED: ancestry guard、quality-gate dependency、権限、concurrency、RPM 契約の静的テスト。
- GREEN: signing 前の guard、reusable CI 呼び出し、`needs`、最小権限、concurrency、文書整合を追加する。
- 検証: YAML parse、契約テスト、actionlint が利用可能なら実行、PR 上の GitHub Actions 実行。
- rollback: Slice 2 のコミットを revert。既存 release workflow に戻るため、その間は release 実行を停止する。

## 成功・停止条件

- 各 Slice の RED → GREEN 証跡を保存する。
- GitHub Actions の reusable workflow 制約と現行設計が衝突した場合は、推測で迂回せず公式仕様を確認して計画を更新する。
- ruleset / environment 変更が必要になった時点で停止し、別途ユーザー承認を求める。
