## 実装計画

### ゴール
Leader が「採用 / 割り振り / レビュー / 統合 / 最終判断」を全部 1 人で抱えなくても回るよう、最小フローを skill / role テンプレに組み込み、編成不備 (調査ばかり / レビュー不在 / 統合担当不在) を Leader 自身が実装前に検知できる状態にする。

### 影響範囲 / 触るファイル
- `.claude/skills/vibe-team/SKILL.md` — Leader 行動規約に「最小フロー (調査 → 実装 → 検証 → レビュー → 統合)」と「役職分担テンプレ」セクションを追加
- `.claude/skills/agent-team/SKILL.md` — team 構成パターンの推奨モデルを追記
- `src/renderer/src/lib/role-profiles-builtin.ts` — Leader 用 instructions に「編成チェック (調査担当はいるか / 検証担当はいるか / 統合は誰か)」のチェックリスト追記
- (任意) `src-tauri/src/team_hub/protocol/tools/recruit.rs` — recruit 時に「現チーム構成」を返却して Leader prompt の materialization を助ける (任意・別 issue 化可)

### 実装ステップ
- [ ] Step 1: skill 側に「最小フロー」「役職分担テンプレ (調査 / 実装 / 検証 / レビュー / 統合の 5 軸)」を 1 セクション追加
- [ ] Step 2: Leader builtin instructions に「採用前チェック」(役割重複・空白の検出を Leader 自身で行う 5 行ルール) を追記
- [ ] Step 3: HR 拡張 (#525) と整合する文言にする (「3 名以上で HR / 6 名以上で進捗管理 / 統合担当を分離」)
- [ ] テスト: なし (skill 文書 + role 文字列のみ)

### 検証方法
- `npm run typecheck` (role-profiles-builtin.ts は string 定数なのでこれだけで足りる)
- 手動: Leader を新規採用して system prompt に「最小フロー」が含まれることを確認
- 関連 skill (vibe-team / agent-team) を /skill 起動して文言が反映されているか確認

### リスク・代替案
- リスク: skill 文言を増やしすぎると Leader prompt が肥大化して指示密度が下がる。1 セクション以内に収める。
- 代替案: TeamHub 側に「最小フロー lint」(役職欠落を recruit 時に warn) を入れる案 (#11/#525 と統合検討)。本 issue では skill / instructions レベルに留める。

### 想定 PR 構成
- branch: `enhancement/issue-507-leader-bottleneck`
- commit: 1 commit (`enhancement(vibe-team): Leader 最小フロー / 役職分担テンプレを skill と instructions に追加`)
- PR 本文に `Closes #507`、関連 issue (#508, #514, #516, #517, #525) を記載
