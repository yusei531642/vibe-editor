# vive-editor リデザイン & リファクタリング計画

作成: planner / 2026-04-15
対象バージョン: v1.1.3 → v1.2.0 (想定)

## 0. 前提

### 0.1 参照資料

- `CLAUDE.md` — プロジェクト全体方針
- `tasks/refactor-plan.md` — Phase 1–6 完了済の既存リファクタ計画 (モーダル/Terminal 系)
- `tasks/refactor-app-analysis.md` — App.tsx の state/hook/グループ抽出マップ (11 ロジックグループ + 13 hook 案)
- `tasks/design-research.md` — **researcher 完成済** (claude.ai / Linear / Vercel の配色・タイポ・motion・コンポーネントパターン)。本計画 §A のトークン具体値はこの資料の §1 (color) / §4 (motion) / §5 (component pattern) / §6 (shadow) を参照

### 0.2 計画の基本原則

- **機能追加は行わない**。挙動互換を担保した「見た目刷新 + 内部整理」。
- TypeScript strict / CSS 変数テーマ / preload IPC 境界は維持。
- 1 担当 = 1 PR 単位で独立して typecheck / `npm run dev` が通る粒度に切る。
- programmer-2 (App.tsx 分割) と programmer-3 (CSS/IPC 整理) は **既存動作を破壊しないインクリメンタル移行** を最優先。
- programmer-0 (UI Shell) と programmer-1 (UI Component) は **トークン層 (programmer-0 担当) が先** に固まってから動く直列依存あり。

### 0.3 現状サマリ (2026-04-15 時点)

| ファイル | 行数 | 問題 |
|---|---|---|
| `src/renderer/src/App.tsx` | **2137** | 11 ロジックグループ同居、hook 抽出未着手 |
| `src/renderer/src/index.css` | **4063** | 40+ セクションが 1 ファイル同居 |
| `src/renderer/src/lib/themes.ts` | 200 | パレット + Monaco テーマ + applyTheme/applyDensity が同居 |
| `src/main/ipc/*.ts` (8 ファイル) | 1075 | 命名規約/エラーハンドリング統一・共有型 (ipc.ts) 未整備 |

既存 refactor-plan.md の Phase 1–6 で **TerminalView / TeamCreateModal / SettingsModal / main lib 抽出** は完了しているため、本計画はその残件 (App.tsx + CSS + IPC 整理) と **デザイン刷新** を 4 人の programmer に並列展開する。

---

## A. UI 刷新プラン

**ゴール**: claude.ai / Linear / Vercel 風の静謐で密度の高い UI に刷新する。光の扱い・余白のリズム・motion のキレを 3 社のベストから採り、既存の Claude コーラルアクセントを軸に据える。

配色/タイポ/motion のトークン値は `tasks/design-research.md` (researcher 提供予定) を正とする。本計画では **どこを触るか** だけ定義し、具体値は research 側に委ねる。

### A-0. 共通ガイド (両担当が遵守)

- `src/renderer/src/lib/themes.ts` の `ThemeVars` は programmer-0 が拡張する。programmer-1 はその公開トークン (`--surface-*`, `--text-*`, `--motion-*` 等) のみを参照し、新規 CSS 変数を勝手に生やさない。
- すべての motion は `use-animated-mount.ts` 経由で `data-state='open'|'closed'` を制御する。`transition` は CSS 側に書き、React 側は state だけ持つ。
- `lucide-react` のアイコンセットを維持 (差し替えしない)。
- コンポーネントの Props は **現状 App.tsx から渡されている shape を崩さない**。内部実装と style のみ差し替え。

#### A-0-a. 共通 motion トークン (design-research §4 を `tokens.css` に転写)

```css
/* duration (research §4.1) */
--dur-instant: 120ms;   /* hover bg / toggle */
--dur-fast:    180ms;   /* button press, fade */
--dur-base:    240ms;   /* menu, tab switch, modal enter */
--dur-slow:    320ms;   /* popover, tooltip, toast */
--dur-slower:  500ms;   /* page transition */
--dur-ambient: 800ms;   /* hero fade */

/* easing (research §4.2) */
--ease-out-expo:   cubic-bezier(0.16, 1, 0.3, 1);      /* 主力。enter, tab, modal */
--ease-standard:   cubic-bezier(0.4, 0, 0.2, 1);       /* focus ring, press */
--ease-out-quart:  cubic-bezier(0.25, 1, 0.5, 1);      /* fade, hover color */
--ease-in-quart:   cubic-bezier(0.5, 0, 0.75, 0);      /* exit */
--ease-gentle:     cubic-bezier(0.33, 1, 0.68, 1);     /* claude ambient */
--ease-fade:       cubic-bezier(0.4, 0.14, 0.3, 1);    /* vercel fade */
--ease-spring:     cubic-bezier(0.34, 1.26, 0.64, 1);  /* hover lift, button press */
```

#### A-0-b. `use-animated-mount.ts` の 3 プリセット (programmer-1 が実装)

design-research §4.3 の state × プロパティ表を 3 つの合成フックに固定する。どのモーダル/オーバーレイも以下のいずれかを使う。

