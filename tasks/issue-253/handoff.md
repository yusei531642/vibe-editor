# 引き継ぎ書: Issue #253 fortress-implement

> **このスレッドはコンテキスト整理のため一度クリアします。新スレッドの Claude はこのファイルを最初に Read してください。**
> 作成日時: 2026-04-28 / ブランチ: `fix/issue-253-canvas-fit-unscaled`

---

## 1. 全体ストーリー

| 段階 | スキル | 結果 |
|------|--------|------|
| 1 | `/fortress-review` 起動 | Issue #253 のレビュー対象（計画/PR/diff）が無いと判明 |
| 2 | `/issue-planner` で計画 v1 を作成 | `tasks/issue-253/plan.md` 作成 → Issue にコメント投稿（`#issuecomment-4333433358`）+ `planned` ラベル付与 |
| 3 | `/fortress-review` Round 1 (3体並列) | **No-Go 判定**（CRITICAL=4, HIGH=16, MEDIUM=9, LOW=2） |
| 4 | **`/fortress-implement` 起動（現在進行中）** | Tier I2 (スコア 12) / 8 Slice 計画。S0/S1 完了、S2-S7 残 |

---

## 2. ユーザー情報

- ユーザー: zooyo（office@robbits.co.jp）
- 元々はリポジトリに **READ 権限のみ** だったが、途中で **WRITE (collaborator)** に昇格
- リポジトリ: `yusei531642/vibe-editor`（Tauri 2 + React 18 デスクトップアプリ）
- ローカル clone: `C:\Users\zooyo\Documents\GitHub\vibe-editor`
- OS: Windows 11、Bash (Git Bash)、Codex CLI 0.125.0 利用可能
- 重要: Codex CLI は Windows ConstrainedLanguage で shell tool エラーを出すが、`-c approval_policy='"never"' -c tools.shell.enabled=false --sandbox read-only` で read_file 系は動作する

---

## 3. Issue #253 の主因（確証済）

**症状**: Canvas モードでターミナル表示が大きく崩れる、Codex は使用不可。

**主因 P6 (PTY サイズ不整合)**: React Flow の親に `transform: scale(zoom)` がかかっており、`FitAddon.fit()` が `getBoundingClientRect()` 経由で transform 適用後の視覚矩形を読む → 過小/過大な cols/rows が `terminal_create` IPC 経由で PTY に渡る → Codex の TUI が PTY 報告サイズで描画して実 DOM とズレる。

- fortress-review Round 1 主因 A: confidence **94**
- 副因 E (refit が zoom 変化を拾わない): confidence **86**
- 副因 F (NODE_W/H 480x320 が窮屈): confidence **48**

詳細: `tasks/issue-253/s0-investigation.md`（コードパス全列挙 + P1〜P11 の判別）

---

## 4. ブランチ & コミット状況

```
ブランチ: fix/issue-253-canvas-fit-unscaled (未プッシュ、ローカルのみ)
SP-0:    2ed6484  fortress-implement: Slice S0 - 症状切り分け事前検証 [SP-0]
SP-1:    5867e4c  fortress-implement: Slice S1 - vitest テスト基盤導入 [SP-1]
HEAD →   5867e4c
```

ロールバック: `git reset --hard 2ed6484` (S0 まで戻す) / `git reset --hard origin/main` (全廃棄)

---

## 5. 完了済み Slice

### S0: 症状切り分け事前検証 (コード解析) — `2ed6484`
- 主因 P6 確証、副因 P8 (Codex CLI ConstrainedLanguage 即終了) は別 Issue 扱い
- attempts=2（FR-S0R-001/003/005 の HIGH 指摘を `RETRY_SAME` で吸収）
- 成果物: `tasks/issue-253/s0-investigation.md`

### S1: テスト基盤導入 (vitest) — `5867e4c`
- vitest 3.2.4 + jsdom + @testing-library/react + jest-dom
- `npm run test` → 3/3 PASS、`npm run typecheck` → 0 error
- 追加ファイル:
  - `vitest.config.ts`
  - `src/renderer/src/test-setup.ts` (ResizeObserver polyfill + jest-dom matchers)
  - `src/renderer/src/lib/__tests__/sample.test.ts`
  - `package.json` scripts に `test` / `test:watch` 追加
- attempts=1（インフラ追加のため Step C 軽量化、`self_healing_log` に scope_adjustment 記録）

---

## 6. 残 Slice（S2〜S7）— 詳細仕様

