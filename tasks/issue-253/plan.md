## 実装計画 / Implementation Plan
> この計画は自動生成されました（issue-planner + Codex CLI）

### 概要
- **Issue**: #253 キャンバスモードで起動するとターミナル内の表示が大きく崩れる
- **分類**: bug
- **工数見積**: M (2-8h)
- **優先度**: P1（Canvas 経由の Codex 利用がほぼ不可、Claude も罫線/レイアウト崩壊）
- **影響度**: 中（Canvas モード利用者全員、IDE モードは無影響）

<!-- issue-planner-meta
tier: B
tier_score: 7
tier_breakdown: data=0,auth=0,arch=0,scope=2,ops=5
reviewer_count: 3
review_completion_rate: 1/3
composite_grade: B
critical_open: 0
final_check: skip
grok_used: false
grok_status: skipped
grok_signals: none
grok_timeout_ms: 600000
-->

### 原因分析

Canvas モードのターミナルは `@xyflow/react` の親要素に `transform: scale(zoom)` がかかるため、子の `getBoundingClientRect()` は **transform 適用後の視覚矩形** を返す（CSS 仕様）。`xterm-addon-fit` の `FitAddon.fit()` はこの矩形からセル数を算出するため、zoom が 1.0 以外だと過小／過大な `cols/rows` が決まる。算出値はそのまま `terminal_create` IPC の `cols/rows` に渡り、PTY 側の `openpty(PtySize)` を確定する。Codex の TUI は PTY 報告サイズに従って描画するため、実 DOM とのズレでレイアウトが崩壊する。

ReactFlow の `fitView={nodes.length > 0}` （`Canvas.tsx:324`）は **起動直後のノード配置で auto fit-view を実行**し、ノード数に応じて zoom を 1.0 から動かす。`canvas store` の viewport は `persist` で永続化されているため、再起動でも zoom != 1 状態が復元される。これが「キャンバスモードで起動するとターミナル内の表示が大きく崩れる」の核心。

固定化要因として、`useFitToContainer` の refit トリガーは `ResizeObserver` / `visible` / `font/theme` のみで、**zoom 変化を拾う経路がない**（`use-fit-to-container.ts:84-108`）。React Flow の zoom は CSS transform であり ResizeObserver の content box 変更を伴わないため、ユーザーが起動後に zoom を戻しても fit が再走しない。

Codex CLI の独立調査でも主因仮説 A の confidence は 94、副因 E（refit 盲点）は 86 と評価され、コード根拠が完全一致した。

| 観点 | 内容 | 根拠 |
|------|------|------|
| 起動経路 | Canvas マウント直後に `usePtySession` が初回 `fit.fit()` → `term.cols/rows` を取得して `terminal_create` に渡す | `src/renderer/src/lib/use-pty-session.ts:102, 122`（要確認） |
| fit 計測 | `fit.fit()` は内部で `containerRef.getBoundingClientRect()` を読む。これは transform 適用後の値 | `src/renderer/src/lib/use-fit-to-container.ts:64-81` |
| zoom 変化 | React Flow の zoom は CSS transform。ResizeObserver は反応しない | `src/renderer/src/components/canvas/Canvas.tsx:322-327` |
| カード既定 | NODE_W=480, NODE_H=320。ヘッダー込みで Codex TUI の 80x24 を満たしにくい | `src/renderer/src/stores/canvas.ts:64-65, 133, 149` |

### 状態・表示ソース補足（bug時）
| 観点 | 内容 | 根拠 |
|------|------|------|
| 時間/状態ゲート | なし | — |
| 表示ソース | xterm 表示は CSS 寸法に従う一方、PTY 出力は `term.cols/rows`（fit 結果）に従う。両者が transform 込みで参照点が違う | `src/renderer/src/lib/use-fit-to-container.ts:69-77` |
| メタデータ境界 | renderer → IPC → Rust に渡る `cols/rows` は openpty の真実値になる。Canvas 側で transform を補正せずに送る | `src-tauri/src/commands/terminal.rs:306-405`, `src-tauri/src/pty/session.rs:287-292` |

