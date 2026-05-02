# Clippy Baseline (Issue #373)

リファクタリング着手時点 (`refactor-baseline-v1.4.7` タグ予定地点) の `cargo clippy` 警告 **15 件** をベースラインとして記録する。

> **方針**: Phase 0 ではこれらを **解消しない**。Issue #373 の「ついで修正は入れないこと」(オーナーコメント) を厳守。
> リファクタ過程で **新規警告が増えていないこと** を判定する基準として使用する。
> 解消は別 issue を切って独立 PR で実施 (Phase 1〜5 の中で自然に解消されるものは除く)。

## 計測コマンド
```
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

実行環境: Windows 11 / Rust 1.85.0 / `refactor/issue-373-phase0-baseline` branch (main `2ad355d` 起点)。

---

## 警告一覧 (15 件)

| # | ファイル:行 | lint | 種別 | リファクタで解消される見込み |
|---|---|---|---|---|
| 1 | `src/commands/app.rs:666` | `doc_lazy_continuation` | 日本語 doc コメントのインデント | — |
| 2 | `src/commands/files.rs:201` | `manual_range_contains` | range の慣用化 | Phase 4 (`files.rs` 分割時に巻き取り可) |
| 3 | `src/commands/files.rs:205` | `len_zero` (`sample.len() > 0`) | `!sample.is_empty()` 推奨 | Phase 4 |
| 4 | `src/commands/files.rs:381` | `question_mark` (`.pop()?` で簡潔化) | `?` 演算子化 | Phase 4 |
| 5 | `src/commands/terminal.rs:136` | `doc_lazy_continuation` | 日本語 doc コメントのインデント | Phase 3 (PTY 境界整理時に巻き取り可) |
| 6 | `src/mcp_config/codex.rs:65` | `manual_unwrap_or_default` | `unwrap_or_default()` 推奨 | — |
| 7 | `src/pty/claude_watcher.rs:235` | `useless_conversion` (`.into_iter()` 不要) | iterator 慣用化 | Phase 3 |
| 8 | `src/pty/registry.rs:171` | `result_large_err` | `SessionHandle` の Err variant が 216 byte → `Box<>` 化推奨 | **Phase 3 (PTY 境界整理) で自然に再設計対象** |
| 9 | `src/team_hub/inject.rs:46` | `doc_lazy_continuation` | 日本語 doc コメントのインデント | Phase 2 |
| 10 | `src/team_hub/protocol.rs:881` | `doc_lazy_continuation` | 日本語 doc コメントのインデント | **Phase 2 (`protocol.rs` 分解) で消える** |
| 11 | `src/team_hub/mod.rs:215` | `doc_lazy_continuation` | 日本語 doc コメントのインデント | — (Phase 2 では `mod.rs` を触らない方針) |
| 12 | `src/team_hub/mod.rs:488` | `too_many_arguments` (8 引数、上限 7) | 関数シグネチャ変更必要 | — (Phase 2 では `mod.rs` を触らない方針) |
| 13 | `src/team_hub/mod.rs:557` | `doc_lazy_continuation` | 日本語 doc コメントのインデント | — |
| 14 | `src/team_hub/mod.rs:558` | `doc_lazy_continuation` | 日本語 doc コメントのインデント | — |
| 15 | `src/team_hub/mod.rs:844` | `needless_return` | `return` の省略 | — |

---

## カテゴリ別集計

| カテゴリ | 件数 | コメント |
|---|---|---|
| `doc_lazy_continuation` (日本語 doc) | 7 | 機械的修正可。挙動には無関係 |
| イディオム (`len_zero` / `manual_range_contains` / `question_mark` / `manual_unwrap_or_default` / `useless_conversion` / `needless_return`) | 6 | 機械的修正可 |
| 構造変更が必要 (`result_large_err`, `too_many_arguments`) | 2 | API 変更を伴うのでリファクタ Phase で扱う |
| **合計** | **15** | — |

---

## 運用ルール (本ベースライン適用後)

1. リファクタ中に `cargo clippy` の **新規警告が増えていない** ことを各 PR で確認する。
2. 上記 15 件のうち、リファクタで巻き取った (= 該当行ごと消えた) ものは PR 本文で明示する。
3. 上記 15 件以外で新たに警告が発生した場合は **当該 PR 内で解消** すること (新規導入は許可しない)。
4. `cargo clippy` を CI で `-D warnings` のままにしたい場合は、本ベースライン解消用 issue が closed されるまでは `--cap-lints warn` を一時的に検討してもよい (本 PR では何も変更しない)。

## 関連
- Issue #373 — God File 解体ロードマップ
- Phase 2 (team_hub `protocol.rs` 分解) — `protocol.rs:881` の警告は分割により自然消滅見込み
- Phase 3 (PTY 境界整理) — `registry.rs:171` `result_large_err` は再設計対象
- Phase 4 (`files.rs` 分解) — `files.rs:201/205/381` の 3 件を巻き取れる
