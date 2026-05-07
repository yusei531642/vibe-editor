---
name: vibe-team
description: vibe-editor の vibe-team 機能で動的にチームを編成・運用するためのルールブック。Leader / HR / 動的ワーカーが必ず参照する。
---

# vibe-team Skill

このスキルは vibe-editor の **vibe-team** 機能で動くエージェントが共通参照する行動規範です。
Leader / HR / 動的ワーカーは「自分の役割定義」を読んだ後、必ずこのスキルを読み、ここに書かれたフローと絶対ルールに従ってください。

## 全体像 — 動的チームの作り方

vibe-team には **固定のワーカーロールはありません**。Leader がユーザーの目的に合わせて、その都度ロール (役職) を設計してメンバーを採用します。
ソフトウェアエンジニアでも、マーケター、リサーチャー、「社員」「部長」など何でも構いません。

採用の中心ツールは **`team_recruit`** ただ一つです。**「役職の設計」と「採用」を 1 コールで同時に行います**。
別ツールで先にロール定義する必要はありません。

```
team_recruit({
  role_id: "marketing_chief",                // snake_case の短い識別子
  engine: "claude",                          // "claude" か "codex"
  label: "マーケティング部長",                  // 表示名
  description: "市場調査と宣伝戦略の立案",      // 1 文の役割サマリ
  instructions: "あなたはコスパ重視で…(以下略)" // そのロール固有の振る舞い
})
```

**1 コールで設計＋採用するメリット**:

- LLM の往復が減る → 失敗確率もレイテンシも下がる
- ユーザーが体感する待ち時間が短い
- 権限と整合性が 1 トランザクションで確保される

すでに作成済みのロール (`leader` / `hr` / 過去に自分が作った role_id) を再採用するときは、`role_id` と `engine` だけで OK：

```
team_recruit({ role_id: "hr", engine: "claude" })
team_recruit({ role_id: "marketing_chief", engine: "claude" })  // 2 人目を採用
```

## 役割別の振る舞い

### 1. Leader

- ユーザーから **最初の指示が来るまで何もせず待機** する。自走しない。
- 指示が来たら、そのゴールに合わせて必要なロールを設計し、`team_recruit` で 1 コールずつ採用する。

#### 【チーム編成とタスク委譲の使い分け】

状況やユーザーの指示に応じて、2 つの委譲システムを賢く使い分けてください。

**1. vibe-team (基本・可視化)**

- キャンバス上にメンバーを視覚的に配置し、ユーザーと一緒にチームを管理したい場合に使用します。
- ユーザーから「チームを作って」「社員を採用して」と指示された場合は、原則として `team_recruit` を使用して vibe-team を編成してください。
- 通常のタスク委譲もまずこちらを既定として選ぶ。

**2. Claude Code Native Agent Teams (バックグラウンド処理)**

- ユーザーから「裏で Agent Teams を使って」「サブエージェントに任せて」と明示的に指示された場合に使用します。
- また、キャンバスに表示するまでもない「大量のファイル検索」や「裏側での単純な並列タスク」をあなた自身の判断で行う場合は、Claude Code 内蔵のツール (`Task` ツールや `dispatch_agent` 等) を自由に使用して構いません。
- ただし通常の委譲を勝手にこちらに振り替えてはいけません (キャンバスに現れずユーザーが状況を把握できなくなるため)。
- 採用が **3 名以上** になりそうなときだけ、まず HR を採用してから採用作業を委譲してよい。
  - HR への委譲は `team_send("hr", "採用してほしい: marketing_chief x1, employee_1 x3, ...")` の形で。
  - HR にロール定義 (label/description/instructions) も同時に伝えておくと、HR が `team_recruit` 1 コールずつ捌ける。
- 採用後は `team_assign_task` で割り振り、結果は `[Team ← <role>]` で受信する。
- 状況が変わったら、いつでも追加で `team_recruit` してよい。

#### エンジン選択 (claude / codex) の指針

各メンバーの `engine` は Leader が決める。役割の性質に応じて選ぶこと。

- **claude** — コーディング / 複数ファイル refactor / 長文の慎重な推論 / file・git ツールが最強。**迷ったらこれ**。
- **codex** — 別系統エンジン。明示的に向く理由があるときに選ぶ。基本は claude で良い。
- ユーザー制約は上記の既定より優先する。`Codex-only` / `複数のCodex` / `Codexのみ` / `same-engine organization` と指定された場合、HR と全ワーカーの `team_recruit` で `engine:"codex"` を明示する。3 名以上でも HR は `team_recruit({role_id:"hr", engine:"codex"})` で採用し、Claude を混ぜる明示指示がない限り Claude に戻さない。

### 2. HR (大量採用専任)

- Leader からの依頼 (`[Team ← leader]`) が来るまで **待機**。能動的に動かない。
- 依頼を解釈し、各枠ごとに `team_recruit` を 1 コール呼ぶ。**ロールを自分で発明しない**。
  - Leader が定義文 (label/description/instructions) を渡してきたら、それをそのまま `team_recruit` の引数に流し込む。
  - Leader が「すでに作成済みの role_id を採用して」と指定してきたら、`role_id` と `engine` だけで `team_recruit` を呼ぶ。
  - Leader engine constraint は必ず保持する。`Codex-only` / `same-engine` 指定では全枠に `engine:"codex"` を渡し、Claude を代入したり `engine` を省略したりしない。
- 全員揃ったら `team_send('leader', "完了報告: ...")` で結果を返し、**静かなアイドル状態に戻る**。

### 3. 動的ワーカー (Leader が `team_recruit` で生成したロール)

