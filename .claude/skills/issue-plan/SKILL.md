---
name: issue-plan
description: vibe-editor の GitHub Issue を読んで実装計画を立て、`planned` ラベルを付けて計画を Markdown コメントとして issue に投稿する skill。実装そのものは行わず「計画立案 + ラベル付与 + 計画コメント投稿」までで 1 つのワークフローとして完結させる。ユーザーが「issue の計画を立てて」「issue を読んで plan して」「実装計画を issue に書いて」「planned ラベルを付けて」「plan タグを付けて」「issue #N の計画」「この issue どう実装する？」「先に計画だけ書いて」「issue にプラン残して」「実装方針を issue にまとめて」等を言ったとき、また `gh issue view` した直後に「これの計画を残しておきたい」と言ったときには必ずこの skill を起動すること。issue-first ワークフロー (Issue → branch → PR) のうち branch を切る前段階の「計画フェーズ」を担うので、修正に着手する前のステップとして頻繁に呼ばれる想定。
---

# issue-plan

vibe-editor の Issue に対して **「読む → 調査する → 計画を立てる → planned ラベルを付ける → 計画コメントを投稿する」** までを一気通貫で行う skill。

実装 (= branch を切ってコードを書く) は **行わない**。この skill のゴールは「issue 単体を見れば、どう実装するつもりかが第三者にも分かる状態」を作ることまで。実装フェーズに入るときは別途 `vibeeditor` skill / 通常の編集フローに引き継ぐ。

---

## 全体フロー

```
[1] 入力 (issue 番号 or URL) を受け取る
      ↓
[2] gh で issue 本体 + 既存コメント + ラベルを取得
      ↓
[3] 既に planned が付いていないかチェック (ガード)
      ↓
[4] リポジトリを探索して関連ファイル・現状動作を把握
      ↓
[5] 計画 Markdown を作成
      ↓
[6] planned ラベルが無ければ作成 → issue に付与
      ↓
[7] 計画 Markdown を issue コメントとして投稿
      ↓
[8] 「次は実装フェーズ。branch を切って良いか？」とユーザーに確認して終了
```

---

## Step 1: 入力の正規化

ユーザーから受け取る入力は次のいずれかの形:

- 数値のみ: `123`
- `#123`
- 完全 URL: `https://github.com/<owner>/<repo>/issues/123`

いずれの場合も最終的に `<num>` (整数) に正規化して以降使う。URL なら数字部分を抜き出す。`gh` は現在のリポジトリを自動で見るので、`<owner>/<repo>` の指定は不要。

複数 issue を一度に渡された場合は、**1 件ずつ順番に** この skill のフローを回すこと。バッチ処理してはいけない (各 issue ごとに独立した調査・計画が要る)。

---

## Step 2: issue の取得

並列でまとめて取得して良い:

```bash
gh issue view <num> --json number,title,body,labels,state,author,comments,url
```

取得した内容を頭に入れる。特に注目するのは:

- `title` / `body` — 何が問題か / 何を作りたいか
- `labels` — `bug` / `enhancement` / `refactor` / `area:*` の組合せ
- `comments` — 議論の経緯。途中で要件がアップデートされていることが多い
- `state` — `closed` だったら原則 plan しない (ユーザーに確認)

---

## Step 3: 重複ガード (planned が既に付いているか)

`labels` の配列に `planned` が含まれていたら、いきなり計画を投稿してはいけない。

ユーザーに次の 3 択を確認する:

1. **既存計画が古いので上書き的に新しい計画を追記する** (推奨)
2. **既存計画で十分なので何もしない** (中断)
3. **既存計画コメントを編集する** (該当コメントの URL/ID を特定して `gh issue comment <id> --edit-last` 等で対応)

ユーザーが明示しない限り、勝手に既存コメントを削除・編集しない。**追記が安全側のデフォルト**。

---

## Step 4: リポジトリ探索

issue 本文だけでは実装計画は立てられない。必ず関連箇所のコードを読むこと。
範囲が広い・どこから手を付けるか不明なときは `Agent` (subagent_type: `Explore`) に任せると速い。

最低限の調査チェックリスト:

- [ ] issue で言及されているファイル / 機能名を Grep / Glob で実在確認
- [ ] 関連する Rust 側コマンド (`src-tauri/src/commands/`) と TS 側 (`src/renderer/`) の対応関係
- [ ] 触る予定のファイルが他のどこから参照されているか (影響範囲)
- [ ] 既存テスト (`*.test.ts` 等) があるか、無いなら追加すべきか
- [ ] 同じ領域で過去にどんな PR / commit があったか (`git log -- <path>`)

vibe-editor 固有の同期ポイント (5 点同期 / 4 層同期 / 2 ファイル同期) に該当する変更なら、必ず該当 skill (`tauri-ipc-commands` / `theme-customization` / `monaco-language-setup` / `canvas-nodecard-pattern` 等) の手順を **計画段階で参照** し、そのチェックリストを実装ステップに落とすこと。これを忘れると「実装中に skill を見ても遅い」状態になる。

