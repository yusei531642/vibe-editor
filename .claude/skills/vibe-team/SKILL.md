<!-- vibe-team-skill-version: 1.0.0 -->
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

> **動的ロールは永続化されます** (Issue #513): `team_recruit({ role_definition: ... })` で
> 作成した動的ロールの label / description / instructions / instructionsJa は
> `~/.vibe-editor/role-profiles.json#dynamic[]` に保存され、アプリ再起動 / Canvas 復元時に
> 自動的に Hub の `dynamic_roles` map へ replay されます。なので **再起動後も同じ
> `role_definition` を再投入する必要はなく**、`team_recruit({ role_id: "marketing_chief" })` のように
> id だけ指定すれば既存定義をそのまま使えます。古い定義の意味的更新が必要なときだけ、
> 同 `role_id` で新しい `role_definition` を渡して上書きしてください。

## 役割別の振る舞い

### 1. Leader

- ユーザーから **最初の指示が来るまで何もせず待機** する。自走しない。
- 指示が来たら、そのゴールに合わせて必要なロールを設計し、`team_recruit` で 1 コールずつ採用する。
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
- **構造的強制 (Issue #518)**: `team_create_leader({engine_policy: { kind: "codex_only" }})` でチームに engine policy をセットすると、以後の全 `team_recruit` で Hub が違反 engine を **構造化エラー (`recruit_engine_policy_violation`) で拒否** する。Codex-only / same-engine 制約を受けたら、Leader は**最初の `team_create_leader` で `engine_policy` を必ずセット**しておくと HR や自分自身の混合事故を物理的に消せる (LLM の指示忘れリスクを Rust 側で吸収)。`team_info` の `enginePolicy` フィールドで現在のチーム policy を確認できる。

### 2. HR (大量採用専任)

- Leader からの依頼 (`[Team ← leader]`) が来るまで **待機**。能動的に動かない。
- 依頼を解釈し、各枠ごとに `team_recruit` を 1 コール呼ぶ。**ロールを自分で発明しない**。
  - Leader が定義文 (label/description/instructions) を渡してきたら、それをそのまま `team_recruit` の引数に流し込む。
  - Leader が「すでに作成済みの role_id を採用して」と指定してきたら、`role_id` と `engine` だけで `team_recruit` を呼ぶ。
  - Leader engine constraint は必ず保持する。`Codex-only` / `same-engine` 指定では全枠に `engine:"codex"` を渡し、Claude を代入したり `engine` を省略したりしない。
  - Issue #518: チームに `engine_policy` がセットされていれば、Hub が違反 engine を `recruit_engine_policy_violation` で構造的に拒否する。HR は `team_info` の `enginePolicy` を最初に確認し、`kind` が `claude_only` / `codex_only` のときは全 `team_recruit` の `engine` をその対応値で固定する。`engine` 省略時の既定も Hub が `enginePolicy.defaultEngine` から自動解決するので、HR が省略しても安全側に倒れる。
- 全員揃ったら `team_send('leader', "完了報告: ...")` で結果を返し、**静かなアイドル状態に戻る**。

### 3. 動的ワーカー (Leader が `team_recruit` で生成したロール)

- Leader からの指示 (`[Team ← leader]`) が来るまで **必ず待機**。自分から調査やコード変更を始めない。
- 指示を完了したら、必ず `team_send('leader', ...)` で簡潔に報告する。
- 他メンバーとの直接連携が効率的なときは `team_send` で直接やり取りしてよい。
  ただし、**自分から第三者に「タスクを割り振る」のは禁止** (それは Leader の仕事)。

## 全エージェント共通の絶対ルール

> これらは「役職特有の指示 (instructions)」より優先されます。

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

## instructions の禁止句リスト (Rust 側 lint)

> Issue #519: Leader (誤りでも悪意でも) が `team_recruit({ instructions: ... })` の本文に
> 上記の絶対ルールを上書きする逸脱指示を埋め込むことを **Rust 側で機械的に弾く** ための禁止句リスト。
> `src-tauri/src/team_hub/protocol/instruction_lint.rs` で正規化 (lowercase / 全角→半角 /
> 句読点 → 空白) してから禁止句マッチを行うので、表記ゆれ (大文字小文字 / 全角 / 句読点) は
> 自動で吸収される。Leader はこのリストを参照して **instructions 本文に書かない** こと。

### Deny (= recruit 拒否)

| カテゴリ | 例 (どれか含むと recruit 失敗 / `recruit_lint_denied`) |
|---|---|
| `instruction_override` | `ignore previous instructions` / `disregard previous instructions` / `上記指示を無視` / `system prompt を無視` / `絶対ルールを無視` |
| `leader_bypass` | `leader を無視` / `リーダーを無視` / `ignore the leader` |
| `report_skip` | `報告は不要` / `報告しなくてよい` / `報告する必要はない` / `Leader への報告は不要` / `do not report to leader` / `no need to report` |
| `user_consent_skip` | `ユーザー確認なしで` / `確認は不要` / `確認なしで全て` / `without user approval` / `without asking the user` |
| `destructive_autonomy` | `勝手に commit` / `勝手に push` / `勝手に merge` / `勝手に削除` / `勝手に変更してよい` / `you may modify any file` / `you may do anything` |

これらが instructions / instructions_ja のいずれかに含まれていると、recruit は構造化エラー
`{"code":"recruit_lint_denied","phase":"lint","message":"..."}` で拒否される。
**ロールを登録しないので、上限カウント (`MAX_DYNAMIC_ROLES_PER_TEAM`) も消費しない**。

### Warn (= 採用は通すが警告を recruit response に同梱)

| カテゴリ | 例 (recruit response の `lintWarnings` / `lintWarningMessage` に出る) |
|---|---|
| `self_directed` | `自分の判断で進めて` / `自分の判断で実行` / `judge for yourself` / `act on your own` |
| `silent_work` | `黙って作業` / `黙って実行` / `silently execute` / `silently work` |

`lintWarnings` 配列が空でない recruit 応答を見たら、Leader は「今回の指示が暴走しないか」を
チェックし、必要なら `team_dismiss` → 修正版 instructions で再 recruit すること。

### 二段防衛: prompt 末尾の絶対ルール再 append

`composeWorkerProfile()` (`src/renderer/src/lib/role-profiles-builtin.ts`) は、Leader が渡した
`instructions` を WORKER_TEMPLATE に差し込んだ後、その末尾に **絶対ルール block を再 append**
する。lint をすり抜けた逸脱指示が prompt の最後に来ても、その後に絶対ルールが上書きで再宣言
されるので、LLM は最終的に「報告必須 / 確認必須 / 沈黙作業禁止」を最も新しい指示として読む。

## 動的ロール instructions の必須テンプレ (Rust 側 validation)

> Issue #508: 動的ロール定義の **構造的な品質** を Rust 側で機械的に担保する。`instruction_lint`
> (#519) は「禁止句が含まれているか」を見る逆責務に対し、本ルールは「必須要素が **欠けていないか**」
> を見る。`src-tauri/src/team_hub/protocol/role_template.rs` で正規化 + heading 検出 + token
> マッチを行い、deny / warn を recruit response に乗せる。

### 必須 4 軸 (canonical 順)

instructions は次の 4 セクションを **この順序で** 含めること。英語表記を正、`(...)` の和訳併記は任意:

```
### Responsibilities (責務)
- 各セクションは 1〜数行の本文 (≥ 20 bytes) を持たせる
- 空セクションは warn (`thin_section`) になる

### Inputs (前提・参照)
- このロールが受け取る引数 / 参照ファイル / 前提となる外部システム

### Outputs (生成物)
- このロールが produce する成果物 (PR / コメント / commit / report 等)

### Done Criteria (完了条件)
- DoD = Definition of Done。ここを満たしたらロールの仕事は終わり
```

`Done Criteria` の alias として `Definition of Done` / `DoD` も受理。順序が狂っていると `section_order`
warn、不足軸があれば `missing_section` warn、各セクションの本文が < 20 bytes なら `thin_section` warn。

### Deny (= recruit 拒否、`recruit_role_too_vague`)

| カテゴリ | 条件 |
|---|---|
| `too_short` | combined instructions (en + ja) の trim 後が < 80 bytes |
| `missing_all_sections` | 4 軸見出しが 1 つも見つからない (テンプレ未使用) |

### Warn (= 採用は通すが `templateWarnings` / `templateWarningMessage` に同梱)

| カテゴリ | 条件 |
|---|---|
| `missing_section` | 4 軸のうち 1〜3 軸が欠落している |
| `section_order` | 4 軸が `Responsibilities → Inputs → Outputs → Done Criteria` の順序に並んでいない |
| `thin_section` | あるセクション本文が < 20 bytes |
| `missing_worktree_rule` | 後述の Worktree Isolation Rule トークンが欠落している |
| `vague_label` | label が `Support` / `サポート係` / `汎用` / `便利屋` / `何でもやる` 等の曖昧名 |

### Worktree Isolation Rule (5 トークン必須)

instructions には worker が採用直後に実行すべき固定コマンドブロックを含めること。次の 5 トークンを
全て含めば validation は pass (順序は問わない、日本語 instructions 中の断片でも OK):

| 必須トークン | 目的 |
|---|---|
| `git worktree add` | 物理的に独立した作業ディレクトリを作る |
| `origin/main` | 起点を必ず origin/main に固定 (他 worker の HEAD を踏まない) |
| `Set-Location` (or `cd`) | 作成後は worktree に CWD を移す |
| ` -b <branch>` | 既存 branch checkout 禁止 = 必ず新規 branch を切る |
| `vive-editor-worktrees` | 親 dir 名 (de-facto root) |

例:

```
git worktree add F:/vive-editor-worktrees/issue-<N> -b <type>/issue-<N>-<slug> origin/main
Set-Location F:/vive-editor-worktrees/issue-<N>
```

これを instructions に書いておくと、worker 自身が採用直後の最初のアクションとして実行する。
**Rust validation は欠落を warn 止まりにしてあるので、Leader の文体差で誤検知しても recruit は止まらない**。
ただし warn が出続ける場合は SKILL.md の Worktree 隔離セクション (skill_integrator 担当 docs) を読み直すこと。

### 例: clean instructions が validate_template を pass する形

```
### Responsibilities (責務)
- vibe-team の動的ロール instructions に必須テンプレ validation を追加する。
- 4 軸 + Worktree Isolation Rule をチェックし、deny/warn で recruit response に同梱する。

### Inputs (前提・参照)
- recruit args (label / description / instructions / instructions_ja)
- 既存の dynamic role registry 状態 (`MAX_DYNAMIC_ROLES_PER_TEAM` などの上限カウントを含む)

### Outputs (生成物)
- 登録された DynamicRole + recruit response の templateWarnings 配列
- deny の場合は構造化 RecruitError(code=recruit_role_too_vague, phase=template_validation)

### Done Criteria (完了条件)
- cargo test team_hub::protocol::role_template が全 pass
- bot review が APPROVED で merge される

採用直後の最初のアクション:

git worktree add F:/vive-editor-worktrees/issue-508 -b enhancement/issue-508-dynamic-role-template-validation origin/main
Set-Location F:/vive-editor-worktrees/issue-508
```

## 動的ロール責務境界 lint (Rust 側 role_lint)

> Issue #517: `instruction_lint` (#519) が「禁止句が含まれているか」、`role_template`
> (#508) が「必須要素が欠けていないか」を見るのに対し、本ルールは **「他の既存メンバーと
> 責務範囲が重複していないか」** を見る逆責務のモジュール。Leader / HR が同質ロールの
> 重複を量産するのを `team_recruit` / `team_assign_task` 段階で warn する。
> `src-tauri/src/team_hub/role_lint.rs` で char trigram の Jaccard 類似度を計算する
> language-agnostic な実装 (英語 / 日本語混在テキストでも閾値が安定)。

### 設計方針

- **WARN のみ** (DENY しない)。偽陽性で正当な採用 / 割り振りを妨げない方針。
- recruit / assign 両方で warn が出ても **採用 / 割り当ては成立する**。Leader が response の
  `boundaryWarnings` / `boundaryWarningMessage` を読んで判断する。renderer 側は同時に
  `team:role-lint-warning` event を受け、Canvas の toast 通知で Leader / 観察者に通知する。
- 5 軸 (`investigate / implement / verify / review / integrate`) のどこに偏っているかは
  Leader の編成判断に任せ、本 lint は「重複の有無」だけを機械的に検出する分担。

### Recruit 時のチェック (`compute_role_overlap`)

- 新規 `team_recruit` で **動的ロール定義を同梱した場合のみ** 評価する (既存 role 再採用は対象外)。
- 同 team の既存動的ロール群と新ロールの (label + description + instructions) を文字 3-gram に
  分解し、Jaccard `|A∩B| / |A∪B|` を計算。
- 閾値 `RECRUIT_OVERLAP_THRESHOLD = 0.45` を超えたペアは `recruit_role_overlap` warn。

| カテゴリ | 条件 |
|---|---|
| `vague_keyword` | role_id / label / description / instructions のいずれかに #508 `vague_label` と同じ曖昧パターン (`Support` / `サポート係` / `汎用` / `便利屋` / `何でもやる` 等) **に加えて** `general` / `general purpose` / `miscellaneous` / `なんでも` / `何でも屋` / `万屋` も含む |
| `recruit_role_overlap` | 既存メンバーとの Jaccard 類似度 ≥ 0.45 (具体的な相手 role_id が `other_role_id` に乗る) |

> #508 の `vague_label` (label のみ検査) に対し、#517 の `vague_keyword` は **role_id / label / description / instructions の全テキスト** を検査する点が異なる。リストは #508 のものを完全継承して `general` 系の英語表記を追加した superset。

### Assign Task 時のチェック (`compute_task_overlap`)

- `team_assign_task(assignee, description)` の description を 3-gram 分解。
- 同 team の他 worker 全員の (description + instructions) と Jaccard を計算。
- 閾値 `ASSIGN_OVERLAP_THRESHOLD = 0.30` (description は短くなりがちなので RECRUIT より緩め)。
- target 以外で閾値超過の worker が居れば「task が target 以外にも重なっている」warn を返す。

| カテゴリ | 条件 |
|---|---|
| `assign_task_overlap` | description が target 以外の worker 責務と Jaccard ≥ 0.30 (相手 role_id を `other_role_id` に同梱) |

### 「責務境界」と「Responsibilities (4 軸見出し)」の使い分け

> 用語ゆれ防止のため明示しておく:
>
> - **責務 (Responsibilities)** = 1 ロール **内部の** 4 軸見出しの 1 つ。「このロール自身が
>   何をやるか」を書くセクション (#508 の必須テンプレ参照)。
> - **責務境界 (role boundary)** = **複数ロール間で** 担当範囲が重ならないこと。本セクションの
>   lint が見る対象。
> - 同じ「責務」という日本語が登場するが、前者は **ロール内** 、後者は **ロール間** という
>   軸の違いがある。Leader が編成を考えるときは両方を意識する。

### Renderer 側の表示

`team:role-lint-warning` event (payload: `{ source: "recruit"|"assign", message, findings, ... }`)
は `ToastProvider` (`src/renderer/src/lib/toast-context.tsx`) が listen して warning tone の
toast を 8 秒表示する。Canvas / IDE どちらのモードでも同じ toast 経路に乗る。

> Rust struct field 名は **`boundaryWarnings`** / **`boundaryWarningMessage`**、renderer
> event 名は **`team:role-lint-warning`** で意図的に分かれている (前者は payload 内の意味的
> フィールド名、後者は emit 側のモジュール名 prefix `role_lint` を継承した命名慣習)。
> 後続 PR で UI 側を触る worker は両方の命名を覚えておくこと。

### 採用後チェックでの活かし方 (Leader 行動規約 / 6 番目の補完判断)

`## 役職分担テンプレ (5 軸)` の **「採用前チェック (5 行ルール)」を通過した上で** 、recruit
レスポンスの `boundaryWarnings` を読んで以下を確認する。**「採用前チェック」5 行ルールは
#507 で確定済の invariant**なのでそれ自体は変更せず、本 lint は「採用直後 / assign 直後の
判断軸」として 6 番目の補完位置に置く:

- `boundaryWarnings` が空であること、または含まれていても Leader が「重複は意図的 (例:
  ペアレビュー目的の二重採用、A/B test の同質ロール 2 名併走)」と判断できること
- warn が unintended なら役職を `team_dismiss` し、role_id / label / instructions を
  絞り直してから再 recruit する
- assign 時の `assign_task_overlap` warn も同様に「target 以外の worker が同じ description を
  抱えていないか」を Leader が確認する。意図的に複数 worker にまたがる task なら
  `team_assign_task` を分割するか、**意図的な重複であることを Leader メモで残す**

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

## 最小フロー (調査 → 実装 → 検証 → レビュー → 統合)

Leader が「採用 / 割り振り / レビュー / 統合 / 最終判断」をすべて 1 人で抱え込まないよう、チームが回す **最小フロー** を 5 段階で固定する。各段階に担当者を 1 名以上アサインしてから recruit を進めること。

| 段階 | 主な活動 | 典型ロール |
|---|---|---|
| 1. 調査 (investigate) | 仕様読解 / 既存コード把握 / 外部資料収集 / 影響範囲の特定 | researcher / explorer / planner |
| 2. 実装 (implement) | 設計どおりのコード変更・ファイル新設 / IPC 配線 / UI 配置 | programmer / rust_specialist / renderer_specialist |
| 3. 検証 (verify) | typecheck / build / 単体テスト / 手動再現の確認 | tester / qa / verifier |
| 4. レビュー (review) | 設計整合 / 命名 / セキュリティ / a11y / i18n / 規約遵守の指摘 | reviewer / security_reviewer / a11y_reviewer |
| 5. 統合 (integrate) | conflict 解消 / commit message 整形 / PR 作成 / bot レビューループ完走 | integrator / release_manager |

**フローの最小単位はこの 5 段階で 1 周**。1 名が複数段階を兼ねるのは可だが、「調査だけ 3 名いて検証担当 0 名」のような偏りは Leader が recruit 前に潰すこと (次の「役職分担テンプレ」参照)。

段階間の引き継ぎは `team_send` の本文先頭に `[handoff: investigate→implement]` のように区切りを書き、次担当が `team_read` で拾えるようにする。

## 役職分担テンプレ (5 軸)

Leader が `team_recruit` を始める前に、必ず以下の 5 軸のうち **どの軸を誰が担当するか** をメモすること (チャットへの 1 行で十分)。空白軸 (= 担当 0 名) があるまま実装に入ってはいけない。

```
- 調査 (investigate): <role_id or self>
- 実装 (implement):   <role_id or 複数 (領域別)>
- 検証 (verify):      <role_id> ※小規模タスクなら実装者と同一人物で可
- レビュー (review):  <role_id> ※実装者と別人を推奨 (相互チェック)
- 統合 (integrate):   <role_id> ※Leader 兼任の場合はその旨明記
```

### 採用前チェック (Leader 自身が通す 5 行ルール)

1. 5 軸すべてに担当が割り当たっているか? 空白軸があるなら追加 recruit してから着手する。
2. 同一軸に **3 名以上**集中していないか? 過剰なら別軸へ振り直す。
3. 「実装」「レビュー」「統合」を **同一人物が独占**していないか? レビューが実装者と同一だと欠陥が見過ごされる。
4. **3 名以上** specialist を採用する場合は HR を先に立て、HR に編成情報 (5 軸割り) も同時に渡す。
5. **6 名以上**になる場合は専任の進捗管理ロール (project_manager 等) を 1 名置き、Leader は統合と最終判断に集中する。

このチェックを通してから `team_recruit` を実行する。実装途中で軸の偏りが顕在化したら、その時点で 1 から再評価して `team_dismiss` / 追加 recruit で調整する。

## 統合フェーズ (Leader が最後に通す 4 ステップ)

5 軸の最終段「**統合 (integrate)**」は Leader (もしくは Leader が任命した integrator ロール) が責任を持って通す。複数 worker の成果が散逸しないよう、必ず以下 4 ステップを順に踏む。

### Step 1: 収集 (gather)

- すべての担当 worker から **構造化 report** を吸い上げる。
- 各 worker は `team_update_task(task_id, "done", { ..., report_payload: { findings, proposal, risks, next_action, artifacts } })` で構造化レポートを返す (Issue #516)。
  - `findings` — 調査・実装で得られた発見 (1〜数段落の markdown)
  - `proposal` — 採用方針の推奨 (1 行で良い)
  - `risks` — リスク・既知の懸念事項のリスト
  - `next_action` — 次の handoff 先の作業 (top-level `next_action` と重複可)
  - `artifacts` — 生成物のパス配列 (PR 番号 / ファイル / 計測結果 JSON 等)
- 収集の起点は `team_get_tasks()` と Rust 側 `team-state/<project>/<team_id>.json` の `worker_reports[]`。Leader はチャット履歴ではなくこれらの構造化データを **唯一の正** とする。

### Step 2: 矛盾抽出 (diff)

- 複数 report を **軸ごとに横並び** にして読む (findings / proposal / risks / artifacts)。
- 矛盾しやすい典型パターン:
  - **proposal の対立** — 「memoize で解決」vs「アーキテクチャ作り直し」
  - **risks の盲点** — A の findings に出ているリスクが B では未言及
  - **artifacts のスコープ食い違い** — 同じファイルを 2 名以上が独立に変更して衝突
- 矛盾が見つかったら、Leader はその 2〜3 名に `team_send` で **相互に共有** する (`[diff: A の proposal vs B の proposal]` と明示)。1 名に「他者の findings を読んで再評価して」と依頼してもよい。

### Step 3: 優先度判定 (prioritize)

- 残った提案を以下の 3 軸で優先度づけする:
  1. **ユーザー要求への直接性** — 当初の指示にどれだけ直接答えているか
  2. **リスクの残量** — risks が解消されているか / 受容可能か
  3. **コスト** — 実装工数 / レビュー工数 / マージ後の保守負担
- 同点なら「2. リスク残量が小さい方」を優先する。

### Step 4: 採用方針 (decide & execute)

- 採用する proposal を 1 つに確定し、`team_send('leader→all', "採用方針: ... (理由 1 行)")` で全員に通達する。
- 採用された worker (もしくは integrator) が単一の PR にまとめて push する。**複数 worker の小 PR を並列に出さない** — bot レビューと merge が直列になり統合判断が崩れる。
- PR 本文の `## Summary` には Step 2 で見つかった主要な矛盾と Step 4 の採用根拠を 2〜3 行で残す。後から「なぜこの選択をしたか」が辿れるようにする。
- 統合専任の `integrator` ロールを使う場合のサンプル instructions は `src/renderer/src/lib/role-profiles-builtin.ts` の `INTEGRATOR_TEMPLATE_INSTRUCTIONS_JA` / `_EN` を参照 (`team_recruit({role_id:"integrator", instructions: ...})` でそのまま使える)。

## Worktree 隔離 (運用 invariant)

> **これは vibe-team 全 worker (Leader / HR / 動的ワーカー) に適用される最優先の運用 invariant**。
> 「## 全エージェント共通の絶対ルール」よりさらに前 — 「採用直後、`[Team ← leader]` を待つよりも先」に実行する。

### なぜ必須か (背景)

vibe-team の動的ワーカーはそれぞれ独立した Claude セッションだが、**ファイルシステムは vibe-editor リポジトリの単一 working tree を共有する**。複数 worker が同時に `git checkout` を回すと、以下の事故が発生する:

- 他 worker の **uncommitted changes が静かに失われる** (working tree から消える / stash で上書きされる)
- 別 branch の状態を踏んでビルドや typecheck が誤った結果を返す
- どの worker の作業がどの commit に入ったか **追跡不能**になる

実際に #507 / #508 / #511 / #516 / #521 を並走した際に、`#511` の inject.rs ~300 行が一時消失 (rescue 済み) し、`#521` の renderer 4 ファイルが消失確定した観測事例がある。`team_diagnostics.lastSeenAt` 等の活性監視では **file-level の損失は検知できない** ため、運用 invariant としてここに固定化する。

### 採用直後の最初のアクション (FIRST ACTION)

worker は採用された直後 (= `[ABSOLUTE RULES]` を読んだ次の瞬間)、**指示を待つよりも先に** 以下 2 行を順に実行する:

```
git worktree add F:/vive-editor-worktrees/<short_id> -b <branch> origin/main
Set-Location F:/vive-editor-worktrees/<short_id>
```

これは **1 度だけの setup**。setup 完了後は通常の絶対ルール (rule 1: 指示が届くまで何もしない) に戻る。指示が届く前にコード調査・編集を始めるのは禁止だが、自分の作業ディレクトリを物理的に隔離する setup だけは例外として許可する。

### placeholder の意味

| placeholder | 形式 | 例 |
|---|---|---|
| `<short_id>` | kebab-case、英数字 + `-`、≤ 32 文字 | `issue-516` / `worktree-isolation-rule` |
| `<branch>` | プロジェクト規約通り (`<type>/issue-<N>-<slug>` 等) | `enhancement/issue-516-update-task-report-payload` |

固定要素 (Leader が instructions を書くときも変えない / Rust 側 #508 validation でトークン照合する):

- `git worktree add` — 動詞句
- `origin/main` — 起点を必ず origin/main に固定 (他 worker の HEAD を踏まない)
- `Set-Location` — PowerShell 規約。Bash 環境なら `cd` 同義
- `-b <branch>` — 既存 branch checkout 禁止 = 必ず新規 branch を切る
- `vive-editor-worktrees` — 親 dir 名 (de-facto root)

### 解雇時のクリーンアップ

worker が `team_dismiss` された (もしくは作業完了して PR が merge された) ときは、自分が作った worktree を削除する。Leader / HR は dismiss 直前に対象 worker へ次を `team_send` で促す:

```
git worktree remove F:/vive-editor-worktrees/<short_id>
git branch -D <branch>   # ローカル branch も使い終わっていれば
```

worktree を残すと `git worktree list` が肥大化するが、誤って残しても害はない (orphan は `git worktree prune` で掃除可能)。

### 非 Windows 環境

vibe-editor は Windows-first だが、worktree path の親 dir 名 (`vive-editor-worktrees`) だけ守れば置く場所は自由:

| 環境 | 推奨 path |
|---|---|
| Windows | `F:/vive-editor-worktrees/<short_id>` (本 SKILL.md の default) |
| macOS / Linux | `~/vive-editor-worktrees/<short_id>` または `<repo-parent>/vive-editor-worktrees/<short_id>` |

forward slash で書けば msys git / native git どちらも解釈する。Windows 上で backslash を使うと PowerShell の escape と衝突しやすいので避ける。

### Rust 側 validation との整合 (#508)

`#508 (PR #533)` で Rust 側に `validate_template` が実装され、recruit 時に Worktree Isolation Rule の 5 トークンが instructions に含まれているかをチェックする。トークンが欠落していても **WARN** に留まり recruit は止まらないが、`templateWarnings` に `missing_worktree_rule` が乗るので Leader は気付ける。Leader が instructions を書くとき、本セクションの「FIRST ACTION」コードブロック (5 トークンを全部含む) をそのまま貼り付ければ validation は確実に pass する。

詳細な validation 仕様 (alias / 順序チェック / 各セクション本文長) は `## 動的ロール instructions の必須テンプレ (Rust 側 validation)` (上方) を参照。

## 名前空間 (vibe-editor 独自)

- 環境変数: `VIBE_TEAM_*` / `VIBE_AGENT_ID`
- ファイル領域: `~/.vibe-editor/` 配下のみ
- MCP サーバー名: `vibe-team`
- agentId プレフィックス: `vc-`

裏で Anthropic 公式の `agent teams` 等が動いていてもパス・環境変数・サーバー名すべて衝突しない設計です。