| プリセット | 入場 | 退場 | 想定コンポーネント |
|---|---|---|---|
| **`useFadeMount`** | `opacity 0→1`, `--dur-fast` (180ms), `--ease-out-quart` | `opacity 1→0`, 160ms, `--ease-in-quart` | Toast fade, backdrop, tooltip |
| **`useScaleMount`** | `opacity 0→1` + `transform: translateY(16px) scale(0.98)→0 scale(1)`, `--dur-base` (240ms), `--ease-out-expo` | 逆、160ms, `--ease-in-quart` | Modal, CommandPalette, SettingsModal |
| **`useSpringMount`** | `opacity 0→1` + `transform: scale(0.96)→scale(1)`, `--dur-fast` (180ms), `--ease-spring` | `opacity 1→0` + `scale(1)→(0.98)`, 120ms, `--ease-standard` | ContextMenu, PopoverMenu, UserMenu, AppMenu, TabCreateMenu |

実装規約: 各フックは `{ mounted, dataState: 'idle'|'opening'|'open'|'closing'|'closed' }` を返す。CSS 側は `[data-state='open']` / `[data-state='closing']` で transition を分岐。`prefers-reduced-motion: reduce` 時は全て `--dur-fast` の opacity のみに退化。

---

### A-1. programmer-0 — UI Shell 担当

**スコープ**: アプリの骨格 (Shell) と視覚トークンの再定義。Sidebar / Toolbar / TabBar / レイアウト / themes。

#### Before → After

| 対象 | Before (現在の課題) | After (目指す状態) |
|---|---|---|
| `lib/themes.ts` | パレット・Monaco テーマ・applyTheme が同ファイル、トークンの層が浅い (`bg`/`border`/`accent` のみ) | 4 層トークン (palette → semantic → component → theme) に再構築、design-research §1.1–1.3 の値をそのまま転写 |
| `index.css` トークン層 (L1–116) | `:root` に 80+ の変数が一気に並ぶ | `styles/tokens.css` に分離、**surface / content / accent / feedback / motion / radius / shadow** の 7 カテゴリに整列 |
| `Sidebar.tsx` (157 行) | 左帯の情報密度が固定、active は背景色だけのラジオ風 | **design-research §5.1 の (B) Linear 方式を採用** = `box-shadow: inset 2px 0 0 var(--accent)` + `background: rgba(255,255,255,0.04)`。border-left と違いレイアウトを動かさない。切替 switcher は pill 化、UserMenu を縦フレックス底部に固定 |
| `Toolbar.tsx` (62 行) | 38px の薄帯、ボタンの視覚的重量がバラバラ | design-research §5.2 の "glass header" = `backdrop-filter: saturate(180%) blur(12px)` (Linear), `background: rgba(var(--bg-rgb), 0.72)`, `border-bottom: 1px solid var(--border)`。path breadcrumb は serif 系へ |
| `TabBar.tsx` (97 行) | フラットな箱、dirty/pin のバッジが小さい | active タブは `border-radius: var(--radius-sm)` (6px) + `border: 1px solid var(--border)` + **ボトム 1px `var(--accent)` bar** を `--ease-spring` で fade-in、dirty dot は `lucide-react Circle` で左 12px に集約 |
| レイアウト CSS (`.layout` / `.main` / `.resize-handle`) | `.layout` が grid 固定、サイドバー幅が CSS 変数化されていない | `--shell-sidebar-w: 248px` (design-research §3.2 Linear 値) / `--shell-sidebar-collapsed: 56px` / `--shell-panel-w`、`--toolbar-h: 40px` (Linear)。`.layout` は 3 カラム grid + motion reducer 対応 |

#### 変更対象ファイル

- `src/renderer/src/lib/themes.ts` (200 → ~120 行、Monaco テーマは programmer-3 が `monaco-themes.ts` に分離)
- `src/renderer/src/index.css` のトークン層 (L1–116) と L214–596 のレイアウト/サイドバー部
- `src/renderer/src/components/Sidebar.tsx`
- `src/renderer/src/components/Toolbar.tsx`
- `src/renderer/src/components/TabBar.tsx`
- programmer-3 が分離する `styles/tokens.css` / `styles/layout.css` / `styles/components/sidebar.css` / `styles/components/toolbar.css` / `styles/components/tabbar.css` (Phase 1 で先に programmer-3 が箱を作る — C 節参照)

#### 参照する design-research トークン

**カラー (design-research §1)** — `themes.ts` に転写する具体値:

- **claude-dark**: `--bg #141413` / `--bg-panel #1F1E1D` / `--bg-elev #2A2826` / `--bg-hover rgba(241,239,232,0.05)` / `--bg-active rgba(216,90,48,0.14)` / `--border rgba(241,239,232,0.08)` / `--border-strong rgba(241,239,232,0.14)` / `--fg #F1EFE8` / `--fg-muted #A8A69C` / `--fg-subtle #6F6D64` / `--accent #D97757` / `--accent-hover #E88A6A` (研究 §1.1 dark)
- **claude-light**: `--bg #F5F4ED` / `--bg-panel #FAF9F2` / `--bg-elev #FFFFFF` / `--bg-hover rgba(67,51,34,0.05)` / `--bg-active rgba(201,100,66,0.12)` / `--border #E8E3D4` / `--fg #141413` / `--fg-muted #6B6A63` / `--accent #C96442` / `--accent-hover #B5583A` / `--accent-tint rgba(201,100,66,0.10)` (研究 §1.1 light)
- **midnight (Linear flavor)**: `--bg #08090A` / `--bg-app #0B0D12` / `--bg-panel #101216` / `--bg-elev-1 #16181D` / `--bg-elev-2 #1C1E24` / `--bg-hover rgba(255,255,255,0.04)` / `--bg-active rgba(94,106,210,0.12)` / `--border rgba(255,255,255,0.06)` / `--fg #F7F8F8` / `--fg-muted #8A8F98` / `--accent #5E6AD2` (研究 §1.2)
- **dark (warm-neutral)**: claude-dark のトークンをベースに `--accent` のみ `#D97757` を維持 (既存互換)
- **light (Vercel flavor)**: `--bg #FFFFFF` / `--bg-panel #FAFAFA` / `--border rgba(0,0,0,0.08)` / `--border-strong rgba(0,0,0,0.14)` / `--fg #000` / `--fg-muted #666` / `--accent #0070F3` (研究 §1.3 Vercel semantic)
- **全テーマ共通の feedback**: `--accent-success #00AC47 / #0ECB81` / `--accent-warning #F5A623 / #F7B955` / `--accent-error #EE0000 / #FF4C4C` (研究 §1.3)

