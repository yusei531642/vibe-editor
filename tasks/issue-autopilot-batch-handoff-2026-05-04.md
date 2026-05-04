# Issue Autopilot Batch 引き継ぎ書

作成日: 2026-05-04  
対象リポジトリ: `yusei531642/vibe-editor`  
ローカルパス: `C:\Users\zooyo\Documents\Codex\2026-05-04\https-github-com-yusei531642-vibe-editor-3`

## 計画

- `planned` ラベル付き Issue から、低リスクかつ関連性の高い Canvas/UI グループを先に実施する。
- 初回バッチは #457 / #453 / #441 の 3 件に限定する。
- `main` 直接 push / 手動 merge は行わず、feature branch -> PR -> reviewer / CodeRabbit 相当確認 -> 人間承認の流れを守る。
- 実装前計画は `tasks/todo.md` の「Issue Autopilot Batch: Canvas/UI 低リスクグループ計画（2026-05-04 / Codex）」に記録済み。

## Next Steps

- ユーザー確認後、`feature/issue-441-canvas-ui-batch` を作成する。
- #457 / #453 / #441 の実装とテストを行う。
- 実装後、この引き継ぎ書または `tasks/todo.md` に進捗・検証結果・残課題を追記する。

## 現在の状態

- リポジトリは指定フォルダへ clone 済み。
- 現在ブランチは `main`、`origin/main` と同期状態。
- 未コミット変更は `tasks/todo.md` の計画追記のみ。
- コード変更、ブランチ作成、Issue ラベル変更、PR 作成は未実施。
- `AGENTS.md`, `CLAUDE.md`, `.claude/skills/vibeeditor/SKILL.md`, `.claude/skills/pullrequest/SKILL.md`, issue-autopilot-batch skill を確認済み。

## planned Issue 一覧と判断

| Issue | 判断 | 理由 |
|---|---|---|
| #457 キャンバスモードの各ターミナルのヘッダー内コメントのフォントサイズがちいさすぎる | 初回対象 | Tier C。Canvas/UI/CSS 中心で低リスク。 |
| #453 Canvas モードで Ctrl+Shift+P を押してもコマンドパレットが開かない | 初回対象 | Tier C。CommandPalette の描画レイヤ修正で Canvas UI 検証にまとめられる。 |
| #441 キャンバスモードでサイズ統一ボタン、間隔ボタンが効かない | 初回対象 | Canvas HUD + store の小規模修正。#457/#453 と同じ画面で確認できる。 |
| #455 チーム起動カードが既存カードと重なる | 後続候補 | Tier C だが配置 helper / preset / restore / viewport focus まで影響し、初回3件より少し広い。 |
| #456 Codex-only チーム展開で HR が ClaudeCode になる | 後続 | Tier B。prompt / skill / schema 横断で #451 周辺差分との競合注意あり。 |
| #454 スタンドアロン Codex / Claude タブで MCP startup failed | 後続 | Tier B。backend / bridge / MCP startup の変更を含む。 |
| #451 team_send 成功後に worker が停止 | 除外 | `fortress-review-required` 付き。高リスク扱い。 |

## 実装メモ

### #457

- 主な候補:
  - `src/renderer/src/components/canvas/CardFrame.tsx`
  - `src/renderer/src/styles/components/canvas.css`
- 方針:
  - CardFrame header の inline style を CSS クラス化する。
  - header font を `var(--text-md)` 相当へ底上げする。
  - AgentNodeCard header / avatar / role / organization / status / status badge の可読性を改善する。
  - 長いタイトルは ellipsis で Close ボタンと衝突しないようにする。

### #453

- 主な候補:
  - `src/renderer/src/components/CommandPalette.tsx`
  - `src/renderer/src/styles/components/palette.css`
  - 必要に応じて `src/renderer/src/styles/tokens.css`
- 方針:
  - `CommandPalette` を `createPortal(..., document.body)` で body 直下に描画する。
  - `.cmdp-backdrop` に `position: fixed`, `inset: 0`, `display: flex`, `z-index: var(--z-palette)` を明示する。
  - `--z-palette` が `--z-canvas-root` より上であることを確認する。
  - Canvas 側に CommandPalette を複製しない。

### #441

- 主な候補:
  - `src/renderer/src/components/canvas/StageHud.tsx`
  - `src/renderer/src/stores/canvas.ts`
  - `src/renderer/src/lib/__tests__/canvas-arrange.test.ts`
  - `src/renderer/src/stores/__tests__/canvas-restore-normalize.test.ts`
- 方針:
  - `normalizeCanvasState()` の `arrangeGap` 正規化を `tight | normal | wide` に修正する。現在は `roomy` を許可して `wide` を落とす状態。
  - HUD の gap ボタン押下時に `setArrangeGap(g.id)` だけでなく `tidyTerminalCards(g.id)` も実行し、即時に見た目へ反映する。
  - サイズ統一は既存 `unifyTerminalCardSize()` の回帰テストで固定する。

## 推奨検証