### 影響範囲
| ファイル | 変更種別 | 複雑度 | 概要 |
|---------|---------|--------|------|
| `src/renderer/src/lib/use-fit-to-container.ts` | 修正 | 中 | unscaled fit ロジックの導入、zoom 変化検知の refit |
| `src/renderer/src/components/TerminalView.tsx` | 修正 | 低 | `disableWebgl` 同様に `unscaledFit` フラグを props で受け取り、`useFitToContainer` に渡す |
| `src/renderer/src/components/canvas/cards/TerminalCard.tsx` | 修正 | 低 | `<TerminalView ... unscaledFit />` を追加 |
| `src/renderer/src/components/canvas/cards/AgentNodeCard.tsx` | 修正 | 低 | 同上 |
| `src/renderer/src/components/canvas/Canvas.tsx` | 修正 | 低 | zoom 購読 hook を新設し、`useReactFlow` 経由で TerminalCard 群へ伝播（または React Context 経由） |
| `src/renderer/src/stores/canvas.ts` | 修正 | 低 | NODE_W / NODE_H の最小サイズ引き上げ（副因 F） |
| `src/renderer/src/lib/__tests__/use-fit-to-container.test.ts` (新規) | 追加 | 中 | zoom 0.3 / 1.0 / 1.5 で cols/rows が不変であることのテスト |

> 複雑度基準: 低=1ファイル小規模, 中=hook 拡張+他ファイル波及

### 依存関係
- 前提Issue: なし
- 外部依存: `@xyflow/react` の `useStore` / `useReactFlow` API（既存）

### 実装ステップ

#### Step 1: `useFitToContainer` に unscaled 経路を追加
- 対象: `src/renderer/src/lib/use-fit-to-container.ts` L1-L126
- 変更内容: `unscaledFit?: boolean` と `getZoom?: () => number` を options に追加。`refit()` 内で unscaled なら `containerRef.current.clientWidth / cellWidth` ベースで cols/rows を直接算出し、`term.resize(cols, rows)` を呼ぶ（FitAddon に委ねない）。`getZoom` が変化したら `refit()` を再走させる useEffect を追加。

<details><summary>Before/After</summary>

**Before:**
```ts
const refit = (): void => {
  const term = termRef.current;
  const fit = fitRef.current;
  if (!term || !fit) return;
  try {
    fit.fit();
    term.refresh(0, Math.max(0, term.rows - 1));
    if (ptyIdRef.current) {
      schedulePtyResize(term.cols, term.rows);
    }
  } catch {
    /* 非表示状態などでの失敗は無視 */
  }
};
```

**After:**
```ts
const refit = (): void => {
  const term = termRef.current;
  const fit = fitRef.current;
  const container = containerRef.current;
  if (!term || !fit || !container) return;
  try {
    if (unscaledFit) {
      // Canvas モード: transform: scale(zoom) を回避するため、論理 px (clientWidth)
      // ベースで cols/rows を算出する。getBoundingClientRect は transform 適用後の値を
      // 返すため使わない。cellWidth / cellHeight は xterm 内部から取得する。
      const dims = (term as unknown as { _core?: { _renderService?: { dimensions?: { actualCellWidth?: number; actualCellHeight?: number } } } })._core?._renderService?.dimensions;
      const cellW = dims?.actualCellWidth ?? 9;
      const cellH = dims?.actualCellHeight ?? 17;
      const cols = Math.max(20, Math.floor(container.clientWidth / cellW));
      const rows = Math.max(5, Math.floor(container.clientHeight / cellH));
      term.resize(cols, rows);
    } else {
      fit.fit();
    }
    term.refresh(0, Math.max(0, term.rows - 1));
    if (ptyIdRef.current) {
      schedulePtyResize(term.cols, term.rows);
    }
  } catch {
    /* 非表示状態などでの失敗は無視 */
  }
};
```
</details>

#### Step 2: zoom 変化を refit トリガーに追加
- 対象: `src/renderer/src/lib/use-fit-to-container.ts`（同ファイル）
- 変更内容: `refitTriggers` に `getZoom?.()` 由来の値を含める案、または独立した `useEffect(() => refit(), [zoom])` を追加。React Flow 側からは `useStore((s) => s.transform[2])` で zoom を取得して渡す。

