---
name: agent-team
description: Claude Code の Agent Teams (実験的) — 完全に独立した複数 Claude セッションを並列稼働させ、teammate 同士で直接メッセージを交わす重量級マルチエージェント機能を、いつ・どう使うか判断するための skill。subagent が「親に結果サマリのみ返す軽量委譲」なのに対し、Agent Team は「複数の Claude が同時に長時間稼働し、shared task list 経由で協調する」もの。token cost が線形に増えるが、相互依存のある大規模並列タスク (複数領域の同時実装 / 大規模レビュー / C コンパイラを書くレベル) で威力を発揮する。ユーザーが「agent team」「team を組んで」「並列セッション」「複数 Claude」「Agent Teams」「teammate」「team lead」「Shift+Down で切替」「split panes でやって」「3 人並列で実装」「領域分担して並列に」等を言ったとき、また subagent では context が浅すぎる / 編集を伴う長時間並列タスクが必要なときには必ずこの skill を起動すること。subagent との使い分け判断にも使う。
---

# agent-team

**Agent Teams** = 完全に独立した複数の Claude Code セッションを並列稼働させる Anthropic の実験的機能。

`subagent` が「軽量・結果サマリだけ返す」のに対し、Agent Team は **「複数の Claude が同時に長期間動き、teammate 同士で直接メッセージを交わし、shared task list で協調する」** という、もう一段重い仕組み。

token cost は線形に増える代わりに、相互依存のある大規模並列タスクで圧倒的な並列性を出せる (Anthropic 公式は 16 agent × 約 2000 session で 10 万行の Rust 製 C コンパイラを完成させた事例を公開)。

---

## subagent との違い (重要な判断軸)

| 観点 | subagent | Agent Team |
|---|---|---|
| **context** | 同セッション内で独立窓 (親はサマリのみ閲覧) | 完全に独立した別セッション |
| **通信** | 親 ⇔ 子 のみ (子同士は通信不可) | teammate 同士で直接メッセージ可 |
| **token cost** | 低 (子の context は親に流れない) | 高 (全 teammate 分が独立に走る) |
| **寿命** | タスク 1 回で終わる | 長時間稼働・複数 turn |
| **可視性** | 親は中身を見られない | split panes / Shift+Down で観察可 |
| **編集の自由度** | 親と同じファイルを触ると競合する | teammate ごとにファイル/領域を所有 |
| **適した規模** | 数分〜10 分 / 単発 | 数十分〜数時間 / 複合タスク |

### どちらを選ぶか

- **subagent で十分**: 単発調査・レビュー・要約・並列 grep
- **Agent Team が必要**:
  - 複数領域 (Canvas / PTY / Settings) を **同時に編集**したい
  - teammate 間で **設計を相談しながら** 進めたい
  - **長時間** (数時間規模) かかる作業を分担したい
  - 親が一人で見るには context が足りない規模

迷ったらまず subagent。Agent Team は「コストとオーバーヘッドの覚悟」が要る。

---

## 有効化

実験的機能なので明示的に有効化が必要。

```json
// settings.json (project or user)
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"
  }
}
```

`update-config` skill 経由で設定するのが安全。再起動が必要な場合あり。

---

## 起動と運用

### 起動
team lead (= 自分が今いる Claude) に自然言語で依頼すると、lead が teammate を spawn する:

```
PR #142 をレビューする agent team を組んで。3 人体制で:
- security 観点
- performance 観点
- test coverage 観点
それぞれ独立に調査して、最後に findings を統合して報告。
```

Lead がやること:
1. teammate を spawn (各自に独立 session)
2. shared task list に作業を登録 (teammate 間で見える)
3. 各 teammate の進捗を監視 / 方向修正
4. 結果を統合して user に返す

### 表示モード

| モード | 特徴 | 推奨ケース |
|---|---|---|
| **in-process** (デフォルト) | 全員が main terminal に統合表示。`Shift+Down` で teammate 切替 | 観察・軽い監視 |
| **split panes** (tmux / iTerm2) | 各 teammate が独立ペイン。同時に並行操作可 | 重い作業・各 teammate を直接介入したい |

### サイズ・粒度の経験則

- **team size**: **3〜5 teammate** が最適
  - < 3: 並列性が足りない
  - > 5: coordination overhead が増えて lead が捌けない
- **タスク粒度**: 1 teammate あたり **5〜6 タスク**
  - 細かすぎると task list の更新負荷で遅くなる
  - 粗すぎると並列性が出ない
- **領域分担**: teammate 間で **触るファイルを重複させない** (merge conflict の元)

---

## ベストプラクティス

### 1. 領域オーナーシップを明示する
teammate ごとに「お前は src-tauri/ の担当」「お前は src/renderer/components/canvas/ の担当」と最初に区切る。
重複触りは Agent Team 最大の事故要因。

### 2. shared task list を「契約」として使う
task の DoD (定義) を最初に書き切る。teammate は self-organize するので、曖昧な task は曖昧な実装で返ってくる。

### 3. lead は積極的に介入する
放置すると teammate が暴走 (無関係なリファクタ等) するので、定期的に進捗を確認して方向修正する。
「監督者であり実装者でもある」のが lead の仕事。

### 4. 結合は最後に lead がやる
各 teammate の出力を merge / type sync / IPC wiring するのは lead の責務。
teammate 同士で勝手に統合させない (一貫性が崩れる)。