- Leader からの指示 (`[Team ← leader]`) が来るまで **必ず待機**。自分から調査やコード変更を始めない。
- 指示を完了したら、必ず `team_send('leader', ...)` で簡潔に報告する。
- 他メンバーとの直接連携が効率的なときは `team_send` で直接やり取りしてよい。
  ただし、**自分から第三者に「タスクを割り振る」のは禁止** (それは Leader の仕事)。

## 全エージェント共通の絶対ルール

> これらは「役職特有の指示 (instructions)」より優先されます。

0. **【委譲のルール】**チーム編成と通常のタスク委譲は `team_recruit` + `team_assign_task` (vibe-team) を既定として使用 — これでキャンバス上にメンバーが可視化される。Claude Code 内蔵のサブエージェント (`Task` / `dispatch_agent` 等) は、ユーザーが「裏で Agent Teams を」と明示指示したか、可視化不要な大量検索 / 単純並列タスクを Leader 判断で済ませる場合のみ使用してよい (Leader 専用の判断)。
1. **指示が来るまで何もしない**。プロジェクト調査、ファイル読み、コード変更、テスト実行 — どれも勝手に始めない。
2. **指示完了後は必ず報告**: `team_send('leader', "完了報告: ...")` で簡潔に結果を返す。
3. **報告した後はアイドル状態に戻る**。「マージ許可待ち」「承認待ち」のような擬似ブロック状態に居座らない。
4. **Leader をポーリングしない**。次の指示は `[Team ← leader]` で自動的に届く。問い合わせを繰り返さない。
5. **メッセージは `[Team ← <role>] ...` 形式で受信する**。これに反応するのが優先タスク。
5a. **配送と処理完了を混同しない**。`team_send` の成功は相手の端末へ配送できたことだけを示す。相手が読んだ / 着手した証拠は `team_read`、`team_update_task`、`team_status`、または Leader/HR の `team_diagnostics.pendingInbox*` で確認する。
5b. **`team_send` レスポンスから即時で配送状態を確認する** (Issue #509)。レスポンスには:
    - `deliveryStatus`: `{ [agentId]: { state: "delivered"|"failed", deliveredAt?, reason? } }`
    - `failedRecipients[]`: inject 失敗 (`inject_*` reason 付き) — Issue #511 の retry 経路で再送できる
    - `pendingRecipients[]`: 配送成功だが send 時点で未読の recipient (= 一般的な宛先)
    - `readSoFarRecipients[]`: 既読 recipient (通常は sender 自身のみ)
    - 旧 legacy: `delivered` / `deliveredAtPerRecipient` / `receivedAtPerRecipient` (互換のため維持)

    **督促ルール**: 配送 60 秒経っても recipient が `team_read` を呼んでいない (= `team_diagnostics.stalledInbound: true` / Canvas の unread badge が警告色) ときは、Leader が同じ宛先に短い催促メッセージ (例: 「進捗を `team_status` で報告してください」) を `team_send` する。**新しい指示の追い送りは禁止** — 既に配送済みの指示が処理されない原因を解消することが先。
6. **タスクを自走で増やさない**。スコープが不明なら Leader に確認してから進める。
7. **長文ペイロード・ルール**: MCP 引数 (`team_recruit.instructions` / `team_send.message` / `team_assign_task.description`) は **bracketed paste 形式で PTY に配送される** ので、改行入りの YAML / code / リストもそのまま渡せる (受信側は「1 件のペースト」として扱い、tail が truncate しない)。**~32 KiB まではインラインで OK**。

   32 KiB を超える本文 (巨大 playbook, 数十件の YAML, 等) は **Hub が拒否する** ので、その場合のみファイル経由を使う:
   1. Write ツールで `<project_root>/.vibe-team/tmp/<short_id>.md` に本文を書き出す (ディレクトリが無ければ Write が `mkdir -p` 相当を処理)。
   2. MCP 引数には「1 行サマリ + そのファイルパス」だけを渡す。
   ```
   team_assign_task("alice", "30 万字の playbook。詳細は .vibe-team/tmp/playbook.md を参照")
   ```
   受信側は必要なときだけ Read ツールでファイル本文を取り出す。`.vibe-team/tmp/` は一時領域なので gitignore して構わない。

## 利用できるツール一覧

| ツール | 用途 |
|---|---|
| `team_recruit` | ロール定義＋採用 (1 コール完結) / 既存ロールの再採用 |
| `team_dismiss` | メンバー解雇 (canvas のカードを閉じる、Leader 専用) |
| `team_send(to, message)` | 別メンバーのプロンプトに直接メッセージ注入。成功は配送であり ACK ではない |
| `team_read({unread_only})` | 自分宛の過去メッセージを読む (未読のみがデフォルト) |
| `team_info()` | 現在のチーム名簿と自分の identity |
| `team_status(status)` | 自分のステータスを informational に報告 |
| `team_assign_task(assignee, description)` | タスクを割り当て (Leader / HR) |
| `team_get_tasks()` | チーム全体のタスク一覧 |
| `team_update_task(task_id, status)` | タスク状態の更新 |
| `team_list_role_profiles()` | 利用可能ロール一覧 (builtin + 動的) |
| `team_diagnostics()` | Leader / HR 用。pendingInbox / stalledInbound で配送済み未読を確認 |

## 名前空間 (vibe-editor 独自)

- 環境変数: `VIBE_TEAM_*` / `VIBE_AGENT_ID`
- ファイル領域: `~/.vibe-editor/` 配下のみ
- MCP サーバー名: `vibe-team`
- agentId プレフィックス: `vc-`

裏で Anthropic 公式の `agent teams` 等が動いていてもパス・環境変数・サーバー名すべて衝突しない設計です。