各 Slice は計画書 `tasks/issue-253/plan.md` の Step 1〜6 と対応。fortress-review Round 1 の19件指摘を全反映済み。

### S2: `measureCellSize` 純関数 (private API 排除) ★CRITICAL 対応
- 対応指摘: FR-CA-04 / FR-S1-003 / FR-S2-001 (CRITICAL)
- 場所: `src/renderer/src/lib/measure-cell-size.ts` (新規)
- 内容: xterm の private API `term._core._renderService.dimensions` ではなく **`canvas.getContext('2d').measureText('M')`** で cellW を、`fontSize * lineHeight` で cellH を算出する純関数を export
- 受入: jsdom unit test。fontSize=13, lineHeight=1.0 で cellW≈8、cellH=13 程度。HtmlCanvasElement は jsdom で利用可（ただし `canvas` パッケージ不要、jsdom の標準 mock で OK）
- 注意: jsdom の `canvas.getContext('2d')` は実際には null を返す可能性。fallback (`fontSize * 0.6`) が必要

### S3: `computeUnscaledGrid` 純関数 (境界値ガード) ★HIGH 対応
- 対応指摘: FR-CA-01 / FR-S1-005 / FR-S2-002 / FR-S2-009 (HIGH)
- 場所: `src/renderer/src/lib/compute-unscaled-grid.ts` (新規)
- 内容:
  ```ts
  export interface GridOptions { minCols?: number; minRows?: number; maxCols?: number; maxRows?: number; }
  export function computeUnscaledGrid(
    width: number,    // container.clientWidth (transform 非適用)
    height: number,   // container.clientHeight
    cellW: number,
    cellH: number,
    options: GridOptions = {}
  ): { cols: number; rows: number } | null {
    const { minCols = 20, minRows = 5, maxCols = 500, maxRows = 200 } = options;
    if (width <= 0 || height <= 0 || cellW <= 0 || cellH <= 0) return null;  // ゼロ除算ガード
    const rawCols = Math.floor(width / cellW);
    const rawRows = Math.floor(height / cellH);
    return {
      cols: Math.min(maxCols, Math.max(minCols, rawCols)),
      rows: Math.min(maxRows, Math.max(minRows, rawRows))
    };
  }
  ```
- 受入: 境界値テスト（width=0, max超過, 負値, 通常値）

### S4: `useFitToContainer` unscaled + 初回 spawn 統合 + zoom debounce ★CRITICAL 対応
- 対応指摘: FR-CA-01 / FR-CA-05 / FR-S1-006 / FR-S2-003 (CRITICAL+HIGH)
- 場所: 既存 `src/renderer/src/lib/use-fit-to-container.ts`、`src/renderer/src/lib/use-pty-session.ts`
- 内容:
  1. `useFitToContainer` に `unscaledFit?: boolean` と `getZoom?: () => number` オプション追加
  2. `refit()` で unscaled なら `computeUnscaledGrid(container.clientWidth, container.clientHeight, ...)` を使う
  3. `usePtySession` の **初回 spawn 経路** (`use-pty-session.ts:103-108` の `fit?.fit()`) も unscaled に対応させる（CRITICAL: ここを直さないと意味が無い）
  4. zoom 購読は `useStore.subscribe` + 量子化 (`Math.round(zoom * 100) / 100`) + 100ms debounce
- 受入: jsdom unit test（zoom 0.3/1.0/1.5 で同 cols/rows）+ refit 呼び出し回数の検証

### S5: TerminalView/Card 配線 + NodeResizer 連動 + fitView レース対応 ★HIGH 対応
- 対応指摘: FR-CA-03 / FR-CA-09 (HIGH)
- 場所: `src/renderer/src/components/TerminalView.tsx`、`src/renderer/src/components/canvas/cards/TerminalCard.tsx`、`AgentNodeCard.tsx`、`Canvas.tsx`
- 内容:
  1. `TerminalView` に `unscaledFit?: boolean`, `zoom?: number` props 追加
  2. `TerminalCard` / `AgentNodeCard` で `useStore((s) => s.transform[2])` (debounce 経由) で zoom 取得して props に渡す
  3. `AgentNodeCard.tsx:292-298` の `NodeResizer` の `minWidth/minHeight` を共有定数 `NODE_MIN_W / NODE_MIN_H` に置換
  4. `Canvas.tsx:324` の `fitView={nodes.length > 0}` のレース対策: `viewportReady` gate（fitView 完了を 1 frame 待ってから TerminalCard 群がマウント） or `fitView={false}` 化