---

## Step 5: 計画 Markdown を作る

以下のテンプレートを **そのままの見出し構成** で埋める。
ファイル化する場合は `tasks/issue-<num>/plan.md` を推奨 (リポジトリの慣例に合う) が、`gh issue comment --body-file` の入力にできれば一時ファイルでも OK。

```markdown
## 実装計画

### ゴール
<この issue を closed にする条件を 1〜3 行で。曖昧な「改善する」ではなく、
ユーザーから見て何が変わるか / どうなれば done かを書く>

### 影響範囲 / 触るファイル
- `path/to/file.ts` — どう変える
- `src-tauri/src/commands/foo.rs` — どう変える
- (新規追加するファイルは `(新規)` を末尾に)

### 実装ステップ
- [ ] Step 1: <最小の動く塊。まずここまでで commit できる粒度>
- [ ] Step 2: <次の塊>
- [ ] Step 3: ...
- [ ] (該当時) `tauri-ipc-commands` skill の 5 点同期チェック
- [ ] (該当時) `theme-customization` skill の 4 層同期チェック
- [ ] テスト追加 / 既存テスト更新

### 検証方法
- `npm run typecheck` が通る
- `npm run build` が通る (Tauri ビルドが必要なら明記)
- 手動テスト: <再現手順 / 期待する挙動>
- (該当時) `npm test` / vitest の対象テスト名

### リスク・代替案
- リスク: <壊れそうな箇所 / regression が出そうな機能>
- 代替案: <別アプローチがあれば 1 行で。なければ「特になし」>

### 想定 PR 構成
- branch: `<type>/issue-<num>-<short-slug>`
- commit 粒度: <1 commit で済むか / Step ごとに分けるか>
- PR title 案: `<type>(<scope>): <要約>`  (Conventional Commits)
- 本文に `Closes #<num>` を含める
```

埋めるときの原則:

- **過剰に詳細にしない**。シニアが見て「方針は分かる、あとは書ける」レベルで止める。コードのフルコピーや関数の完成形を計画に書かない (実装フェーズで書けば良い)
- **不確実な箇所は明記する**。「ここは実装してみないと分からない」「A 案 / B 案で迷っている」は隠さず書く。後で議論しやすい
- **vibe-editor の規約に反する計画にしない**: main 直 push 禁止 / branch 必須 / PR 経由 / Conventional Commits / ラベル付き Issue。これらが満たされる前提で書く

---

## Step 6: planned ラベルの付与

### 6-1. ラベルの存在確認

```bash
gh label list --json name --jq '.[] | select(.name=="planned")'
```

何も返ってこなかったら作成:

```bash
gh label create planned \
  --color BFD4F2 \
  --description "実装計画 (plan) を issue に記載済み"
```

色 `BFD4F2` は淡いブルー。既存の領域系ラベルとぶつかりにくい。

### 6-2. issue に付与

```bash
gh issue edit <num> --add-label planned
```

既に付いていた場合 (Step 3 で追記合意済みのケース) は no-op で OK。

---

## Step 7: 計画コメントを投稿

`gh issue comment` は `--body` に直接渡すと改行・引用符のエスケープで事故るので、**必ずファイル経由**:

```bash
gh issue comment <num> --body-file <plan-path>.md
```

投稿後、コメント URL を控えてユーザーに見せる:

```bash
gh issue view <num> --json comments --jq '.comments[-1].url'
```

---

## Step 8: 引き継ぎ

最後にユーザーへ次のアクションを 1 行で提示:

> 計画を issue #N にコメントしました (URL: ...)。実装フェーズに進む場合は branch `<type>/issue-N-<slug>` を切って `vibeeditor` skill のフローで進めます。続行しますか？

ここで **勝手に branch を切らない**。この skill のスコープは計画までで、実装は別フェーズ。ユーザーが Yes と言って初めて次に進む。

---

## やってはいけないこと (anti-patterns)

- ❌ 計画コメントを投稿せずに即 branch 切ってコードを書き始める (skill のゴールを逸脱)
- ❌ issue 本文を書き換える (`gh issue edit --body`) — 元の報告内容は保全する
- ❌ 既存の `planned` コメントを断りなく上書き / 削除する
- ❌ ラベルが無いからといって `planned` 以外のラベルまで勝手に整理する (ラベル管理は `label-and-issue-workflow` skill のスコープ)
- ❌ コードの完成形を計画に貼り付けて長大化させる (PR でやれば良い)
- ❌ closed issue に断りなく plan を投稿する

---

## 参考: 関連 skill

- `vibeeditor` — 実装フェーズに入ったら必ず参照
- `pullrequest` — 実装が済んだら PR → bot レビュー → merge まで持っていく
- `label-and-issue-workflow` — そもそも issue 起票時にラベルが付いていない場合
- `tauri-ipc-commands` / `theme-customization` / `monaco-language-setup` / `canvas-nodecard-pattern` / `pty-portable-debugging` — 計画段階で該当領域なら必ず読む
