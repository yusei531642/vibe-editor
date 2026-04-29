---
name: subagent
description: Claude Code の subagent (Task / Agent tool による子エージェント委譲) を「いつ・どう使うか」を判断し、適切な subagent_type で起動して並列に作業させるための skill。メインの context window を圧迫せず、調査・探索・並列レビュー・独立タスクを子エージェントに任せて高速化するために使う。ユーザーが「subagent で調べて」「並列に調査して」「Explore で探して」「並列でやって」「context 汚したくない」「複数同時に走らせて」「sub agent」「サブエージェント」「Task tool」「Agent tool」「並列レビュー」「3 つ同時に」等を言ったとき、また自分が広範囲な調査・複数の独立タスク・別 context が欲しいタスクを行おうとしているときには必ずこの skill を起動して subagent 起動を検討すること。並列調査・探索・レビューを sequential にやろうとしているときの「気付き skill」としても機能する。
---

# subagent

Claude Code の **subagent** = `Agent` tool / `Task` tool で起動できる子エージェント。
「メインの context を汚さず、独立した context window で作業させる」のが本質。
親には **結果サマリのみ** が返るので、大量ログ・grep 結果・ファイル中身が main を圧迫しない。

この skill は「subagent を呼ぶべきか / どう呼ぶか / どう書くか」の判断 skill。

---

## いつ subagent を使うか

### 強く推奨 (積極的に並列化)
- **広範な調査** — 「この機能どこで使われてる？」「依存関係は？」「過去の実装は？」など 3 query 以上必要なもの → `Explore`
- **複数の独立タスク** — 同時に違うファイル/領域を触る作業 → 並列 `general-purpose` × N
- **別視点の検証** — レビュー / 第二意見 / 設計レビュー → `Plan` や独立 `general-purpose`
- **ノイズの多い結果** — log 解析・大量の grep 結果・長い transcript の要約 → `general-purpose`

### 不要 (直接やった方が速い)
- 場所が分かっている 1 ファイルを読む → `Read`
- 既知 symbol の grep → `Grep`
- 1 〜 2 query で済む確認
- 既に context にある情報を再確認するだけ

### 微妙 (判断ポイント)
- 中規模調査 (3〜5 query) → 自分でやって良いが、結果が長文ログを伴うなら subagent
- ユーザーへ即返答が要る対話 → subagent は遅延が出るので避ける

---

## ビルトイン subagent の使い分け

| subagent_type | 用途 | 強み | 注意 |
|---|---|---|---|
| `Explore` | コード探索専用 (read-only) | 速い・探索に特化 | 全文読まない (excerpt のみ) → 設計レビュー不可 |
| `general-purpose` | 何でも屋 | フル tool 利用可・編集も可 | 重い・トークン消費 |
| `Plan` | 実装計画立案 | アーキ視点で plan を返す | 編集はしない |
| `statusline-setup` | ステータスライン設定専用 | — | — |
| `claude-code-guide` | Claude Code 公式仕様の Q&A | docs / web 参照 | 限定用途 |
| `codex:rescue` | 別 LLM (GPT-5 系) で裏取り | 視点の多様化 | コスト高 |

**迷ったら**: 探索 = `Explore` / 計画 = `Plan` / 編集を伴う作業 = `general-purpose`。

---

## 起動方法 (`Agent` tool)

```
Agent({
  description: "Branch ship-readiness audit",   // 3〜5 語
  subagent_type: "general-purpose",              // 省略時は general-purpose
  prompt: "<self-contained な指示>",
  run_in_background: false                       // 並列に他の作業を進めたいなら true
})
```

### 並列起動

**同じメッセージ内で複数の `Agent` 呼び出しを並べる** と並列実行される。
直列に呼ぶと意味がない (1 個ずつ待つことになる)。

```
1 メッセージ内で:
  Agent(security-review)
  Agent(performance-review)
  Agent(test-coverage-review)
→ 3 つ同時に走る
```

### isolation: "worktree"

副作用のあるタスク (ファイル編集・git 操作) を試したいけど main の作業を汚したくない場合、
`isolation: "worktree"` を渡すと一時 git worktree で作業させられる。変更が無ければ自動 cleanup。

---

## prompt の書き方 (重要)