- `npx vitest run src/renderer/src/lib/__tests__/canvas-arrange.test.ts src/renderer/src/stores/__tests__/canvas-restore-normalize.test.ts`
- CommandPalette portal のテストを追加した場合は、その対象テストも実行する。
- `npm run typecheck`
- `npm run build:vite`
- `git diff --check`
- UI 変更後は `npm run dev` で Tauri 実機確認する。

## UI 手動確認観点

- Canvas モードで TerminalCard / AgentNodeCard のヘッダーが読みやすい。
- Canvas ズーム 1.0 / 0.75 / 0.5 でタイトルやロール表示が破綻しない。
- Canvas モードで `Ctrl+Shift+P` を押すと CommandPalette が Canvas より前面に出る。
- IDE モードでも `Ctrl+Shift+P` が従来通り動く。
- CommandPalette は Escape / backdrop click / command 実行で閉じる。
- Canvas HUD の `tight / normal / wide` を押すたびに terminal / agent card の配置が即時に変わる。
- `arrangeGap: "wide"` が reload 後も維持される。

## 注意点

- `rg.exe` がこの環境で一度 `Access is denied` になった。検索は PowerShell `Get-ChildItem` / `Select-String` へ fallback 可能。
- `tasks/todo.md` には過去タスクが大量にあるため、今回の追記箇所だけを扱う。
- 既存 `tasks/refactor-handoff.md` は今回の作業とは別件。上書きしない。
- `.env*`、secret、既存未追跡ファイルは add しない。
- `main` へ直接 push しない。PR の手動 merge もしない。

## 進捗

- [x] `planned` Issue 7 件を確認。
- [x] 初回対象を #457 / #453 / #441 に絞った。
- [x] `tasks/todo.md` に実装前計画と Next Steps を追記。
- [x] 本引き継ぎ書を作成。
- [x] feature branch 作成: `feature/issue-441-canvas-ui-batch`。
- [x] 実装。
- [x] テスト / build / 差分確認。
- [ ] UI 確認。
- [ ] PR 作成。

## Next Tasks

- [x] `git status --short --branch` で未コミット変更を確認する。
- [x] `git switch -c feature/issue-441-canvas-ui-batch` で作業ブランチを作る。
- [x] #441 の store / HUD 修正とテスト追加から着手する。
- [x] #453 の portal / z-index 修正を行う。
- [x] #457 の Canvas header 可読性改善を行う。
- [x] 検証結果を `tasks/todo.md` とこの引き継ぎ書へ追記する。
- [ ] PR 作成前に差分対象を再確認し、`Closes #441`, `Closes #453`, `Closes #457` を PR 本文へ入れる。
- [ ] 通常の Tauri 起動環境で Canvas の手動 smoke を再実施する。

## 実装結果 (2026-05-04)

- #441: `normalizeCanvasState()` の `arrangeGap` 許可値を `tight | normal | wide` に修正し、legacy `roomy` は `normal` へ戻す回帰テストを追加。
- #441: Stage HUD の gap ボタン押下時に `setArrangeGap(g.id)` と `tidyTerminalCards(g.id)` を連動させ、押下直後に配置へ反映するよう修正。
- #453: CommandPalette を `document.body` 直下へ portal し、backdrop を fixed overlay 化。`--z-palette` を Canvas / context menu より上へ調整。
- #453: CommandPalette portal の軽量テストを追加。
- #457: Canvas の共通 `CardFrame` header を CSS クラス化し、Terminal / Agent header の文字サイズ・高さ・省略表示・ボタンサイズを底上げ。
- 追加対応: dev/browser/custom Tauri smoke で `getCurrentWindow()` が Tauri metadata 不在時に render を落とさないよう、WindowControls と window frame inset hook を安全化。

## 検証結果

- `npx vitest run src/renderer/src/lib/__tests__/canvas-arrange.test.ts src/renderer/src/stores/__tests__/canvas-restore-normalize.test.ts src/renderer/src/components/__tests__/CommandPalette.test.tsx`: PASS (3 files / 21 tests)
- `npm run typecheck`: PASS
- `npm run build:vite`: PASS。既存の chunk size / ineffective dynamic import warning は継続。
- `git diff --check`: PASS

## UI確認結果

- `npm run build:vite` 相当の production build は通過。
- Vite 直表示では Tauri IPC がないため、アプリ全体の操作 smoke には不適。今回 `getCurrentWindow()` 由来の render crash は安全化済み。
- 別 identifier の Tauri smoke は起動できたが、Tauri IPC injection が不完全で settings load が default へ落ちるため、#457/#453/#441 の完全な手動操作確認は未完了。
- 検証用 Vite / Tauri プロセスは停止済み。`C:\Users\zooyo\.vibe-editor\settings.json` は事前バックアップから復元済み。

## Next Tasks (更新)

- [ ] 通常の `npm run dev` または人間の確認用環境で Canvas を開き、Terminal / Agent header、CommandPalette、gap変更の手動 smoke を行う。
- [ ] PR を作成し、本文に自動検証 PASS と UI smoke 未完了理由を明記する。
- [ ] CodeRabbit / reviewer / 人間承認 / QA 合意なしに merge しない。