**レイアウト (design-research §3.2)**:

- `--shell-sidebar-w: 248px` / `--shell-sidebar-collapsed: 56px`
- `--toolbar-h: 40px`
- `--row-h: 32px` (compact) / `36px` (normal) / `44px` (comfortable)
- `--radius-xs: 4px` / `--radius-sm: 6px` / `--radius-md: 8px` / `--radius-lg: 10px` / `--radius-xl: 14px` / `--radius-2xl: 20px` / `--radius-pill: 9999px`

**影 (design-research §6)** — `shadow-xs` から `shadow-popover` まで全 7 段階の layered shadow を転写。ダークテーマは必ず `inset 0 1px 0 rgba(255,255,255,0.04~0.06)` の highlight を含める。

#### 実装タスク (チェックリスト)

- [ ] `ThemeVars` を 4 層構造に再設計: `palette` (raw hex) / `semantic` (`--bg` 等) / `component` (override) / `theme` (dark/light flavor)
- [ ] 上記「参照する design-research トークン」の値を `themes.ts` の 5 テーマに転写 (claude-dark / claude-light / midnight / dark / light)
- [ ] Claude の warm-neutral 原則を守る: 全グレーに黄〜褐色 2〜4 chroma (research §1.1 鉄則)。`#737373` ではなく `#7B7970` 系に
- [ ] `applyTheme()` を `applyPalette()` + `applyComponentVars()` の 2 段に分割
- [ ] `styles/tokens.css` の骨子を定義: surface / content / accent / feedback / radius / shadow / motion / typography の 8 セクション
- [ ] border の alpha を `0.06〜0.08` に統一 (research §1.2 Linear 鉄則 / §1.3 Vercel 鉄則)
- [ ] `Sidebar` active 状態を **design-research §5.1 (B) Linear 方式** で実装: `box-shadow: inset 2px 0 0 var(--accent); background: rgba(255,255,255,0.04);`。hover は `.sidebar-item:hover { background: var(--bg-hover); }`、press は `transform: scale(0.985)`
- [ ] `Sidebar` の 4 ブロック縦フレックス: ヘッダ (app menu, 40px) → segmented switcher (pill) → section スクロール → UserMenu 底固定
- [ ] `Toolbar` を glass header 化: `backdrop-filter: saturate(180%) blur(12px)` + `background: rgba(var(--bg-rgb), 0.72)` + `border-bottom: 1px solid var(--border)`、スクロール時は alpha を 0.85 に上げる (research §5.2)
- [ ] path breadcrumb を `--heading-font` (Claude テーマ時 serif) に揃える
- [ ] `TabBar` の active タブを `border-radius: var(--radius-sm)` (6px) + `border: 1px solid var(--border)` でカード化、**下端 1px `var(--accent)` bar** を `opacity 0→1 + scaleX(0.6→1)`, 180ms `--ease-spring` で fade-in
- [ ] dirty/pin バッジを `lucide-react` の `Circle` (dirty) / `Pin` (pinned) に統一、12px 左寄せ
- [ ] `.layout` grid を `minmax(56px, var(--shell-sidebar-w)) 1fr minmax(320px, var(--shell-panel-w))` に変更
- [ ] `--shell-sidebar-w` を settings に永続化 (programmer-3 の IPC 整理と連動)
- [ ] `@media (prefers-reduced-motion: reduce)` 時は spring → `--ease-out-quart`、duration は全て `--dur-fast` に退化
- [ ] `transition: all` を全廃し、プロパティを明示列挙する (research §4.3 鉄則)

#### 依存関係

- **外部依存**: `tasks/design-research.md` の配色/タイポ/motion トークン値
- **下流依存**: programmer-1 は本担当の新トークン (`--surface-*`, `--elev-*`, `--motion-*`) を参照する。**programmer-0 の Phase 1 完了後に programmer-1 が着手**
- **横依存**: programmer-3 と「どのファイルが `styles/components/*.css` のオーナーか」を事前合意 (programmer-3 が分割、programmer-0 が中身書き換え)

---

### A-2. programmer-1 — UI Component 担当

**スコープ**: ポップアップ/モーダル/オーバーレイ系のコンポーネント磨き込みと motion ユーティリティ拡張。

#### Before → After

