## 実装計画

### ゴール
Canvas 上に並ぶ Agent カードと TeamHub overlay について、Leader / ユーザーが「誰が何を / いつから / 次に何が必要か」を 1 行で把握できる状態要約 UI を整備する。Issue #514 のダッシュボードを補完するカード単位の表示と Canvas 全体の summary HUD を提供する。

### 影響範囲 / 触るファイル
- `src/renderer/src/components/canvas/AgentNodeCard/CardFrame.tsx` — header に「current task title (truncate) / 最終出力からの経過 / 次に Leader 入力が必要か」の 3 行サマリ
- `src/renderer/src/components/canvas/StageHud.tsx` — Canvas 全体の summary HUD (active N / blocked M / stale K / completed L)
- `src/renderer/src/lib/tauri-api.ts` — diagnostics + tasks の合成 (Issue #510 / #514 と共通基盤)
- `src/renderer/src/styles/components/agent-card.css` — サマリ行のレイアウト追加
- `src/renderer/src/lib/i18n.ts` — i18n 文字列追加
- `.claude/skills/vibe-team/SKILL.md` — Leader 行動規約に「ターン冒頭に team summary を 3 行で出す」を追記

### 実装ステップ
- [ ] Step 1: AgentNodeCard サマリ行 (3 行 / 折り返し制御)
- [ ] Step 2: Canvas 全体 summary HUD コンポーネント
- [ ] Step 3: Leader 行動規約に「ターン冒頭サマリ 3 行」を追加
- [ ] Step 4: i18n + glass-surface 対応 (theme: glass のときも崩れない)
- [ ] テスト: render テスト (任意)

### 検証方法
- `npm run typecheck` / `npm run build`
- 手動: 全テーマ (claude-dark/light, dark, midnight, light, glass) でレイアウトが崩れないこと
- 手動: 大人数 (8 名) のチームで HUD が固まらないこと

### リスク・代替案
- リスク: カード密度が高すぎて文字が重なる。compact 密度では 1 行に圧縮、normal 以上で 3 行表示。
- 代替案: hover 時のみ summary を出す (常時非表示)。情報が見えにくくなるため常時表示を採用。

### 想定 PR 構成
- branch: `enhancement/issue-521-canvas-state-summary`
- commit 粒度: 1 commit
- PR title: `enhancement(vibe-team): Canvas に worker summary 行と team summary HUD を追加`
- 本文に `Closes #521`、関連 #510 / #514 を記載
