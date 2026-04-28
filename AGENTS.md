# AGENTS.md — vibe-editor

このリポジトリで作業する AI エージェント (Claude Code / Codex / その他) 共通の運用規約。
プロジェクト固有のアーキテクチャ・コーディング規約は `CLAUDE.md` を参照すること。本ファイルは **行動ルール** に特化する。

---

## 0. 必須スキル

作業に着手する前に、以下の skill を必ずロード・参照すること。

| skill | 用途 |
|-------|------|
| **`vibeeditor`** | プロジェクト全体ガイド。アーキテクチャ / IPC / ディレクトリ / 頻出コマンド / Canvas / PTY / TeamHub / 設定永続化 等。**コードを読む・書く前に必ず起動する**。 |
| **`pullrequest`** | PR 作成 → bot 自動レビュー → 指摘修正ループ → 自動 merge までの workflow。PR を扱うときは必ずこれに従う。 |

skill を起動せずにコードを書き始めない。

---

## 1. 開発フロー (厳守)

### 1-1. 問題を見つけたら **まず Issue**
- 不具合・改善点・リファクタ候補を見つけても、**いきなり PR を作らない**。
- まず **GitHub Issue を作成** し、以下を記述する:
  - 何が問題か / どこで起きるか
  - 再現手順 (バグの場合)
  - 想定スコープ (1 PR で収まる粒度か、分割が必要か)
- Issue を作ってから初めてブランチを切り、修正 → PR 提出。
- PR 本文には `Closes #<issue番号>` を必ず含める。

### 1-2. Issue には必ずラベルを付ける
- **ラベル無しの Issue は作成禁止**。
- 種別ラベル (`bug` / `enhancement` / `refactor` / `docs` / `chore` 等) を最低 1 つ。
- 領域ラベル (`area:rust` / `area:renderer` / `area:canvas` / `area:terminal` / `area:ci` 等) を最低 1 つ。
- 既存ラベル一覧は `gh label list` で確認。該当が無ければユーザーに相談してからラベルを新設する。

### 1-3. `main` への直接 push は **絶対禁止**
- `git push origin main` / `git push --force origin main` 等、`main` を直接更新する操作は一切行わない。
- すべての変更は **feature branch → PR → bot による自動 merge** の経路を通す。
- 手動 merge も禁止 (`gh pr merge` を人間/エージェントが叩かない)。merge は **vibe-editor-reviewer bot** に任せる。

### 1-4. PR 提出後はレビューループを完走させる
PR を出したら投げっぱなしにせず、**merge されたことを確認するまでがタスク**。

1. PR を作成すると **vibe-editor-reviewer (GitHub bot)** が自動レビューする。
2. レビューコメントが来たら **すべて対応** (修正 / 反論コメント) → 同じブランチに push。
3. push すると bot が再レビューする。これを **指摘ゼロ → bot が auto-merge** するまで繰り返す。
4. 検知は手動 polling ではなく `loop` skill (または `/loop`) を使う:
   - 例: `/loop 3m` 等で `gh pr view <PR#> --json state,reviewDecision,comments,reviews` を周期的にチェックし、新規レビューが付いたら修正フェーズへ移る。
   - レビューが来ない間は idle、来たら差分を読んで修正コミットを push する。
5. PR の `state` が `MERGED` になったらループを停止し、ユーザーに完了報告する。

詳細手順・コマンド例は `pullrequest` skill に従うこと。

---

## 2. コミット / ブランチ規約

### 2-1. ブランチ名
`feat/<short-desc>` / `fix/<short-desc>` / `refactor/<short-desc>` / `docs/<short-desc>` / `chore/<short-desc>` の形式。

### 2-2. コミットメッセージは Conventional Commits 形式 (必須)
`<type>: <要約>` または `<type>(<scope>): <要約>` で書く。`<type>` は以下から選ぶ:

| type | 用途 | 例 |
|------|------|----|
| `feat:` | 新機能追加 | `feat(canvas): ノードのグループ化を追加` |
| `fix:` | バグ修正 | `fix(terminal): タブを閉じた際に PTY が残るバグを修正` |
| `refactor:` | 機能変更を伴わないリファクタ | `refactor(commands): files.rs を 2 ファイルに分割` |
| `docs:` | ドキュメントのみ | `docs: AGENTS.md を追加` |
| `chore:` | ビルド・依存・リリース等の雑務 | `chore(release): bump version to 1.4.5` |
| `test:` | テスト追加・修正 | `test(git): diff parser のテストを追加` |
| `ci:` | CI 設定変更 | `ci: rust toolchain input を設定` |
| `style:` | フォーマット・lint のみ | `style: rustfmt 適用` |
| `perf:` | パフォーマンス改善 | `perf(pty): batcher のフラッシュ間隔を調整` |

- 破壊的変更がある場合は `feat!:` / `fix!:` のように `!` を付け、本文に `BREAKING CHANGE:` を記載する。
- `<scope>` は `canvas` / `terminal` / `git` / `commands` / `pty` / `team_hub` / `mcp_config` / `renderer` / `settings` / `ci` / `release` 等、影響領域を簡潔に。
- 要約は 50 文字以内、命令形 or 体言止め。文末に句点は不要。
- 1 コミット = 1 論理変更。混ざったら分ける。

### 2-3. PR の粒度
1 Issue = 1 PR を基本。直交する複数 Issue を 1 PR にバンドルする場合は **1 commit / Issue** で分けて、PR 本文に `Closes #A`, `Closes #B` を列挙する。

---

## 3. 検証基準

PR を出す前に必ず通すこと:

- `npm run typecheck` がエラー無し
- 触った箇所の動作確認 (`npm run dev` で実機確認 / 該当機能の golden path + edge case)
- Rust 側を触った場合は `cargo check` (or build) が通ること
- 型定義 (`src/types/shared.ts`) を変更した場合は Rust 側 serde の整合も確認

---

## 4. やってはいけないこと

- ❌ Issue を作らずにいきなり PR
- ❌ ラベル無しで Issue 作成
- ❌ `main` への直接 push / force push
- ❌ 手動での `gh pr merge` (bot に任せる)
- ❌ PR を出したまま放置 (merge まで責任を持つ)
- ❌ `--no-verify` で hook をスキップ (ユーザーが明示的に許可した場合のみ)
- ❌ `vibeeditor` skill を起動せずにコードに手を入れる

---

## 5. 補足

- 言語: 応答・コミットメッセージ・Issue/PR 本文は **日本語** が基本 (技術用語は原語可)。
- 不明点があったらユーザーに確認する。勝手な拡張・リファクタはしない。