| 対象 | Before | After |
|---|---|---|
| `CommandPalette.tsx` (135 行) | 中央モーダル、セクション区切り無し、ファジースコア表示なし | Raycast/Linear 風の上寄せモーダル、カテゴリ見出し + キーヒント + 最近実行、active 行の subtle glow |
| `SettingsModal.tsx` (137 行) + `settings/*.tsx` (7 コンポーネント) | セクションが縦に並ぶだけ | 左ナビ (settings tabs) + 右パネル の 2 カラム、設定変更の "dirty" 表示 |
| `WelcomePane.tsx` (36 行) | テキストだけ、アクション誘導が弱い | Linear 風 "get started" カード: Open Folder / Recent / New Team の 3 アクションをカード化、薄い背景 illustration |
| `UserMenu.tsx` (283 行) | ドロップダウンだが密度が高い | claude.ai 右上風、ユーザーアイコン → Settings/Theme/Language/Version の 4 区画、ヘアライン区切り |
| `AppMenu.tsx` (163 行) | ハンバーガードロップダウン、Sidebar と Toolbar の両方から開く | 単一の実装で reuse できる `<PopoverMenu>` パターンに整理、位置合わせを `anchorRef` で自動化 |
| `ContextMenu.tsx` (92 行) | 素朴な box-shadow | `--shadow-popover` 適用、motion-scale-in + subtle blur background |
| Toast (`toast-context.tsx` 経由) | 右下に縦スタック、motion が直線 | Vercel 風 top-center stack, spring enter / ease-out exit, hover で pause |
| `use-animated-mount.ts` | mount/unmount の 2 相 | **3 相拡張**: `idle` → `opening` → `open` → `closing` → `closed`, `data-state` 属性を付与する util (`useDataState(open)`) を追加 |

#### 変更対象ファイル

- `src/renderer/src/components/CommandPalette.tsx`
- `src/renderer/src/components/SettingsModal.tsx` + `src/renderer/src/components/settings/` (6 セクション)
- `src/renderer/src/components/WelcomePane.tsx`
- `src/renderer/src/components/UserMenu.tsx`
- `src/renderer/src/components/AppMenu.tsx`
- `src/renderer/src/components/ContextMenu.tsx`
- `src/renderer/src/lib/toast-context.tsx` (UI 側だけ、API は維持)
- `src/renderer/src/lib/use-animated-mount.ts` (拡張)
- programmer-3 が分離する `styles/components/{palette,modal,menu,toast}.css`

#### 実装タスク (チェックリスト)

- [ ] `use-animated-mount.ts` に `useDataState()` ヘルパを追加 (3 相 state machine)
- [ ] `<PopoverMenu>` 共通コンポーネントを `components/primitives/PopoverMenu.tsx` に新設 (AppMenu / UserMenu / ContextMenu / tab-create-menu の共通基底)
- [ ] `CommandPalette` のセクション化: Recent / Project / Tabs / Terminal / Settings の 5 カテゴリ、キーヒント (`⌘K` 等) を右寄せ表示
- [ ] コマンドパレットのファジー検索スコアを可視化 (小さい % バー or 単純な matched-char 強調)
- [ ] `SettingsModal` を 2 カラムレイアウトに変更: 左ナビ (8 セクション縦並び) + 右コンテンツ
- [ ] `SettingsModal` に "unsaved" バッジを追加 (`draft !== applied` の diff)
- [ ] `WelcomePane` を "3 カード + keyboard hints" のヒーロー構成に変更
- [ ] `UserMenu` を claude.ai 風 4 区画に再構築 (Account / Theme / Language / Version)
- [ ] `AppMenu` を `PopoverMenu` ベースに書き換え
- [ ] `ContextMenu` のアニメーションを `scale(0.96) → scale(1)` spring に変更、ホバー時 row highlight
- [ ] Toast を top-center、3 件まで積む、hover pause、spring enter
- [ ] `motion.css` の keyframes/util (`@keyframes scale-in`, `@keyframes slide-down`, `.motion-fade-up` 等) を programmer-3 と合意して書き出す

#### 依存関係

- **上流**: programmer-0 の Phase 1 (トークン層) 完了後に着手。`--surface-*`, `--elev-*`, `--motion-*` を参照する
- **下流**: なし (UI 末端)
- **横依存**: programmer-3 の CSS 分割と命名衝突を回避するため、新規 `.css` ファイル名は事前合意

---

## B. リファクタリングプラン

**ゴール**: App.tsx 2137 行 → 500 行以下、index.css 4063 行 → 単一 100 行以下、IPC に共有型と命名規約を導入する。

### B-1. programmer-2 — App.tsx 分割担当

**スコープ**: `src/renderer/src/App.tsx` を custom hooks と子コンポーネントに分割する。既存の `tasks/refactor-app-analysis.md` の抽出マップを実装に落とし込む。

#### 抽出する hook (13 個)

下表の public API は **実装開始前に型ファイルを先に書く** ことで依存を固定する。