### 5. trust but verify (subagent と同じ)
teammate が「完了」と言っても、lead が `git diff` / `npm run typecheck` で検証する。

---

## 推奨チーム構成 (5 軸モデル)

vibe-team skill と整合する **5 軸モデル** で teammate を割り当てると、領域分担と DoD 設計が自然に揃う。

| 軸 | teammate 役割 | 主な触る場所 (vibe-editor 例) |
|---|---|---|
| 調査 | researcher / explorer | issue・仕様書・既存実装の grep / read のみ |
| 実装 | implementer | 担当領域 1 つ (Canvas / PTY / Settings 等) を独占的に編集 |
| 検証 | verifier | typecheck / build / 単体テスト / 手動再現 |
| レビュー | reviewer | 実装者と別人。設計・命名・セキュリティ・a11y を指摘 |
| 統合 | integrator (= 多くの場合 lead) | 5 点同期 / 4 層同期 / commit / PR / bot レビューループ |

### 推奨組み合わせ (team size 別)

- **3 人体制 (最小)**: lead 兼統合 + 実装 1 + レビュー 1。調査と検証は実装者と兼任。短時間タスク向け。
- **4 人体制 (定番)**: lead 兼統合 + 調査 1 + 実装 1 + レビュー 1。検証は実装者またはレビュアーが流す。
- **5 人体制 (上限)**: lead 兼統合 + 調査 1 + 実装 2 (領域分担) + レビュー 1。検証は各実装者が走らせる。

> 6 人以上にしたくなったら **タスクを 2 イテレーションに割って team を 2 回回す** ほうが coordination overhead が低い。

### lead が統合を専任する効用

- 5 点同期 (`tauri-ipc-commands`) や 4 層同期 (`theme-customization`) は teammate 間に分散させると壊れやすい
- 各 teammate の出力差分を読み、commit / PR メッセージを書き、bot レビューを回すのは lead 1 人に集約するほうが速い
- レビュー指摘の取り込みも lead 経由のほうが「再 push 後の整合性」が崩れにくい

---

## アンチパターン

- ❌ **3 人とも同じファイルを編集** — merge hell
- ❌ **task list を書かずに「やっといて」** — teammate が迷子になる
- ❌ **5 人以上の team** — coordination 破綻
- ❌ **lead が放置** — teammate が無関係な変更を始める
- ❌ **subagent で済む規模に Agent Team を使う** — 単に高い
- ❌ **依存関係が強い直列タスクを並列化** — 結局 teammate 1 が完了するまで他が待つ
- ❌ **`isolation: worktree` を使わずに 3 人とも同じ branch を編集** — 競合不可避
- ❌ **長時間稼働を前提に組んだのに途中で context 制限に当たる** — 各 teammate の作業範囲を絞る

---

## vibe-editor での適用例

### 例 A: Canvas / PTY / Settings の領域並列実装

```
Lead (自分)
├─ Teammate A: Canvas 関連
│  └─ src/renderer/src/components/canvas/, stores/canvas.ts
├─ Teammate B: PTY 関連
│  └─ src-tauri/src/pty/, src/renderer/src/components/TerminalView.tsx
└─ Teammate C: Settings 関連
   └─ src-tauri/src/commands/settings.rs, src/renderer/src/components/settings/

Lead の最終仕事:
- src/types/shared.ts の型統合
- src/renderer/src/lib/tauri-api.ts の wrapper 統合
- 統合テスト・PR 作成
```

vibe-editor 固有の **5 点同期 (`tauri-ipc-commands`)** や **4 層同期 (`theme-customization`)** は teammate に分散させると壊れやすいので、**lead が最後にまとめて担当する**のが安全。

### 例 B: 多角レビュー team (PR 提出前)

```
Lead
├─ Teammate A: security review (auth, IPC validation, file path traversal)
├─ Teammate B: performance review (React re-render, IPC latency, PTY batching)
├─ Teammate C: a11y / i18n review
└─ (optional) Teammate D: codex:rescue 系で別 LLM 視点
```

これは subagent でも代替可。**編集を伴うか / 議論が必要か** で Agent Team へ昇格判断。

### 例 C: 大規模リファクタ (Tauri v2 移行のような)

数時間〜数日規模で、Rust と TS 両側を同時に書き換える必要がある場合は Agent Team が候補。
ただし vibe-editor の現状コードベース規模なら subagent + 人間レビューで足りる場合が多い。**最初から Agent Team に飛びつかない**こと。

---

## 起動前チェックリスト

Agent Team を起動する前に以下を自問:

- [ ] subagent では本当に足りないか？ (大半のケースは足りる)
- [ ] teammate 間で触るファイルは重複しないか？
- [ ] 各 teammate の DoD は明確か？
- [ ] team size は 3〜5 に収まっているか？
- [ ] lead (自分) が監督に時間を使えるか？
- [ ] token コスト増加をユーザーは承知しているか？

1 つでも No なら subagent に降格するか、要件を整えてからにする。

---

## 関連 skill

- `subagent` — まず subagent で済まないか検討する
- `update-config` — `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` の有効化
- `vibeeditor` — vibe-editor の領域分割 (Rust 側 / renderer 側 / Canvas / PTY) を理解した上で teammate に割り当てる
- `pullrequest` — Agent Team の成果を PR にまとめて bot レビューループへ流す
