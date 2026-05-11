# 既存 open issue への補足コメント草案

新規 issue を起票後、各既存 issue にこのコメントを投稿する。`<NEW>` プレースホルダは起票後に置換。
新 issue 側の本文には `Closes #<既存>` を入れて、merge 時に既存も close されるようにする。

## #585 (背景縦線)

```
2026-05 の脆弱性・バグ調査で本問題の root cause を特定しました。

**根本原因**: `Canvas.tsx:76, 431` で `<Background color="var(--canvas-grid, #1c1c20)" />` のように **CSS 変数を SVG attribute に直接渡している**ため、ブラウザが `var(...)` を解釈できず fallback 固定色 `#1c1c20` で dot pattern を描いている (テーマ切替が効かない)。

修正は新規 issue #<NEW-B-1> で進めます (`tokens.css` に `--canvas-grid` 定義 + `.react-flow__background-pattern circle { fill: var(--canvas-grid); }` で SVG 側を classed targeting)。

詳細: `tasks/refactor-2026-05/plan.md` および `findings.md` (#Canvas 領域) を参照。
本 issue は #<NEW-B-1> 解決時に auto-close されます (PR 本文に `Closes #585` を含めるため)。
```

## #586 (HUD 表示変)

```
2026-05 の調査で HUD の挙動を 2 つの問題に分離しました。

1. **HUD ボタン縦書き化** (`Canvas.tsx`, `canvas.css:1109-1121`): 狭い画面で flex-shrink + word-break により日本語ラベルが 1 文字単位で折り返されています → 新 issue #<NEW-B-5>
2. **複数 team 集約 (dual preset 対応)** (`StageHud.tsx:187-227`): `aggregatedTeamId` が 1 team しか拾わないため `dual-claude-codex` 等の preset 使用時に片方の dead count が消えます → 新 issue #<NEW-B-6>

修正は両 issue で並行して進めます。本 issue は両方の merge 完了後に auto-close 予定。

詳細: `tasks/refactor-2026-05/findings.md` (#Canvas 領域)
```

## #591 (ワークスペース外せない)

```
2026-05 の調査で本問題の UI 欠落を確認しました。

**根本原因**: `FileTreePanel.tsx:303-334` で `roots` 配列の `isPrimary` 要素には `<button.filetree__root-remove>` が `{!isPrimary && (<button>)}` で抑止されており、プライマリプロジェクトを workspace から外す UI が存在しません。

修正は新規 issue #<NEW-B-8> で進めます (isPrimary でも remove ボタンを表示し、押したら別 root を primary に昇格する設計)。

詳細: `tasks/refactor-2026-05/findings.md` (#Canvas 領域)
本 issue は #<NEW-B-8> 解決時に auto-close されます。
```

## #593 (右クリックメニュー閉じれない)

```
2026-05 の調査で本問題の root cause を特定しました。

**根本原因**: `Canvas.tsx:279-291` の `handlePaneContextMenu` が `e.preventDefault()` だけ呼んで `e.stopPropagation()` を呼ばないため、React Flow の Pane で contextmenu が bubble し、ContextMenu mount 時の `mousedown` listener が「メニューを開いた瞬間の右クリックの mousedown」を「外クリック」として拾って即座に閉じる経路があります。

修正は新規 issue #<NEW-B-7> で進めます (`stopPropagation` 追加 + outside-click 判定を `mousedown` ではなく `click` に変更、または `useEffect` 内で `setTimeout(..., 0)` で listener 登録を 1 tick 遅らせる)。

詳細: `tasks/refactor-2026-05/findings.md` (#Canvas 領域)
本 issue は #<NEW-B-7> 解決時に auto-close されます。
```

## #592 (右クリックメニュー機能不足)

直接対応する finding はなく、UX 機能追加リクエストのため別 sprint で扱う。今回コメントなし、もしくは:

```
2026-05 の脆弱性・バグ調査スコープでは本 issue の機能追加は対象外でした (`tasks/refactor-2026-05/plan.md` Tier C+D の延長扱い)。
別途 enhancement sprint で扱う予定です。
```