| hook | 配置 | 主な state | public API (返り値の型) |
|---|---|---|---|
| `useProjectLoader` | `lib/hooks/use-project-loader.ts` | `projectRoot`, `status` | `{ projectRoot, status, loadProject, handleNewProject, handleOpenFolder, handleOpenFile, handleOpenRecent, handleClearRecent, handleRestart }` |
| `useGitStatus` | `lib/hooks/use-git-status.ts` | `gitStatus`, `gitLoading` | `{ gitStatus, gitLoading, refreshGit, setGitStatus }` |
| `useSessions` | `lib/hooks/use-sessions.ts` | `sessions`, `sessionsLoading`, `activeSessionId` | `{ sessions, sessionsLoading, activeSessionId, refreshSessions, handleResumeSession }` |
| `useTeamHistory` | `lib/hooks/use-team-history.ts` | `teamHistoryEntries` | `{ entries, refresh, save, delete: handleDelete, updateMemberSessionId }` |
| `useDiffEditorTabs` | `lib/hooks/use-diff-editor-tabs.ts` | `activeTabId`, `diffTabs`, `editorTabs`, `recentlyClosed`, `sideBySide` | `{ activeTabId, diffTabs, editorTabs, tabs, activeDiffTab, activeEditorTab, activeFilePath, hasActiveContent, dirtyEditorTabs, sideBySide, setSideBySide, openDiffTab, refreshDiffTabsForPath, openEditorTab, updateEditorContent, saveEditorTab, closeTab, togglePin, reopenLastClosed, cycleTab, confirmDiscardEditorTabs, resetForProjectChange }` |
| `useTerminalTabs` | `lib/hooks/use-terminal-tabs.ts` | `terminalTabs`, `activeTerminalTabId`, `dragTabId`, `dragOverTabId` + refs | `{ terminalTabs, activeTerminalTabId, setActiveTerminalTabId, activeTab, addTerminalTab, closeTerminalTab, doCloseTab, restartTerminalTab, restartTerminal, getTerminalArgs, getTerminalEnv, getRolePrompt, terminalRefs, dragTabId, dragOverTabId, setDragTabId, setDragOverTabId, reorderTabs, clearSpawnTimers, resetForProjectChange }` |
| `useTeamManager` | `lib/hooks/use-team-manager.ts` | `teams`, `teamModalOpen`, `pendingTeamClose`, `teamHubInfo`, `tabCreateMenuOpen` | `{ teams, teamHubInfo, teamModalOpen, setTeamModalOpen, tabCreateMenuOpen, setTabCreateMenuOpen, pendingTeamClose, setPendingTeamClose, handleCreateTeam, handleResumeTeam, doCloseTeam, handleSavePreset, handleDeletePreset }` |
| `useClaudeCheck` | `lib/hooks/use-claude-check.ts` | `claudeCheck` | `{ claudeCheck, runClaudeCheck }` |
| `useClaudeCodePanelResize` | `lib/hooks/use-claude-code-panel-resize.ts` | ref | `{ handleResizeStart }` |
| `useKeyboardShortcuts` | `lib/hooks/use-keyboard-shortcuts.ts` | — | `void` (effect のみ) |
| `useCommandPalette` | `lib/hooks/use-command-palette.ts` | `paletteOpen` | `{ paletteOpen, setPaletteOpen, commands }` |
| `useAppZoom` | `lib/hooks/use-app-zoom.ts` | — | `void` |
| `useContextMenuState` | `lib/hooks/use-context-menu-state.ts` | `contextMenu` | `{ contextMenu, setContextMenu, closeContextMenu, openFileContextMenu }` |

配置方針: **`lib/hooks/` 新設**。既存 `lib/use-*.ts` (Phase 5 成果物) とは層を分け、App.tsx 分割由来の hook だけをここに集める。既存 hook の移動はしない。

#### 新設する Context/子コンポーネント

| 名前 | 目的 |
|---|---|
| `contexts/WorkspaceContext.tsx` | `projectRoot` / `gitStatus` / `sessions` / `teamHistory` を Provider に集約。App.tsx と Sidebar の両方から購読 |
| `components/ClaudeCodePanel.tsx` | `<aside className="claude-code-panel">` 全体 (L1666–1886 相当, ~220 行) を子コンポーネント化 |
| `components/TerminalPane.tsx` | `terminalTabs.map` の中身 (L1784–1883) |
| `components/TabCreateMenu.tsx` | `+` ボタンドロップダウン |
| `components/PendingTeamCloseDialog.tsx` | Leader 閉じ確認ダイアログ |

#### 実装タスク (チェックリスト)

- [ ] `lib/hooks/` ディレクトリ新設 + 上記 13 hook の **型定義ファイルだけを先にコミット** (`*.types.ts` または `.d.ts`)
- [ ] 葉 hook 3 個を抽出 (`useAppZoom`, `useClaudeCheck`, `useClaudeCodePanelResize`) — 独立しているので最速で着地
- [ ] 軽量 hook 3 個を抽出 (`useGitStatus`, `useSessions`, `useTeamHistory`) — 初期ロードは `useProjectLoader` から setter 経由で埋める契約
- [ ] `useDiffEditorTabs` を抽出 — `refreshGit` を引数で受ける
- [ ] `useTerminalTabs` を抽出 — `teams` / `teamHubInfo` を引数で受け、**Phase 5 で決めた mount 契約 (tab.id を key に `cwd`/`command` 変更時は再作成)** を JSDoc に明記
- [ ] `useTeamManager` を抽出 — `useTerminalTabs` と `useTeamHistory` の API を合成、`pendingTeamClose` のハンドラ 3 種を返り値に含める
- [ ] `useProjectLoader` を抽出 — 他 hook の `resetForProjectChange()` を集約して呼び出す
- [ ] `useKeyboardShortcuts` / `useCommandPalette` / `useContextMenuState` を抽出
- [ ] `<ClaudeCodePanel>` / `<TerminalPane>` / `<TabCreateMenu>` / `<PendingTeamCloseDialog>` を子コンポーネント化
- [ ] `contexts/WorkspaceContext.tsx` を新設、App.tsx の Provider 以下を整理
- [ ] App.tsx が **500 行以下** になったことを確認
- [ ] 各 hook に最低限の JSDoc (責務 + 呼び出し順序の制約) を追加

#### 移行ポリシー (破壊しない)

- **コミット粒度**: 1 hook = 1 コミット。各コミット後に `npm run typecheck` + `npm run dev` で手動確認 (Claude Code タブ起動 / git diff / コマンドパレットが壊れていない)
- **禁止事項**: 複数 hook を同コミットで抽出しない。先に型を固めてから本体を移す
- **循環依存の回避**: `useTerminalTabs ⇔ useTeamManager` は `useTerminalTabs` を先に宣言し、その API を `useTeamManager` の引数に渡す一方向にする (双方向参照は禁止)
- **`loadProject` の副作用ブロック** (現 L507–524) は `useProjectLoader` 内で他 hook の `resetForProjectChange()` を順次呼ぶ形に再構成。MCP 初期化 → タブ spawn の順序保証は await 順で維持

