# Issue #1155 Mission Brief

## 目的

PTY セッションの登録と終了監視の競合を解消し、即時終了または同一 ID の競合が起きても、稼働中セッションを誤削除せず、終了済みハンドルを registry に残さない。

## 観測可能な合格条件

- 終了監視は registry への登録完了後に有効になる。
- 同一 ID の古い watcher は、別ハンドルへ置換済みの registry entry を削除しない。
- 登録競合で採用されなかったハンドルは、既存 entry を変更せず安全に回収される。
- 即時終了、同一 ID 競合、通常終了の回帰テストが PASS する。
- terminal / PTY 関連テスト、`cargo check`、`cargo clippy -D warnings` が PASS する。

## Non-goals

- PTY API 全体の再設計。
- terminal UI、再接続 UX、ログ形式の変更。
- Issue #1178 の一括対応。#1178 は本修正を前提に、終了理由と renderer 側の起動制御を別 PR で扱う。

## 前提・依存

- 対象は `src-tauri/src/pty/registry.rs`、`src-tauri/src/pty/session/spawn.rs`、必要最小限の handle / terminal 統合コード。
- 現在の外部 API とイベント名は維持する。
- Issue #1155 のみを対象にし、Issue #1178やUI変更へ拡張しない。

## Tier 判定

- Tier: I1
- スコア: 8
- 根拠: 3 層にまたがる変更 3 点、既存テスト不足 3 点、競合の実環境 E2E が難しい 2 点。

## Slice 計画

### Slice 1: registry の所有権と identity-safe removal

- RED: 同一 ID の異なる handle が現 entry を削除できないテスト。
- GREEN: handle identity を確認する remove API と、登録完了を境界にした watcher 起動。
- REFACTOR: registry の責務を登録・同一性確認付き削除へ限定する。
- 検証: registry / session の単体テスト、`cargo check`、`cargo clippy`。
- rollback: Slice 1 のコミットを revert。

### Slice 2: spawn / terminal 統合と競合回収

- 前提: Slice 1 が PASS。
- RED: 即時終了と登録競合 loser が既存 entry を壊さないテスト。
- GREEN: loser を静かに回収し、既存の terminal retry 境界を保つ最小統合。
- 検証: terminal 117 tests、PTY 169 tests、all-target check / clippy。
- rollback: Slice 2 のコミットを revert。Slice 1 単独でも API は内部限定とする。

## 成功・停止条件

- 各 Slice の RED → GREEN 証跡を保存する。
- テストが仮説と異なる場合は実装を続けず、Mission Brief を更新して再承認を求める。
- Scope が #1178、UI、再接続設計へ広がる場合は停止する。