#### Step 3: TerminalView に props を追加
- 対象: `src/renderer/src/components/TerminalView.tsx` L24-L60
- 変更内容: `unscaledFit?: boolean`, `zoom?: number` を追加し、`useFitToContainer` に転送。

#### Step 4: TerminalCard / AgentNodeCard で zoom を購読して伝播
- 対象: `src/renderer/src/components/canvas/cards/TerminalCard.tsx` L66-L90 と `AgentNodeCard.tsx`
- 変更内容: `import { useStore } from '@xyflow/react'` で `const zoom = useStore((s) => s.transform[2])` を取得し、`<TerminalView unscaledFit zoom={zoom} ... />` を渡す。

#### Step 5: カード既定/最小サイズの引き上げ（副因 F 対応）
- 対象: `src/renderer/src/stores/canvas.ts:64-65, 133, 149`
- 変更内容: `NODE_W = 480 → 640`、`NODE_H = 320 → 400` に引き上げる（Codex TUI の 80x24 + ヘッダー余裕を確保）。あるいは TerminalCard 側に `style.minWidth/minHeight` を強制。既存配置との互換性は zustand persist の値で保たれる（既存ノードは保存値が優先）。

#### Step 6: ユニットテスト追加
- 対象: `src/renderer/src/lib/__tests__/use-fit-to-container.test.ts`（新規）
- 変更内容: jsdom + ResizeObserver mock で `transform: scale(0.3 / 1.0 / 1.5)` 下で `unscaledFit=true` の cols/rows が不変であることを確認。

### リスク評価
| リスク | 確率 | 対策 |
|--------|------|------|
| `term._core._renderService.dimensions` に依存すると xterm.js のバージョン更新で破綻 | 中 | xterm 公式 API の `term.options.fontSize` から `measureText` で算出する公開経路に切替え可能なら優先 |
| zoom 変化のたびに PTY resize IPC が走り Codex/Claude 側で SIGWINCH 連発 | 中 | `schedulePtyResize` は既に 120ms debounce 済み。zoom 連続変化は debounce で吸収可能 |
| 既存ノードのサイズ変更でユーザー保存レイアウトが見た目崩れ | 低 | NODE_W/H 引き上げは新規追加カードのみに効く（zustand persist で既存値は保持） |
| IDE モードの動作に副作用 | 低 | `unscaledFit` は Canvas のカード経路のみ true。TerminalView の既存 IDE 利用は false のまま |

### エッジケース防御
| 防御項目 | チェック内容 | 対策パターン |
|---------|------------|------------|
| NaN/Infinity | `clientWidth / cellW` で cellW が 0 になるケース | `Math.max(1, cellW)` でガード |
| 0 の truthy | container が `display: none` 直後に clientWidth=0 | `container.clientWidth === 0` で fit をスキップ |
| zoom 範囲 | `minZoom=0.3, maxZoom=1.5`。極端な値での挙動 | jsdom テストで両端を検証 |

### テスト計画
- [ ] zoom=1.0 で起動 → Canvas TerminalCard のターミナルで Claude を起動 → 罫線崩れがないことを目視
- [ ] zoom=0.5 で起動（既存ノード多数） → 同上、Codex を起動して TUI レイアウトが破綻しないことを確認
- [ ] zoom=1.5 で起動 → 同上
- [ ] zoom スライダーを動的に変えても fit が追従すること（PTY resize ログを確認）
- [ ] IDE モードでの xterm 動作に regression が無いこと（既存 E2E 流用）
- [ ] ユニットテスト: `useFitToContainer` の unscaled 経路が transform に依存せず一定 cols/rows を返す

### テスタビリティ検討
- **`__testables` export 必要**: Yes — `useFitToContainer` の内部 `refit()` 相当ロジックを純関数として抽出し、container.clientWidth + cellWidth から cols/rows を計算する `computeUnscaledGrid(width, height, cellW, cellH)` を export
- **単位契約 JSDoc**: Yes — 入力は CSS px、出力は xterm セル数。負値・0・小数は `Math.max(20, ...)` などで境界クランプ