#### 依存関係

- **上流**: なし (既存の App.tsx を直接触る)
- **下流**: programmer-1 の `WelcomePane` / `UserMenu` / `CommandPalette` が `WorkspaceContext` を参照したくなる可能性あり。その場合は Context 抽出 (Task 9) 完了後に programmer-1 と同期する
- **横依存**: programmer-3 の `src/types/ipc.ts` 新設と型参照を合わせる

---

### B-2. programmer-3 — CSS / IPC 整理担当

**スコープ**: `index.css` 4063 行の分割、`src/main/ipc/` の命名・エラー・型整理、`themes.ts` の構造化。

#### B-2-a. index.css の分割

分割後の目標構成 (既存 40+ セクションヘッダを新ディレクトリに対応付ける):

```
src/renderer/src/styles/
  tokens.css         # :root 変数, palette, semantic, motion, radius, shadow, typography (L1–116 + L117–212 の一部)
  base.css           # リセット、 body/html/#root、focus ring、禁則、 ::selection (L117–172)
  layout.css         # .layout, .main, .resize-handle, is-resizing ユーティリティ (L214–283)
  motion.css         # @keyframes 群 + .motion-* util + staggered list (L3262–3453 相当)
  components/
    sidebar.css      # L285–595 + L3350–3391 (クロスフェード) + L3667–3774 (チーム履歴)
    toolbar.css      # L596–915 (ツールバー + プロジェクトメニュー)
    tabbar.css       # L917–1029 + L2800–2917 (タブ拡張)
    sidepanel.css    # L1030–1202 (Git + セッション履歴)
    diff.css         # L1203–1251
    editor.css       # L1252–1278
    welcome.css      # L1279–1464
    claudenotfound.css # L1465–1536
    terminal.css     # L1537–1567 + L1849–2017 (ターミナル + タブバー)
    panel.css        # L1568–1769 + L1770–1848 (Claude Code パネル + ペイン) + L2018–2067 (チームグループ + 閉じ確認)
    teambuilder.css  # L2068–2083 + L2133–2334 (Team モーダル)
    menu.css         # L2084–2132 (タブ作成メニュー) + L2335–2413 (コンテキストメニュー) + L3805+ (UserMenu)
    modal.css        # L2414–2799
    palette.css      # L2918–3054
    toast.css        # L3055–3163
    density.css      # L3164–3261
    filetree.css     # L3454–3484 + L3485–3666 (ワークスペース)
    claude-serif.css # L3775–3804 (Claude テーマ serif 見出し override)
  index.css          # ↓↓↓
```

残る `index.css` は `@import` のみ、**~30 行** を目標。

#### B-2-b. IPC 整理

対象ファイル (計 8、1075 行):

| ファイル | 行数 | 主な責務 |
|---|---|---|
| `app.ts` | 146 | project root, restart, zoom, MCP 連携 |
| `dialog.ts` | 52 | ネイティブダイアログ |
| `files.ts` | 192 | ファイルツリー/読み書き |
| `git.ts` | 201 | git status, diff |
| `sessions.ts` | 138 | Claude セッション一覧 |
| `settings.ts` | 42 | settings 永続化 |
| `team-history.ts` | 90 | チーム履歴永続化 |
| `terminal.ts` | 214 | pty 生成、画像ペースト |

**整理項目**:

- [ ] **命名規約統一**: `<domain>:<action>` に揃える (既存の `app:checkClaude` 等を温存しつつ、`git:getStatus`/`sessions:list` などの揺らぎを検証)
- [ ] **`src/types/ipc.ts` を新設**: 各 handler の Request/Response 型を 1 ファイルに集約。preload の contextBridge がこれを import して exposeInMainWorld する型を export する
- [ ] **エラーハンドリング統一**: `type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string }` を導入し、例外を投げず result 型で返すパターンに統一 (main → renderer の try/catch を 1 か所にまとめる wrap helper `handle(channel, fn)` を `main/lib/ipc-handler.ts` に追加)
- [ ] **重複ロジック排除**: project root の解決 / expandHome / ~/.vibe-editor パス生成などの util が複数 handler に散っていれば `main/lib/paths.ts` に集約

#### B-2-c. themes.ts の構造化

- [ ] `lib/themes.ts` を `lib/themes/palette.ts` + `lib/themes/monaco-themes.ts` + `lib/themes/apply.ts` に分割
- [ ] `palette.ts`: `ThemeVars` / `THEMES` (5 テーマのパレット)
- [ ] `monaco-themes.ts`: `monacoTheme` マッピングと Monaco 側の色カスタム
- [ ] `apply.ts`: `applyTheme()` / `applyDensity()` / `isClaudeTheme()`
- [ ] 旧 `themes.ts` は re-export のみの 10 行 shim に落として互換維持

#### 実装タスク (チェックリスト)

