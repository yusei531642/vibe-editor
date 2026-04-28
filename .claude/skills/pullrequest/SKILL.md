---
name: pullrequest
description: vibe-editor で PR を作成し、vibe-editor-reviewer (GitHub bot) からの自動レビュー → 指摘修正 → 再レビューのループを bot による自動 merge まで完走させる一連のワークフロー。ユーザーが「PR を作成」「プルリクエスト作成」「PR 出して」「pull request」「PR お願い」等を言ったとき、または既存 PR のレビューサイクルを回したいとき (「レビュー待つ」「指摘修正してまた送って」等) に必ずこの skill を使うこと。単純な `gh pr create` 一発で終わらせず、レビューが完了して merge されるまで責任を持って見届ける workflow。
---

# pullrequest

vibe-editor リポジトリの PR ライフサイクルを完走させる skill。
PR を出して終わりにせず、`vibe-editor-reviewer` bot からのレビューを受け、
指摘がなくなって自動 merge されるまでを 1 つのワークフローとして扱う。

## 全体フロー

```
[1] PR 作成
      ↓
[2] レビュー待ち (loop で polling)
      ↓
[3] レビュー取得
      ↓
   指摘あり ──→ [4] 修正 commit & push ──→ [2] へ戻る
      ↓ なし
[5] bot が auto-merge → 完了
```

各ステップを丁寧にやること。途中で止めて「PR 出しました」と報告するだけでは
この skill のゴール (merge 完了まで) を満たさない。

---

## Step 1: PR 作成

### 事前確認 (並列で実行)

- `git status` で未コミット変更がないか
- `git log main..HEAD --oneline` で含まれるコミットを把握
- `git diff main...HEAD --stat` で変更ファイルの俯瞰
- `gh pr list --head $(git branch --show-current)` で既に PR があるか

既に PR がある場合は新規作成せず、既存 PR の番号を控えて Step 2 へ。

### Title

短く、prefix 付き、70 文字以内。vibe-editor の慣例に合わせる:

| prefix    | 用途                          | 例                                                    |
|-----------|-------------------------------|-------------------------------------------------------|
| `feat`    | 新機能                        | `feat(canvas): ノード自動整列ボタンを追加`            |
| `fix`     | バグ修正                      | `fix(team_hub): team_send 宛先解決を case-insensitive 化` |
| `refactor`| 内部整理 (機能変更なし)       | `refactor(settings): モーダル UI を Linear 風に再設計`|
| `perf`    | パフォーマンス改善            | `perf(canvas): #196 onNodesChange を O(チームサイズ) 化` |
| `security`| セキュリティ修正 (issue 必須) | `security(csp): #185 connect-src から localhost を除外` |
| `a11y`    | アクセシビリティ              | `a11y(settings): #195 SettingsModal に focus trap を追加` |
| `docs`    | ドキュメント                  | `docs(readme): セットアップ手順を更新`                |

issue を解決する PR は title または body のどこかで `#<番号>` を引用すること。
複数 issue をまとめる場合は `fix: open issues #191-#197 の 7 件をバンドル修正` のような書き方が前例あり。

### Body

HEREDOC で渡す (ヒアドキュメントの終端 `EOF` は行頭から):

```bash
gh pr create --title "feat(scope): ..." --body "$(cat <<'EOF'
## Summary
- 何を変えたか (1-3 行の bullet)
- なぜ変えたか
- 関連 issue: #N

## Test plan
- [ ] 変更箇所の手動確認手順
- [ ] `npm run typecheck` 通過
- [ ] (該当時) `npm run dev` で動作確認

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

push がまだなら `-u` 付きで先に push:
```bash
git push -u origin $(git branch --show-current)
```

### 作成後

- 戻ってきた PR URL を控える
- PR 番号を変数化して以降の手順で使う: `PR=201` など

---

## Step 2: レビュー待ち (loop で polling)

`vibe-editor-reviewer` bot の挙動 (確認済み):

1. PR 作成直後に最初のコメント `👀 レビューに参加しました。コードを確認中ですので、少々お待ちください...` を投稿
2. 数分後に本レビュー `## 🤖 Claude Auto-Review` を投稿 (これが指摘本体)
3. 指摘事項に絵文字マーカー: 🔴 critical / 🟡 warning / 🔵 suggestion
4. 修正 push 後、再度同じ流れでレビューを返す

### 推奨: loop skill で 1 分間隔の polling

レビューは数分〜十数分かかるので、`loop` skill にポーリングを任せる。
1 回のチェックは軽い `gh` 呼び出しで済むので、1 分 (60 秒) 間隔で回す。

ループ起動例 (ユーザーに以下のコマンドを案内するか、自分で `Skill` から呼ぶ):

```
/loop 1m gh pr view <PR番号> --json comments --jq '[.comments[] | select(.author.login == "vibe-editor-reviewer") | {at: .createdAt, body: .body[:80]}] | sort_by(.at) | last'
```

### 何を待つか (見分け方)

- `body` が `👀 レビューに参加しました` で始まる → まだ待機。継続。
- `body` が `## 🤖 Claude Auto-Review` で始まる → **本レビュー到着**。loop を停止して Step 3 へ。
- 既存の本レビューより新しい `createdAt` の `## 🤖 Claude Auto-Review` を検出した場合も同様に Step 3 へ。

