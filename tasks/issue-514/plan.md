## 実装計画

### ゴール
チーム人数が 4 名以上になっても Leader が管理を破綻させないよう、Canvas 上に「全 worker の状態 / 担当タスク / 未読 / blocked / stale」を集約表示するダッシュボードを設置する。

### 影響範囲 / 触るファイル
- 新規 `src/renderer/src/components/canvas/TeamDashboard.tsx` — チーム単位の集約 HUD (テーブル UI: agent / role / status / task / lastSeenAt / pendingInbox / blockedReason)
- `src/renderer/src/components/canvas/StageHud.tsx` — ダッシュボード開閉ボタン
- `src/renderer/src/lib/tauri-api.ts` — diagnostics + get_tasks の合成 wrapper
- `src-tauri/src/team_hub/protocol/tools/diagnostics.rs` — 必要なら集約用フィールド追加 (Issue #510 と整合)
- `src-tauri/src/team_hub/protocol/tools/get_tasks.rs` — 既存をそのまま使用
- `src/renderer/src/lib/i18n.ts` — i18n 文字列追加
- `src/renderer/src/styles/components/team-dashboard.css` — テーブルレイアウト

### 実装ステップ
- [ ] Step 1: TeamDashboard コンポーネント雛形 (props: teamId)
- [ ] Step 2: diagnostics + get_tasks を 5s poll で取得し table render
- [ ] Step 3: 重要度ハイライト: stale (黄)、blocked (赤)、unread > 60s (橙)
- [ ] Step 4: Leader 注意ゾーン (重複タスク / 未割当 inbox / 同質ロール) を summary 行で表示
- [ ] Step 5: Canvas 左パネルまたは右上ポップアップへの統合
- [ ] Step 6: i18n + テーマ対応
- [ ] テスト: 既存テスト + render テスト (任意)

### 検証方法
- `npm run typecheck` / `npm run build`
- 手動: 6 名チームを構成 (Leader 含む)、1 名 stale / 1 名 blocked にして dashboard が一覧で識別できるかを確認
- パフォーマンス: 10 名でも 5s poll で UI が固まらないことを確認

### リスク・代替案
- リスク: 大人数で poll コストが増える。差分更新 (event push) との将来統合を視野に。
- 代替案: dashboard を Settings の TeamHub タブに置く (Canvas を侵食しない)。今回は Canvas 内に出すほうが価値が高い。

### 想定 PR 構成
- branch: `enhancement/issue-514-team-dashboard`
- commit 粒度: 1 commit
- PR title: `enhancement(vibe-team): Canvas に Team 管理ダッシュボードを追加 (status / task / unread / stale 集約)`
- 本文に `Closes #514`、関連 #510 / #521 / #525 を記載