- [ ] `styles/` ディレクトリ新設、まず空ファイルをコミット (programmer-0 が中身を書き換えに入れる状態を作る)
- [ ] `index.css` から `tokens.css` / `base.css` / `layout.css` / `motion.css` へ順次 cut & paste (セクションヘッダ単位で移動)
- [ ] 各 `components/*.css` へセクションを切り出し、`index.css` は `@import` のみ残す
- [ ] 分割後に `npm run dev` で視覚的リグレッションがないことを確認 (全テーマ × 全パネル)
- [ ] `src/main/lib/ipc-handler.ts` に `handle()` wrap helper を追加
- [ ] 8 ハンドラを順次 `handle()` 経由に書き換え (1 コミット = 1 ファイル)
- [ ] `src/types/ipc.ts` を新設し、Request/Response 型を 1 ファイルに集約
- [ ] `src/preload/index.ts` を型参照に切り替え (channel 名は変更しない)
- [ ] `lib/themes.ts` を 3 ファイルに分割、旧パスは re-export shim
- [ ] `lib/themes/monaco-themes.ts` を programmer-0 のトークン層更新と合わせて値調整

#### 依存関係

- **上流**: なし (純粋整理)
- **下流**: programmer-0 の UI Shell 書き換えは `styles/components/{sidebar,toolbar,tabbar}.css` の「箱」が出来てから着手可能。programmer-1 の UI Component 書き換えも `styles/components/{palette,modal,menu,toast}.css` に依存
- **横依存**: programmer-2 の `src/types/ipc.ts` 新設と衝突しないよう、types ディレクトリの所有者は programmer-3 に一本化

---

## C. 実装順序 & マイルストーン

### Phase 0 — 下準備 (1 日, 全員)

- [ ] researcher による `tasks/design-research.md` 到着 (配色/タイポ/motion トークン)
- [ ] programmer-3: `styles/` ディレクトリ新設、`index.css` から tokens/base/layout だけ先に切り出し
- [ ] programmer-2: `lib/hooks/` ディレクトリ新設、13 hook の **型ファイルだけ** 先にコミット
- [ ] programmer-0/1: `design-research.md` を読み合わせ、共通トークン命名を合意

### Phase 1 — トークン刷新 + CSS 分割の残り (2 日、programmer-0 & programmer-3 並行)

- programmer-0: `themes.ts` 4 層化 + `tokens.css` 値確定 + `applyTheme` 書き換え
- programmer-3: `index.css` → `components/*.css` の分割完了。`motion.css` の keyframes を programmer-1 と合意
- programmer-2: 葉 hook 3 個 (`useAppZoom`, `useClaudeCheck`, `useClaudeCodePanelResize`) を抽出

**ゲート**: `npm run dev` で既存の見た目が壊れていないこと

### Phase 2 — Shell 再構築 + App.tsx hooks 抽出 (3 日、programmer-0 & programmer-2 並行)

- programmer-0: `Sidebar` / `Toolbar` / `TabBar` / `.layout` を新トークンベースで書き換え
- programmer-2: `useGitStatus` / `useSessions` / `useTeamHistory` / `useDiffEditorTabs` / `useTerminalTabs` / `useTeamManager` / `useProjectLoader` を順次抽出 (1 コミット = 1 hook)
- programmer-3: IPC 整理 (`handle()` wrap + `src/types/ipc.ts` 新設)

**ゲート**: App.tsx が 800 行以下、既存機能全部動作

### Phase 3 — コンポーネント磨き込み + IPC 整理仕上げ (2 日、programmer-1 & programmer-3 並行)

- programmer-1: `CommandPalette` / `SettingsModal` / `WelcomePane` / `UserMenu` / `AppMenu` / `ContextMenu` / Toast / `use-animated-mount` 拡張
- programmer-3: `themes.ts` 3 分割、残る IPC handler の統一、重複 util の集約
- programmer-2: `useKeyboardShortcuts` / `useCommandPalette` / `useContextMenuState` + `<ClaudeCodePanel>` / `<TerminalPane>` / `<TabCreateMenu>` / `<PendingTeamCloseDialog>` を子コンポーネント化、`WorkspaceContext` 新設

**ゲート**: App.tsx が 500 行以下、index.css が 100 行以下

### Phase 4 — 統合レビュー (1 日、reviewer)

- [ ] 全テーマ (claude-dark / claude-light / dark / midnight / light) × 全密度 (compact / normal / comfortable) でビジュアル確認
- [ ] Claude Code / Codex / チームモードの起動経路
- [ ] git diff / コマンドパレット / 設定モーダル / セッション再開 / 画像ペースト
- [ ] Ctrl+Shift+P / Ctrl+, / Ctrl+Tab / Ctrl+W / Ctrl+S / Ctrl+Shift+T
- [ ] motion-reduce 設定でも破綻しない
- [ ] `npm run typecheck` / `npm run build` / `npm run dist:win` が全て通る

**所要合計**: 約 9 日 (1 人日換算、並行実行で実時間 4–5 日)

---

## D. 受け入れ基準

### D-1. 定量基準

- [ ] `npm run typecheck` がエラー 0 で通る
- [ ] `npm run build` が警告 0 で通る
- [ ] `npm run dev` で起動し、初期画面 (WelcomePane または last project) が表示される
- [ ] `src/renderer/src/App.tsx` が **500 行以下**
- [ ] `src/renderer/src/index.css` が **100 行以下** (`@import` のみ)
- [ ] 新設 CSS ファイル (`styles/components/*.css`) がいずれも 400 行を超えない
- [ ] 新設 hook ファイル (`lib/hooks/*.ts`) がいずれも 300 行を超えない

### D-2. 機能リグレッション禁止リスト (Phase 4 で全数検証)