`createdAt` を必ず比較すること。古いレビューを再処理してしまう事故を防げる。

### loop が使えない / 短期で待てる場合

短時間 (5 分以内に終わる見込み) なら、`Bash` の `run_in_background` で polling スクリプトを回しても良い。
ただし context を圧迫するので、長丁場では loop の方が筋。

---

## Step 3: レビュー内容を取得して整理

```bash
gh pr view <PR番号> --json comments,reviews --jq '
  [.comments[], .reviews[]]
  | map(select(.author.login == "vibe-editor-reviewer"))
  | map(select(.body | startswith("## 🤖 Claude Auto-Review")))
  | sort_by(.createdAt // .submittedAt)
  | last
  | .body
'
```

最新の本レビュー本文を取り出して全文確認する。
inline comments (差分行への指摘) もある場合は別途取得:

```bash
gh api repos/{owner}/{repo}/pulls/<PR番号>/comments --jq '.[] | select(.user.login == "vibe-editor-reviewer") | {path, line, body: .body[:300]}'
```

### 指摘の優先度

- 🔴 **critical**: 必ず修正。merge ブロッカー扱い。
- 🟡 **warning**: 原則修正。納得できる理由があればコメントで反論しても OK。
- 🔵 **suggestion**: 文脈次第。改善になるなら取り込む、不要なら根拠を添えてスキップ。

修正方針に迷う指摘 (例: 大規模リファクタを要求してくる、本 PR のスコープ外) は
鵜呑みにせず、ユーザーに「この指摘はスコープ外に見えるが取り込みますか?」と確認する。

---

## Step 4: 修正 → commit → push

### 修正

該当ファイルを編集。指摘の **why** を理解してから直す
(同じパターンが他にもあれば横展開する判断も)。

### typecheck

push 前に最低限:
```bash
npm run typecheck
```
落ちたら直してから push。CI を赤くしてから気付くのは時間の無駄。

### Commit message

vibe-editor の慣例に厳密に従う。何回目のレビューかで序数を変える:

| レビュー回数 | 序数表現        | 例                                                       |
|--------------|-----------------|----------------------------------------------------------|
| 1 回目       | `auto-review`   | `refactor(settings): PR #199 auto-review 指摘 4 件を反映`|
| 2 回目       | `二次レビュー`  | `refactor(settings): PR #199 二次レビュー指摘 4 件を反映`|
| 3 回目       | `三次レビュー`  | `refactor: PR #200 三次レビュー指摘 3 件を反映`          |
| 4 回目以降   | `四次` `五次`...| `refactor: PR #N 四次レビュー指摘 N 件を反映`            |

scope は変更ファイルの主要領域 (settings / canvas / team_hub / etc)。
複数領域にまたがるなら scope なしでも可 (PR #200 の前例あり)。

```bash
git commit -m "$(cat <<'EOF'
refactor(scope): PR #N 二次レビュー指摘 N 件を反映

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git push
```

push したら **Step 2 に戻る**。bot は push 検知で自動的に再レビューを始める。

---

## Step 5: 完了判定 → 自動 merge

レビューに指摘がなくなった (`## 🤖 Claude Auto-Review` 本文に 🔴/🟡 マーカーが無い、
または「critical な問題は見当たりません」「LGTM」相当の文言) 場合、
bot が自動で merge する設定になっている。

### 確認

```bash
gh pr view <PR番号> --json state,mergedAt,mergeCommit
```

- `state: "MERGED"` かつ `mergedAt` に値あり → 完了。ユーザーに報告して終了。
- まだ open なら数分待って再確認 (auto-merge 設定の反映に少しラグがある)。

merge 後の片付け:
```bash
git checkout main && git pull
git branch -d <作業ブランチ>   # ローカル削除 (リモートは bot が消す or GitHub 設定次第)
```

---

## やってはいけないこと

- **指摘を見ずに「対応しました」と push する**: bot は本気でレビューする。形だけの修正は次のレビューで再指摘される。
- **`--no-verify` でフックスキップ**: ユーザー明示指示がない限り禁止。
- **force push (`--force` / `-f`)**: ユーザー明示指示がない限り禁止。レビュー履歴が壊れる。
- **レビュー来る前に勝手に修正 push**: `👀 レビューに参加しました` 直後に追加 push すると
  bot が古い HEAD を見たまま終わる場合がある。本レビュー到着まで触らない。
- **loop を放置して context を膨らませる**: 本レビュー到着を検知したら必ず loop を停止する。

---

## ユーザーとの対話

- PR 作成時、title と body の draft を見せて承認を取ってから `gh pr create` する。
  勝手に PR を作って公開状態にしない。
- 各レビューサイクルで指摘を要約して提示し、「この方針で修正します」と確認してから着手する。
  指摘 N 件をひとまとめにせず、1 件ずつ「これはこう直す」を見せると安心感がある。
- 何回目のレビューかは毎回明示する (例: 「3 回目のレビューが返ってきました。指摘 2 件です」)。