- 受入: 既存 IDE モード regression なし（手動）+ unit test 可能なら

### S6: persist v3 migration + NODE_W/H 引き上げ + 重複定数共有 ★CRITICAL 対応
- 対応指摘: FR-CA-06 / FR-S1-007 / FR-S2-004 / FR-S2-007 / FR-S2-010 (CRITICAL)
- 場所: `src/renderer/src/stores/canvas.ts`、`src/renderer/src/lib/use-recruit-listener.ts`
- 内容:
  1. `canvas.ts` の `NODE_W: 480→640`, `NODE_H: 320→400` を `export` し、`use-recruit-listener.ts` から import
  2. `NODE_MIN_W = 480`, `NODE_MIN_H = 280` を export
  3. zustand persist の `version` を bump（現在の version+1）
  4. `migrate(persistedState, fromVersion)` 実装: 旧サイズ (width<=480, height<=320) のノードのみ width/height を新仕様に拡大、ユーザー手動拡大値は尊重
  5. `migrate` 関数の unit test
- 注意: persist の version 現状値を確認してから bump（grep `version` in canvas.ts）

### S7: 可観測性ログ + Playwright E2E ★HIGH 対応
- 対応指摘: FR-S2-008 / FR-S1-001 / FR-S1-012 / FR-S1-009 (HIGH)
- 場所:
  - 可観測性: `src/renderer/src/lib/use-fit-to-container.ts` で `console.debug('pty.resize', { cols, rows, zoom, source, cellW, cellH, fallback })`
  - Playwright: 既存に Playwright が無いので導入が必要 → ただし Tauri アプリの E2E は WebDriver 経由で複雑。**実機 Tauri (Windows) の手動チェックリスト** に縮退するのも選択肢
- 受入条件: `tasks/issue-253/s0-investigation.md` の「Phase 3 E2E で必須の実機検証項目」5項目

---

## 7. fortress-review Round 1 の19件指摘 → Slice 対応マトリクス

| # | ID | 深刻度 | 概要 | 対応 Slice |
|---|----|--------|------|-----------|
| 1 | FR-CA-04 / FR-S1-003 / FR-S2-001 | CRITICAL | xterm private API 依存 | **S2** |
| 2 | FR-CA-06 / FR-S1-007 / FR-S2-004,007,010 | CRITICAL | NODE_W/H が persist で既存ユーザーに効かない | **S6** |
| 3 | FR-CA-01 / FR-S1-006 | CRITICAL | 初回 spawn が useFitToContainer をバイパス | **S4** |
| 4 | FR-S1-011 | CRITICAL | Codex「使用不可」の意味解釈未確定 | **S0** ✅ |
| 5 | FR-CA-03 | HIGH | fitView × defaultViewport × spawn のレース | **S5** |
| 6 | FR-CA-02 | HIGH | vitest 未導入 | **S1** ✅ |
| 7 | FR-S1-001 / FR-S1-002 | HIGH | 受入基準が描画止まり、Codex 操作可能性まで | **S7** |
| 8 | FR-S1-005 / FR-S2-002 | HIGH | clientWidth=0 ゼロ除算ガード | **S3** |
| 9 | FR-CA-05 / FR-S2-003 | HIGH | useStore primitive selector で全カード再レンダー罠 | **S4** |
| 10 | FR-S2-008 | HIGH | 可観測性ログ無し | **S7** |
| 11-19 | (MEDIUM/LOW) | — | NodeResizer hardcode, テスト6観点漏れ, debounce戦略, 段階検証 等 | S2-S7 各所で吸収 |

---

## 8. 重要ファイル一覧（既読、再読不要）