### 検証手順
1. ローカルで `npm run dev` 起動 → Canvas モードへ切替（Ctrl+Shift+M）
2. プリセットチームを起動して Codex 含む 4 カードを配置
3. 開発者ツールで Network タブから `terminal_create` IPC の cols/rows を確認
4. zoom スライダーを 0.3 → 1.0 → 1.5 に動かし、各タイミングで `terminal:resize` の cols/rows ログを取得
5. zoom != 1 でも cols/rows が論理 px ベースで一定であることを確認
6. 既存 IDE モードで Claude 起動 → 罫線・レイアウトに変化がないこと

### PR分割判断
- [ ] 高複雑度ファイルが2つ以上 → No
- [ ] 依存なしグループと依存ありグループ混在 → No
- [ ] 変更ファイル数が7以上 → No（6個）
- [ ] feat系で工数 M 以上 → No（bug fix）

**推奨**: 単一 PR。ただし副因 F（NODE_W/H 引き上げ）は別コミットで分離し、必要なら別 PR で切り出せるようにする。

### コード現状検証結果
| ファイル | 最終変更 | 計画前提との乖離 |
|---------|---------|-----------------|
| `src/renderer/src/lib/use-fit-to-container.ts` | 既存（最終 commit 不明、Issue #190 / #113 対応コメントあり） | なし |
| `src/renderer/src/lib/use-xterm-instance.ts` | `2269193 fix(terminal): Canvas DOM renderer の罫線描画にランタイム fallback を強制` (2026-04-27) | なし |
| `src/renderer/src/components/canvas/cards/TerminalCard.tsx` | 既存。`disableWebgl` を渡している | なし |
| `src/renderer/src/components/canvas/Canvas.tsx` | 既存。`fitView={nodes.length > 0}` / `minZoom=0.3` / `maxZoom=1.5` を確認 | なし |

### E2E受け入れ条件
**合格基準**: Canvas モードで `transform: scale(zoom)` の zoom 値に関わらず、起動した Claude/Codex の TUI レイアウトが破綻せず、Codex のスタートアップ画面が正しく描画される。

| # | 画面 | URL | 操作フロー | 期待結果 | 深度 | 優先度 |
|---|------|-----|-----------|---------|------|--------|
| 1 | Canvas | (Tauri) | プリセット起動 → 各カードで Codex/Claude が立ち上がる → ASCII ロゴ・プロンプト・罫線が崩れない | TUI レイアウトが破綻しない、入力プロンプトが正しい位置に表示 | L2 | high |
| 2 | Canvas | (Tauri) | zoom=0.3 で同上 | cols/rows が論理 px 基準で一定。Codex の welcome screen 完全表示 | L2 | high |
| 3 | Canvas | (Tauri) | zoom=1.5 で同上 | 同上 | L2 | medium |
| 4 | IDE | (Tauri) | IDE モードで Claude 起動 | 既存挙動に regression なし | L1 | high |

**前提条件**: claude / codex CLI がローカルに導入済み、`settings.codexCommand`='codex' / `claudeCommand`='claude'（DEFAULT_SETTINGS）。
**非テスト対象**: Codex 自体の TUI バグ、xterm.js DOM renderer の絵文字/Powerline glyph（副因 B）。

### ロールバック戦略
- **切り戻し方法**: `git revert <commit>`。`unscaledFit` props は Canvas 専用の opt-in なので、IDE モードへの影響なし。
- **DBスキーマ変更**: なし
- **影響レコード特定**: 該当なし（純粋なフロントエンド変更）

### 非対象（スコープ外）
- 副因 B: DOM renderer の customGlyphs 不在は既存 `ensureBoxDrawingFallbacks()` で部分対応済み。Powerline 等の追加 glyph は別 Issue で対応推奨。
- 副因 C: `which::which("codex")` 失敗時の os error 193 ハンドリング強化は別 Issue。
- Codex CLI 自体の Windows ConstrainedLanguageMode 問題（Codex CLI 側のバグ）

### 分割Issue提案
- なし（副因 B/C は既存 Issue 化されているか別途起票で対応）