- [ ] Monaco diff ビューア (side-by-side / inline 切替、バイナリ検出)
- [ ] xterm.js + node-pty (複数タブ、ドラッグ並び替え、テーマ切替追従、画像ペースト Ctrl+V / DnD、Ctrl+C 選択コピー vs SIGINT)
- [ ] ファイルツリー (ワークスペース複数ルート、コンテキストメニュー)
- [ ] git status / diff refresh (保存後の自動 refresh、dirty file クリック → diff)
- [ ] コマンドパレット (Ctrl+Shift+P、ファジー検索、全コマンド実行)
- [ ] セッション履歴 (resume、active セッションハイライト)
- [ ] チーム作成モーダル (builtin プリセット 3 種、saved preset 編集/削除、remaining 不足時 disabled)
- [ ] チーム履歴 resume (MCP 再登録 + メンバースポーン)
- [ ] 設定モーダル (全セクション、Apply/Reset、言語即時反映、motion 追従)
- [ ] 5 テーマ切替 (claude-dark/light, dark, midnight, light) で全画面が破綻しない
- [ ] 3 密度 (compact/normal/comfortable) で余白/行高が切り替わる
- [ ] Ctrl+Shift+P / Ctrl+, / Ctrl+Tab / Ctrl+Shift+Tab / Ctrl+W / Ctrl+Shift+T / Ctrl+S
- [ ] サイドバー/Claude Code パネルのリサイズハンドル
- [ ] 自動アップデート (electron-updater) の起動確認

### D-3. デザイン基準 (reviewer 視点)

- [ ] claude.ai / Linear / Vercel に並べても見劣りしない質感 (余白のリズム、hover/active の"軽やかさ"、影の層)
- [ ] Claude coral アクセントが 5 テーマすべてで「目的のある色」として機能している (他の warn/info と衝突しない)
- [ ] motion が `prefers-reduced-motion` で段階的に退化する
- [ ] 情報密度 compact でも Sidebar/Toolbar のアイコンが視認可能
- [ ] タイポグラフィスケール (xs / sm / base / md / lg / xl / 2xl / 3xl) が全画面で一貫している

---

## E. リスクと緩和

| リスク | 影響 | 緩和策 |
|---|---|---|
| programmer-0 と programmer-3 の CSS ファイル同時編集 | マージ衝突 | `styles/components/*.css` のオーナーを事前合意、1 ファイル = 1 担当 |
| App.tsx 分割中の既存機能破壊 | 開発停止 | 1 hook = 1 コミット、各コミット後に `npm run dev` で手動確認 |
| `useTerminalTabs ⇔ useTeamManager` の循環依存 | ビルド破綻 | 宣言順固定 (terminal → team) + 一方向参照を JSDoc に明記 |
| `loadProject` の reset 副作用漏れ | プロジェクト切替時の state 残留 | 各 hook に `resetForProjectChange()` を必ず実装、`useProjectLoader` が順次 call |
| Phase 5 で確立された TerminalView mount 契約の忘却 | タブ再生成が効かず pty が古いまま | `useTerminalTabs` の JSDoc と `CLAUDE.md` に契約を追記 |
| researcher トークン未着でデザインが進まない | Phase 1 遅延 | programmer-0 は既存 `themes.ts` の値を暫定採用して構造だけ先に変える (値は後で差し替え) |
| IPC handler の統一 wrap が既存例外パスを壊す | ランタイムエラー | `handle()` wrap は例外を catch して `{ ok:false }` を返す形にし、renderer 側は型で強制。既存の throw パスは一時的に互換 shim を残す |

---

## F. 付録: ファイル一覧のクイック参照

**programmer-0 が触る**:

- `src/renderer/src/lib/themes.ts` (既存)
- `src/renderer/src/components/{Sidebar,Toolbar,TabBar}.tsx` (既存)
- `src/renderer/src/styles/{tokens.css,base.css,layout.css}` (新設、箱は programmer-3)
- `src/renderer/src/styles/components/{sidebar.css,toolbar.css,tabbar.css}` (新設、箱は programmer-3)

**programmer-1 が触る**:

- `src/renderer/src/components/{CommandPalette,SettingsModal,WelcomePane,UserMenu,AppMenu,ContextMenu}.tsx` (既存)
- `src/renderer/src/components/settings/*.tsx` (既存 6 ファイル)
- `src/renderer/src/components/primitives/PopoverMenu.tsx` (新設)
- `src/renderer/src/lib/{toast-context.tsx,use-animated-mount.ts}` (既存拡張)
- `src/renderer/src/styles/components/{palette.css,modal.css,menu.css,toast.css}` (新設、箱は programmer-3)
- `src/renderer/src/styles/motion.css` (新設、programmer-3 と共有)

**programmer-2 が触る**:

- `src/renderer/src/App.tsx` (既存、分割対象)
- `src/renderer/src/lib/hooks/*.ts` (13 ファイル新設)
- `src/renderer/src/contexts/WorkspaceContext.tsx` (新設)
- `src/renderer/src/components/{ClaudeCodePanel,TerminalPane,TabCreateMenu,PendingTeamCloseDialog}.tsx` (新設)

**programmer-3 が触る**:

- `src/renderer/src/index.css` (既存、最終的に `@import` のみ)
- `src/renderer/src/styles/**` (新設、全ファイル)
- `src/renderer/src/lib/themes/{palette.ts,monaco-themes.ts,apply.ts}` (既存 themes.ts から分離)
- `src/main/ipc/*.ts` (既存 8 ファイル、wrap 化)
- `src/main/lib/ipc-handler.ts` (新設)
- `src/main/lib/paths.ts` (新設)
- `src/types/ipc.ts` (新設)

---

_作成: planner / 2026-04-15_
_関連: tasks/refactor-plan.md (Phase 1–6 完了済), tasks/refactor-app-analysis.md (App.tsx 抽出マップ), tasks/design-research.md (トークン値、researcher 作成予定)_