| ファイル | 役割 |
|---------|------|
| `tasks/issue-253/plan.md` | 計画 v1（Issue にコメント投稿済み）|
| `tasks/issue-253/s0-investigation.md` | S0 調査レポート |
| `tasks/issue-253/handoff.md` | **このファイル** |
| `tasks/fortress-implement-state.json` | 状態ファイル（resume 用） |
| `src/renderer/src/lib/use-fit-to-container.ts` | 修正対象（S4） |
| `src/renderer/src/lib/use-xterm-instance.ts` | xterm Terminal 初期化（参考） |
| `src/renderer/src/lib/use-pty-session.ts` | 初回 spawn 経路（**未読**、S4 で要 Read） |
| `src/renderer/src/components/TerminalView.tsx` | 修正対象（S5） |
| `src/renderer/src/components/canvas/cards/TerminalCard.tsx` | 修正対象（S5） |
| `src/renderer/src/components/canvas/cards/AgentNodeCard.tsx` | 修正対象（S5、**未完全Read**、Issue #125 コメントの確認必要） |
| `src/renderer/src/components/canvas/Canvas.tsx` | fitView 設定（S5） |
| `src/renderer/src/stores/canvas.ts` | NODE_W/H + persist（S6） |
| `src/renderer/src/lib/use-recruit-listener.ts` | NODE_W/H 重複定数（S6、**未読**） |
| `src/types/shared.ts` | DEFAULT_SETTINGS |
| `src-tauri/src/commands/terminal.rs` | terminal_create IPC（参考） |
| `src-tauri/src/pty/session.rs` | spawn_session（参考） |

---

## 9. 新スレッド再開手順

```
1. このファイルを Read
2. tasks/fortress-implement-state.json を Read（current_slice=2、next_action="STEP_A for S2"）
3. Phase 2 Slice実行ループに従い S2 から再開:
   /fortress-implement resume
   または手動で:
   - Step A: S2 のテストを書く（src/renderer/src/lib/__tests__/measure-cell-size.test.ts）
   - Step B: src/renderer/src/lib/measure-cell-size.ts 実装
   - Step C: Tier I2 = 5体並列クロスチェック
   - Step D: npm run test, typecheck
   - Step E: Safe Point commit [SP-2]
4. S2 完了後 S3, S4, ... と順次進める
```

---

## 10. 既知の落とし穴・注意点

| 注意点 | 内容 |
|--------|------|
| **Codex CLI** | Windows ConstrainedLanguage で shell tool エラーを出すが、`-c tools.shell.enabled=false --sandbox read-only` + stdin プロンプトなら使える |
| **fortress-review** Round 1 出力 | 既に多数 CRITICAL を検出済。S2-S7 完了後に Round 2 もしくは sub-review で最終確認 |
| **Playwright** | 未導入。S7 で導入するか手動チェックに縮退するか判断必要 |
| **権限** | yusei531642/vibe-editor は zooyo がコラボレーター。push/PR 可能だが、 main ブランチへの直接 push は避ける |
| **Issue へのコメント** | 既に計画 v1 を投稿済み。実装完了時は別コメントで「PR #N で対応」を追加する想定 |
| **CLAUDE.md グローバル** | `friendly-mode` skill 適用、judgment-policy 参照、PowerShell `;` 連結等のルール存在 |
| **Tauri dev/build** | `npm run dev` = `cargo tauri dev`。実装中は `npm run dev:vite` (renderer のみ) でも検証可能 |

---

## 11. 関連リンク

- Issue: https://github.com/yusei531642/vibe-editor/issues/253
- 計画 v1 コメント: https://github.com/yusei531642/vibe-editor/issues/253#issuecomment-4333433358
- ブランチ: `fix/issue-253-canvas-fit-unscaled` (ローカルのみ、未プッシュ)

---

## 12. 完了基準（Phase 4 Go/No-Go）

- [x] S0: 症状切り分け（FR-S1-011 解消）
- [x] S1: テスト基盤導入（FR-CA-02 解消）
- [ ] S2: measureCellSize 純関数（FR-CA-04 / FR-S1-003 / FR-S2-001 解消）
- [ ] S3: computeUnscaledGrid 純関数（FR-S1-005 / FR-S2-002 / FR-S2-009 解消）
- [ ] S4: useFitToContainer + 初回 spawn 統合（FR-CA-01 / FR-S1-006 / FR-CA-05 解消）
- [ ] S5: TerminalView 配線 + fitView レース対応（FR-CA-03 / FR-CA-09 解消）
- [ ] S6: persist v3 migration + NODE_W/H 引き上げ（FR-CA-06 / FR-S1-007 / FR-S2-004,007,010 解消）
- [ ] S7: 可観測性 + E2E（FR-S2-008 / FR-S1-001 / FR-S1-012 解消）
- [ ] Phase 3 統合検証（lint/typecheck/test 全 PASS）
- [ ] 実機 Tauri (Windows) で zoom 0.5/1.0/1.5 の Codex 起動 + 入出力エコー確認
- [ ] PR 作成 → yusei531642 さんレビュー → マージ

完了時に Phase 4 証跡パックを `tasks/issue-253/evidence-pack.md` に出力する。
