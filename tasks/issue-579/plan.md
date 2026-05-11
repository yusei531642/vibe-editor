## 実装計画

### ゴール
PTY spawn 経路に **観測ログ + 経過時間メトリクス** を仕込み、Windows 上での新規 PTY 起動 (cmd.exe + npm shim 解決) の所要時間を **p50 / p95 で可視化** する。本 issue のスコープは「観測ログ + 1 週間程度のデータ収集」までとし、最適化施策 (PTY pool / lazy spawn 等) は収集データを見て別 issue 化する。

### 影響範囲 / 触るファイル
- `src-tauri/src/pty/session.rs`
  - PTY spawn のエントリポイント (`Session` 生成 / `pty_pair.slave.spawn_command(...)` 呼び出し直前後) に `let started = Instant::now();` を打ち、success / failure 双方で elapsed_ms を tracing 出力。
  - 出力フォーマット: 
    - 成功: `tracing::info!("[pty] spawn ok command={cmd_label} engine={engine} platform={platform} elapsed_ms={elapsed}")`
    - 失敗: `tracing::warn!("[pty] spawn failed command={cmd_label} engine={engine} platform={platform} elapsed_ms={elapsed} error={err}")`
  - `cmd_label` は機密情報を漏らさないよう、`redact_home` (既に import 済み) で正規化。フルパスではなく basename + engine ヒントに留める。
  - `engine` は `is_codex` フィールドから `claude` / `codex` を判定。
  - `platform` は `cfg!(target_os = "windows" / "macos" / "linux")` で文字列化。
- `src-tauri/src/pty/mod.rs` (該当時) — 必要なら spawn ヘルパを 1 箇所に集約 (リファクタが過剰になるなら避ける)。
- `src-tauri/src/team_hub/protocol/tools/recruit.rs` (該当時) — handshake 待機側でも `[teamhub] recruit handshake elapsed_ms=...` を tracing::info で出すと、PTY spawn とのタイムスタンプ照合が容易になる (任意)。
- (テスト) `src-tauri/src/pty/session.rs` の `#[cfg(test)] mod tests` — spawn が成功した場合に tracing log subscriber でログが出ることを `tracing-test` クレート (既に dev-dependency にあれば再利用) で確認。重い E2E は CI でやらない。
- (集計用 docs) `tasks/issue-579/notes.md` (新規) — 計測の見方 / 1 週間後の集計方法 / 次 issue の起票条件 (中央値が handshake timeout 30s の 10% = 3s を超えるなら最適化 issue を起こす) を書き残す。

### 実装ステップ
- [ ] Step 1: `session.rs` の spawn 直前に `Instant::now()` を打ち、spawn の Result を受けてから elapsed を計算するよう微改修。
- [ ] Step 2: 成功 / 失敗の両分岐で `tracing::info!` / `tracing::warn!` を入れる。フォーマットは固定 (機械パース可能な key=value)。
- [ ] Step 3: `cmd_label` を作るユーティリティを既存の `redact_home` を使って整える (basename + engine、フルパス漏洩を防ぐ)。
- [ ] Step 4: `engine` と `platform` を引数に追加 (Spawn 内部の判定で十分なら追加引数不要)。
- [ ] Step 5: 単体テストで「spawn 経路を通ると `[pty] spawn` で始まる log が 1 回出る」ことを確認 (tracing-test 等)。
- [ ] Step 6: `tasks/issue-579/notes.md` に「1 週間後の集計方法 (例: PowerShell で `Select-String '\[pty\] spawn ok' app.log | ...`)」と「次 issue 起票条件」を書く。

### 検証方法
- `cargo test -p vibe-editor pty::session` (新規テストが通る)
- `cargo build` で release ビルドが通る
- `npm run build` で Tauri ビルドが通る
- 手動回帰: 
  - Windows: `npm run dev` → claude 5 回 + codex 5 回 recruit → log を抽出 → p50 / p95 が算出可能なフォーマットで出力されることを確認。
  - macOS: 同様 (CI 環境で代替可)。
  - Linux: ベストエフォートで確認。
- 失敗パスも検証: 存在しないコマンドを spawn → `[pty] spawn failed elapsed_ms=...` が出ることを確認。

### リスク・代替案
- リスク 1: ログ汚染。`tracing::info!` を毎 spawn で出すと運用ログが太る。→ 既に PTY spawn は頻度が低い (recruit 時 / 手動 terminal 起動時のみ)。`info` レベルで OK。それでも気になるなら env 変数で `debug` 降格可能に。
- リスク 2: 機密情報漏洩。CWD / 環境変数のフルダンプは絶対にしない (`redact_home` 通すだけ、env は対象外)。`cmd_label` は basename + engine。
- リスク 3: 計測値が単発のばらつきで判断を誤る。→ 1 週間程度の集計で p50 / p95 を見ること、評価基準は notes.md に明記。
- 代替案: histogram crate (`metrics`, `prometheus`) を入れる → 過剰。tracing ログ + 後処理で十分 (本 issue のスコープ)。

### 想定 PR 構成
- branch: `chore/issue-579-pty-spawn-metrics`
- commit 粒度: 1 commit (session.rs + tests + notes.md)。
- PR title 案: `chore(pty): #579 spawn 所要時間を tracing ログで可視化`
- 本文に `Closes #579` を含める。`Refs #574` も併記。
- 依存関係: 他の #574 follow-up とは完全独立。先行 merge 可能。