subagent は **親の会話履歴を一切見ていない**。
「さっき調べた件」「上で出てきたあの関数」では伝わらない。**self-contained に書く**。

### 良い prompt のチェックリスト
- [ ] **目的**: 何を達成したいか (1〜2 文)
- [ ] **背景**: なぜこのタスクが必要か / これまでに何を試したか / 何を除外済みか
- [ ] **入力**: 関連ファイルパス・symbol 名・URL を明示
- [ ] **求める出力の形**: 「200 字以内のサマリ」「punch list」「修正パッチ」等
- [ ] **判断材料**: 細かい手順より「考えるべき問い」を渡す (前提が間違っていれば手順は無意味)

### Bad
```
prompt: "this を調査して"
prompt: "Canvas を直して"
prompt: "テストを書いて"
```
→ 浅い・的外れな結果が返る。

### Good
```
prompt: "Canvas モードで card 削除時に edge が残る issue #123 の調査。
src/renderer/src/stores/canvas.ts の removeCard を中心に、
removeNode と edges の連動が正しく行われているか確認してほしい。
@xyflow/react の getConnectedEdges が呼ばれているか、
zustand persist の migration で古い orphan edge が残っていないかも見てほしい。
報告は: 原因の仮説 (複数可) / 触るべきファイル / 修正方針案、を 300 字以内で。"
```

### 「research か write か」を明示する
subagent は user の意図を知らないので、

- 「**調査だけ**してほしい (write しないで)」
- 「**実装まで**してほしい」
- 「**plan だけ**返して」

を prompt 冒頭で明示する。曖昧だと subagent が勝手に編集してしまうことがある。

---

## アンチパターン

- ❌ **3 query で済む調査に Explore を呼ぶ** — オーバーヘッドの方が大きい
- ❌ **既に subagent が走っている query を自分でも grep する** — 二重作業
- ❌ **subagent の自己申告を盲信** — 「修正完了」と言われても **diff を確認**する (Trust but verify)
- ❌ **prompt に「上記を踏まえて」と書く** — 上記が見えていない
- ❌ **直列に 5 個 Agent を呼ぶ** — 並列にできるなら 1 メッセージにまとめる
- ❌ **Explore に編集を期待する** — read-only。書きたいなら general-purpose
- ❌ **巨大な context を渡そうとする** — prompt は要点のみ。子側で必要なら自分で読ませる

---

## Trust but verify の実践

子から「fix した」「test 通った」と返ってきたら、

1. `git diff` で実際の変更を見る
2. `npm run typecheck` / `npm run build` を自分で叩く
3. 子が触ったと主張するファイルを `Read` で確認

特に編集系 subagent は楽観的な report をしがち。**親が最終責任**。

---

## vibe-editor での実用パターン

### パターン A: 並列調査 (Issue 起票前)
```
Agent(Explore, "issue #N の関連コードを src-tauri 側から探索")
Agent(Explore, "同じ issue の renderer 側 (src/renderer/) から探索")
→ 両側を並列に把握 → 自分で統合
```

### パターン B: 並列レビュー (PR 出す前)
```
Agent(general-purpose, "security 観点でレビュー")
Agent(general-purpose, "performance 観点でレビュー")
Agent(codex:rescue, "別 LLM で第二意見")
→ 3 つ並走 → 親で統合判断
```

### パターン C: 大量ログの要約
PTY のクラッシュ調査などで `cargo run` の出力が長くなりそうなとき、
親が直接 stdout を浴びるとすぐ context が埋まる。
→ `general-purpose` に「実行して原因仮説 5 行で返して」と委譲。

### パターン D: Plan → Implement の分離
```
Agent(Plan, "issue #N の実装計画を立案")
→ 計画レビュー → 親が実装 (or 別 Agent に渡す)
```

vibe-editor では **`issue-plan` skill** がこの Plan フェーズを担うので、組み合わせると効率的。

---

## 関連 skill

- `agent-team` — 完全独立セッションで teammate 同士が通信し合うレベルの並列化が必要な場合
- `vibeeditor` — vibe-editor でコードを書く前に必ず参照
- `finalfix` — 詰んだバグで重量級調査が必要なときに subagent を組み合わせる
