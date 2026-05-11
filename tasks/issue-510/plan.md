## 実装計画

### ゴール
Canvas 上の Agent カードと TeamHub overlay に「沈黙時間 / 状態 / pendingInbox / stale 判定」を常時表示し、Leader が個別カードを開かなくても worker の生存と進捗を把握できるようにする。

### 影響範囲 / 触るファイル
- `src/renderer/src/components/canvas/AgentNodeCard/CardFrame.tsx` — header に health indicator (●alive / ◐stale / ○dead + 経過秒) と current_status の 1 行表示を追加
- `src/renderer/src/components/canvas/StageHud.tsx` または新規 `TeamHealthHud.tsx` — チーム全体の summary (active / stale / blocked / dead の数) を 1 箇所に集約
- `src/renderer/src/lib/tauri-api.ts` — `team_diagnostics` の poll wrapper を追加 (interval 5s)
- `src-tauri/src/team_hub/protocol/tools/diagnostics.rs` — 既存指標 (lastSeenAt / lastStatusAt / currentStatus / pendingInbox) はそのまま使用。stale 閾値を const 化
- `src-tauri/src/team_hub/protocol/consts.rs` — STALE_THRESHOLD_SECS, DEAD_THRESHOLD_SECS を定義
- `src/types/shared.ts` — diagnostics レスポンス型に health 派生フィールドを追加

### 実装ステップ
- [ ] Step 1: consts.rs / diagnostics.rs に stale/dead 閾値と health enum を導入
- [ ] Step 2: tauri-api.ts に diagnostics poll を実装 (5s interval, focus 時のみ active)
- [ ] Step 3: AgentNodeCard CardFrame.tsx に health badge / 沈黙経過秒 / 現在 status を追加
- [ ] Step 4: StageHud に team summary HUD を追加
- [ ] Step 5: i18n (ja/en) 文字列追加 (`src/renderer/src/lib/i18n.ts`)
- [ ] テスト: 既存テストへの影響範囲を確認

### 検証方法
- `npm run typecheck` / `npm run build`
- 手動: 4 名チームを起動、1 名で長時間ビルド、1 名で即終了、1 名で沈黙、1 名で busy → 各 health 表示が変わるかを目視確認
- 手動: Canvas 切替時 (focus 喪失) に poll が止まることを確認 (CPU 負荷確認)

### リスク・代替案
- リスク: poll interval が短いと CPU / IPC コストが増える。focus / カード可視時のみ poll する。
- 代替案: Rust 側から push (event emit)。実装重いので poll を採用。

### 想定 PR 構成
- branch: `enhancement/issue-510-worker-health-check-ui`
- commit 粒度: Rust 1 / TS poll 1 / UI 1 (合計 3)
- PR title: `enhancement(vibe-team): worker health-check UI を Canvas に追加 (sleep age / status / stale)`
- 本文に `Closes #510`、関連 #509 / #524 を記載
