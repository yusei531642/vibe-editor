# App.tsx 抽出マップ（リファクタ下準備）

- 対象: `src/renderer/src/App.tsx`（1928行）
- 目的: custom hooks と子コンポーネントへ分割するための**調査のみ**。コードは書かない。
- 前提: `useSettings()` / `useToast()` / `useT()` は既に Context 化済み。IPC は `window.api.*`。

---

## 1. State 変数のグルーピング

App コンポーネント直下で宣言されている全 `useState` / `useRef` を列挙し、論理グループに振り分けた。

### G1. プロジェクトローディング系
| シンボル | 行 | 種類 | 用途 |
|---|---|---|---|
| `projectRoot` | L148 | useState | 現在開いているプロジェクトのルートパス |
| `status` | L151 | useState | ツールバー右側のステータス文字列 |

### G2. Sidebar 系
| シンボル | 行 | 種類 | 用途 |
|---|---|---|---|
| `sidebarView` | L154 | useState | `'changes' \| 'sessions'` |

### G3. Git 系
| シンボル | 行 | 種類 | 用途 |
|---|---|---|---|
| `gitStatus` | L157 | useState | `GitStatus \| null` |
| `gitLoading` | L158 | useState | 変更一覧ロード中フラグ |

### G4. Sessions（Claude 履歴）系
| シンボル | 行 | 種類 | 用途 |
|---|---|---|---|
| `sessions` | L161 | useState | 過去の Claude セッション一覧 |
| `sessionsLoading` | L162 | useState | ロード中 |
| `activeSessionId` | L163 | useState | 再開中のセッション ID |

### G5. Team History 系
| シンボル | 行 | 種類 | 用途 |
|---|---|---|---|
| `teamHistoryEntries` | L166 | useState | プロジェクト毎のチーム履歴エントリ |
| `teamHistoryPending` | L178 | useRef | デバウンス保存の pending map |
| `teamHistoryFlushTimer` | L179 | useRef | 500ms flush タイマー |
| `spawnStaggerTimers` | L169 | useRef | チーム作成時のメンバースポーン遅延タイマー配列 |

### G6. Diff / Editor タブ系
| シンボル | 行 | 種類 | 用途 |
|---|---|---|---|
| `activeTabId` | L195 | useState | diff/editor 共通のアクティブタブ ID |
| `diffTabs` | L196 | useState | `DiffTab[]`（`diff:` プレフィックス） |
| `editorTabs` | L197 | useState | `EditorTab[]`（`edit:` プレフィックス） |
| `recentlyClosed` | L198 | useState | 最近閉じた diff タブ（復元用） |
| `sideBySide` | L199 | useState | Diff 表示モード（side-by-side / inline） |

### G7. Terminal タブ系
| シンボル | 行 | 種類 | 用途 |
|---|---|---|---|
| `terminalTabs` | L202 | useState | `TerminalTab[]`（最大 30 個） |
| `activeTerminalTabId` | L203 | useState | 現在アクティブなターミナルタブ ID |
| `nextTerminalIdRef` | L204 | useRef | ID 払い出しカウンタ |
| `terminalRefs` | L205 | useRef | `Map<id, TerminalViewHandle>` |
| `dragTabId` | L213 | useState | ドラッグ中タブ ID |
| `dragOverTabId` | L214 | useState | ドラッグホバー先 ID |

### G8. Team 系
| シンボル | 行 | 種類 | 用途 |
|---|---|---|---|
| `teams` | L208 | useState | ランタイムのチーム一覧 |
| `teamModalOpen` | L207 | useState | TeamCreateModal 表示 |
| `pendingTeamClose` | L209 | useState | Leader タブ閉じ時の確認ダイアログ状態 |
| `teamHubInfo` | L1261 | useState | `{ socket, token } \| null`（MCP 用） |
| `tabCreateMenuOpen` | L206 | useState | `+` ボタンの作成メニュー（Team作成へのエントリポイント含む） |

### G9. Claude CLI 検査系
| シンボル | 行 | 種類 | 用途 |
|---|---|---|---|
| `claudeCheck` | L217 | useState | `{ state: 'checking' \| 'ok' \| 'missing', error? }` |

### G10. Claude Code パネル リサイズ系
| シンボル | 行 | 種類 | 用途 |
|---|---|---|---|
| `resizeDragRef` | L396 | useRef | `{ startX, startWidth } \| null` |
| （CSS 変数 `--claude-code-width`） | L404 | — | DOM に直接書く |

### G11. UI modals / overlay 系
| シンボル | 行 | 種類 | 用途 |
|---|---|---|---|
| `settingsOpen` | L149 | useState | SettingsModal |
| `paletteOpen` | L150 | useState | CommandPalette |
| `contextMenu` | L223 | useState | 右クリックメニュー（x,y,items） |

---

## 2. 各グループに紐づく useCallback / useEffect / useMemo

### G1. プロジェクトローディング
- `loadProject(root, opts)` — L477〜540。git status / sessions / MCP 初期化 / タブリセットまで面倒を見る“巨大ファサード”
- `handleNewProject` — L938
- `handleOpenFolder` — L951
- `handleOpenFile` — L957
- `handleOpenRecent` — L967
- `handleClearRecent` — L974
- `handleRestart` — L581。アプリ再起動（未保存 editor の確認あり）
- useEffect 初回ロード — L543〜573。`window.api.app.getProjectRoot()` から初期化
- useEffect タイトルバー反映 — L576〜579

### G2. Sidebar
- （useCallback なし。setter 直接）
- useEffect sidebarView 切替時 — L628〜630（sessions を refresh）

### G3. Git
- `refreshGit` — L590〜599

### G4. Sessions
- `refreshSessions` — L617〜626
- `handleResumeSession(session)` — L847〜854。`addTerminalTab` を呼び出すので G7 依存

### G5. Team history
- `saveTeamHistory(entry)` — L180〜192。debounce 付き
- `refreshTeamHistory` — L601〜610
- `handleResumeTeam(entry)` — L1405〜1466。再開処理（MCP 再登録 + メンバースポーン）
- `handleDeleteTeamHistory(id)` — L1468〜1479
- `handleTerminalSessionId(tab, sessionId)` — L1482〜1507。ターミナルが session id を通知してきたら履歴更新
- `clearSpawnTimers` — L170〜173
- useEffect プロジェクト変更時ロード — L613〜615

### G6. Diff / Editor タブ
- `dirtyEditorTabs` useMemo — L456〜459
- `confirmDiscardEditorTabs(ids?)` — L461〜474
- `openDiffTab(file)` — L632〜673
- `refreshDiffTabsForPath(relPath)` — L675〜710
- `openEditorTab(relPath)` — L714〜760
- `updateEditorContent(id, content)` — L762〜766
- `saveEditorTab(id)` — L768〜796。保存後 `refreshGit` + `refreshDiffTabsForPath` を呼ぶ（G3/G6 をまたぐ）
- `closeTab(id)` — L858〜898（diff/editor 両対応）
- `togglePin(id)` — L900〜910
- `reopenLastClosed()` — L912〜920
- `cycleTab(direction)` — L922〜934
- `reviewDiff(file)` — L801〜817。ターミナルに差分レビューを送信（G7 依存）
- `handleFileContextMenu(e, file)` — L819〜843（G11 の contextMenu をセット）
- `tabs`（TabItem 配列） — L1558〜1572
- 派生値 `activeDiffTab/activeEditorTab/activeDiffPath/activeFilePath/hasActiveContent` — L1574〜1578

### G7. Terminal タブ
- `addTerminalTab(opts?)` — L229〜273
- `doCloseTab(tabId)` — L275〜305。最後の1個なら自動で新規タブ生成
- `closeTerminalTab(tabId)` — L347〜357。Leader なら pendingTeamClose を立てる
- `restartTerminalTab(tabId)` — L359〜367
- `restartTerminal()` — L369〜371
- `getTerminalArgs(tab)` — L1238〜1258（G8 の teams に依存）
- `getTerminalEnv(tab)` — L1266〜1279（G8 の teamHubInfo に依存）
- `getRolePrompt(tab)` — L1282〜1293
- useEffect 初回タブ自動生成 — L1296〜1300
- useMemo `standaloneTabList / teamGroupList` — L1535〜1554（G8 teams も参照）
- 派生値 `activeTab` — L1581

### G8. Team
- `doCloseTeam(teamId)` — L307〜345（G7 terminalTabs / teams を両方 mutate）
- `handleCreateTeam(name, leader, members)` — L1304〜1401
- `handleSavePreset(preset)` — L1509〜1523
- `handleDeletePreset(id)` — L1525〜1531
- useEffect TeamHub info 取得（1回だけ） — L1262〜1264

### G9. Claude CLI 検査
- `runClaudeCheck` — L374〜386
- useEffect 設定変更監視 — L389〜391

### G10. Claude Code パネル リサイズ
- useEffect CSS 変数反映 — L399〜405
- `handleResizeStart(e)` — L407〜454。mousemove/mouseup を window に生で貼る

### G11. UI modals / keyboard / zoom / palette
- `commands` useMemo — L981〜1164。**ほぼすべてのグループを参照する最大の依存ノード**
- useEffect Shift+Wheel zoom — L1168〜1180
- useEffect グローバルキーボードショートカット — L1184〜1234
  - Ctrl+Shift+P: palette
  - Ctrl+S: `saveEditorTab(activeTabId)`
  - Ctrl+,: settings
  - Ctrl+Tab / Ctrl+Shift+Tab: `cycleTab`
  - Ctrl+W: `closeTab`
  - Ctrl+Shift+T: `reopenLastClosed`
  - Esc: palette / settings を閉じる

---

## 3. 抽出候補の custom hook 案

各 hook で内部状態・入力・出力 API を記載する。**コードは書かない**、型シグネチャだけ示す。

### 3.1 `useProjectLoader`
メインの“ファサード”。プロジェクト切替に付随する状態リセットを一元化。

```
内部 state:
  - projectRoot, status

引数:
  - onProjectChange(root): void   // 他 hook の状態リセット用コールバック
  - confirmDiscard(): boolean      // dirty エディタの確認（useEditorTabs 由来）
  - setupMcpInit(root): Promise<void>  // 副作用として呼ぶ
  - setInitialGitAndSessions(gs, sess): void  // 初期ロードで G3/G4 を埋める用

返す API:
  - projectRoot, status
  - loadProject(root, opts)
  - handleNewProject, handleOpenFolder, handleOpenFile
  - handleOpenRecent, handleClearRecent
  - handleRestart
```

注意: 現 `loadProject` はタブ系・チーム系の状態を直接全部 reset している（L501〜524）。リファクタでは**リセットを callback 経由で外に出す**のが素直。もしくは「プロジェクト切替イベント」を発火してそれを各 hook が購読する pub-sub にする選択肢もある。

### 3.2 `useGitStatus`
```
内部 state: gitStatus, gitLoading

引数:
  - projectRoot

返す API:
  - gitStatus, gitLoading
  - refreshGit()
  - setGitStatus, setGitLoading (初期ロード時に useProjectLoader から埋めるため)
```

### 3.3 `useSessions`
```
内部 state: sessions, sessionsLoading, activeSessionId

引数:
  - projectRoot
  - sidebarView  // sessions ビュー切替時に refresh するため
  - onResume(sessionId)  // ターミナルタブを追加する側に委譲

返す API:
  - sessions, sessionsLoading, activeSessionId
  - refreshSessions()
  - handleResumeSession(session)
  - setSessions (初期ロード用)
```

### 3.4 `useTeamHistory`
```
内部 state: teamHistoryEntries
内部 ref:   teamHistoryPending, teamHistoryFlushTimer

引数:
  - projectRoot

返す API:
  - teamHistoryEntries
  - refreshTeamHistory()
  - saveTeamHistory(entry)
  - handleDeleteTeamHistory(id)
  - updateMemberSessionId(teamId, memberIdx, sessionId)  // 現 handleTerminalSessionId の中身
```
※ `handleResumeTeam` は Terminal/MCP と密結合なので**この hook には置かず**、`useTeamManager` 側に持たせる。

### 3.5 `useTerminalTabs`
“一番でかい hook”。Terminal の一覧・追加・削除・再起動・ドラッグ・getArgs/Env/RolePrompt を持つ。

```
内部 state:
  terminalTabs, activeTerminalTabId, dragTabId, dragOverTabId
内部 ref:
  nextTerminalIdRef, terminalRefs, spawnStaggerTimers

引数:
  - projectRoot
  - settings  (claudeArgs/codexArgs/claudeCommand/codexCommand/claudeCwd)
  - teams      // getTerminalArgs で team を引きに行くため
  - teamHubInfo
  - claudeCheckOk: boolean  // 初回自動生成トリガー
  - showToast, t

返す API:
  - terminalTabs, activeTerminalTabId
  - setActiveTerminalTabId
  - activeTab (派生)
  - addTerminalTab(opts)
  - closeTerminalTab(id)           // Leader の場合は pendingTeamClose を外に委譲
  - doCloseTab(id)
  - restartTerminalTab(id), restartTerminal()
  - getTerminalArgs(tab), getTerminalEnv(tab), getRolePrompt(tab)
  - terminalRefs  // 外から sendCommand するため
  - ドラッグ関連: dragTabId, dragOverTabId, setDragTabId, setDragOverTabId, reorderTabs(from,to)
  - clearSpawnTimers()
  - resetTerminalsForProjectChange(): void  // 現 loadProject の L508〜524 の中身
```

- `closeTerminalTab` は Leader 判定だけ残し、`onLeaderCloseRequested(tabId, teamId)` を callback として受ける設計にすれば pendingTeamClose を外側の UI hook に持たせられる。

### 3.6 `useTeamManager`
```
内部 state:
  teams, teamModalOpen, pendingTeamClose, teamHubInfo, tabCreateMenuOpen

引数:
  - projectRoot
  - addTerminalTab, doCloseTab, setTerminalTabs (useTerminalTabs 由来)
  - clearSpawnTimers
  - saveTeamHistory, updateTeamHistoryEntries (useTeamHistory 由来)
  - showToast, t

返す API:
  - teams, teamHubInfo
  - teamModalOpen, setTeamModalOpen
  - tabCreateMenuOpen, setTabCreateMenuOpen
  - pendingTeamClose, setPendingTeamClose
  - handleCreateTeam(name, leader, members)
  - handleResumeTeam(entry)
  - doCloseTeam(teamId)
  - handleSavePreset, handleDeletePreset
```

### 3.7 `useDiffEditorTabs`
Diff と Editor 両方のタブを担う。現状 `activeTabId` を 2 つのタブ配列で共有しているので**分けるべきではない**（分けると fallback 選択・cycleTab のロジックが複雑化する）。

```
内部 state:
  activeTabId, diffTabs, editorTabs, recentlyClosed, sideBySide

引数:
  - projectRoot
  - refreshGit  // 保存後呼ぶため（G3 依存）
  - showToast, t

返す API:
  - activeTabId, setActiveTabId
  - diffTabs, editorTabs, recentlyClosed, sideBySide, setSideBySide
  - 派生: activeDiffTab, activeEditorTab, activeDiffPath, activeFilePath,
          hasActiveContent, tabs (TabItem[]), dirtyEditorTabs
  - confirmDiscardEditorTabs(ids?)
  - openDiffTab(file)
  - refreshDiffTabsForPath(relPath)
  - openEditorTab(relPath)
  - updateEditorContent(id, content)
  - saveEditorTab(id)
  - closeTab(id), togglePin(id), reopenLastClosed(), cycleTab(dir)
  - resetTabsForProjectChange(): void
```

### 3.8 `useClaudeCheck`
```
内部 state: claudeCheck

引数:
  - claudeCommand (from settings)

返す API:
  - claudeCheck
  - runClaudeCheck()
```

### 3.9 `useClaudeCodePanelResize`
```
内部 ref: resizeDragRef
外部効果: document.documentElement CSS 変数 `--claude-code-width`

引数:
  - initialWidth (settings.claudeCodePanelWidth)
  - onCommit(width)  // 確定時に updateSettings を呼ぶ

返す API:
  - handleResizeStart(e)
```

### 3.10 `useKeyboardShortcuts`
```
引数:
  - { paletteOpen, settingsOpen, activeTabId,
      onTogglePalette, onCloseModals, onOpenSettings,
      onCycleTab(dir), onCloseTab(id),
      onReopenLastClosed, onSaveEditorTab(id) }

返す API:
  （何も返さない — useEffect の塊）
```

### 3.11 `useCommandPalette`
```
内部 state: paletteOpen

引数:
  - ほぼ全ての hook の API（現 commands useMemo の依存配列相当）
  - settings

返す API:
  - paletteOpen, setPaletteOpen
  - commands: Command[]
```

### 3.12 `useAppZoom`
```
useEffect のみ。引数なし、返り値なし。
```

### 3.13 `useContextMenuState`（軽量）
```
内部 state: contextMenu

返す API:
  - contextMenu, setContextMenu, closeContextMenu
  - openFileContextMenu(e, file, { openDiffTab, reviewDiff }): void
```

---

## 4. クロスグループ依存

矢印は `A → B` = 「A が B の state または関数を必要とする」。

```
useProjectLoader ────┬─> useGitStatus.setGitStatus (初期ロード)
                     ├─> useSessions.setSessions (初期ロード)
                     ├─> useDiffEditorTabs.resetTabsForProjectChange
                     ├─> useDiffEditorTabs.confirmDiscardEditorTabs
                     ├─> useTerminalTabs.resetTerminalsForProjectChange
                     └─> useTeamManager.resetTeams（teams=[] にする）

useSessions ─> useTerminalTabs.addTerminalTab      (handleResumeSession)

useDiffEditorTabs ──┬─> useGitStatus.refreshGit    (saveEditorTab 後)
                    └─> (reviewDiff は App 層で useTerminalTabs.terminalRefs を参照)

useTerminalTabs ──┬─> useTeamManager.teams          (getTerminalArgs でシステムプロンプト合成)
                  ├─> useTeamManager.teamHubInfo    (getTerminalEnv)
                  └─> useClaudeCheck.claudeCheck    (初回自動タブ生成 useEffect)

useTeamManager ──┬─> useTerminalTabs.addTerminalTab      (handleCreateTeam / handleResumeTeam)
                 ├─> useTerminalTabs.doCloseTab           (doCloseTeam / pendingTeamClose 解決)
                 ├─> useTerminalTabs.setTerminalTabs      (MCP 再設定後のサイレント再起動, L1331〜1339 / L1440〜1448)
                 ├─> useTerminalTabs.clearSpawnTimers
                 ├─> useTeamHistory.saveTeamHistory       (handleCreateTeam / handleResumeTeam)
                 └─> useTeamHistory.setTeamHistoryEntries (直接 setter。抽出時は update 用 API 経由にすべき)

useTeamHistory ──> (handleTerminalSessionId 経由で TerminalView の onSessionId を処理するが、
                    呼び出し元は useTerminalTabs から渡される tab オブジェクト)

useKeyboardShortcuts ──┬─> useDiffEditorTabs.{cycleTab,closeTab,reopenLastClosed,saveEditorTab}
                       ├─> useCommandPalette.paletteOpen
                       └─> settingsOpen (UI state)

useCommandPalette ──┬─> useProjectLoader 全般
                    ├─> useDiffEditorTabs.{cycleTab,closeTab,togglePin,reopenLastClosed}
                    ├─> useGitStatus.refreshGit
                    ├─> useSessions.refreshSessions
                    ├─> useTerminalTabs.{addTerminalTab,closeTerminalTab,restartTerminal,activeTerminalTabId,terminalTabs.length}
                    ├─> useTeamManager.setTeamModalOpen
                    └─> settings / updateSettings / handleRestart
```

### 🔴 注意すべきホットスポット

1. **useTerminalTabs ↔ useTeamManager は双方向参照**
   - terminal 側は `teams` / `teamHubInfo` を args 生成で読む
   - team 側は terminal 側の `addTerminalTab` / `setTerminalTabs` / `doCloseTab` を頻繁に呼ぶ
   - 循環依存ではないが、**hook の呼び出し順序を固定**する必要がある（`useTerminalTabs` を先に呼び、その戻り値を `useTeamManager` に渡す）。
   - `getTerminalArgs` / `getTerminalEnv` / `getRolePrompt` は team を参照するので、**これらだけを useTeamManager に渡してもらって generate する設計**のほうが綺麗。
     - 代替案: `useTerminalTabs` が `teams`/`teamHubInfo` を引数で受け取る（=外部から supply）。現在の実装と同じ方向になり最小摩擦。

2. **loadProject の副作用ブロック (L507〜524)**
   - チーム、ターミナル、タブ、セッションの**4 hook にまたがる reset** を1関数でやっている
   - 抽出後は「プロジェクト変更イベント」を `useEffect([projectRoot])` の形で各 hook に持たせるのが素直。ただし**初回ロード時の race**（MCP 初期化→タブ spawn の順序保証）が崩れないか要注意。現コードは await 順序で安全を確保している（L491〜496 / L554〜559）。

3. **reviewDiff (L801) は 2 hook を跨ぐ**
   - `useDiffEditorTabs` の API に置くなら `terminalRefs` と `activeTerminalTabId` を引数で貰う
   - `useTerminalTabs` 側に置くなら「diff からトリガされる関数」という違和感が出る
   - 推奨: **App 層の薄いアダプタ関数**として残す（hook にしない）。

4. **コマンドパレット `commands` useMemo は最大の依存ノード**
   - `useCommandPalette` は“受け側”にしかなれない（全 hook の API を入力として受け取る）
   - リファクタしても依存配列が長大になるのは避けられない。**コマンドを category ごとに複数 useMemo で構築**してから結合すると多少マシになる（`useProjectCommands`, `useTabCommands`, `useTerminalCommands`, `useSettingsCommands`…）。

5. **pendingTeamClose は UI 状態だが Team と Terminal 両方に作用する**
   - `useTeamManager` に置き、確定ハンドラ 3 種類（closeTeam / closeLeaderOnly / cancel）を返すのが良い。現実装だと render 内のインラインハンドラに散っている (L1750〜1758)。

6. **循環依存の有無**: 厳密な循環は無い。ただし **useTerminalTabs → teams / teamHubInfo** と **useTeamManager → addTerminalTab / setTerminalTabs** のように「同じ2者間で双方向の参照」が存在するので、**どちらかを props 経由でしか触らせない**ように決めないと hook 宣言順序で事故る。

---

## 5. 最終 render 部の構造（L1583 以降）

コンポーネント木と渡している主な props を要約。

```
<div className="layout">
├── <Sidebar>
│     view, onViewChange                        … G2
│     projectRoot                               … G1
│     activeFilePath                            … G6 派生
│     onOpenFile=(p)=>openEditorTab(p)          … G6
│     gitStatus, gitLoading, onRefreshGit       … G3
│     onOpenDiff=openDiffTab                    … G6
│     onFileContextMenu=handleFileContextMenu   … G6+G11
│     activeDiffPath                            … G6 派生
│     sessions, sessionsLoading, activeSessionId… G4
│     onRefreshSessions, onResumeSession        … G4
│     teamHistory=teamHistoryEntries            … G5
│     onResumeTeam, onDeleteTeamHistory         … G5
│
├── <main className="main">
│   ├── <Toolbar>
│   │     projectRoot, onRestart, onOpenSettings, onOpenPalette,
│   │     status, recentProjects,
│   │     onNewProject / onOpenFolder / onOpenFile /
│   │     onOpenRecent / onClearRecent            … G1 + G11
│   │
│   ├── {tabs.length>0 && <TabBar>}
│   │     tabs, activeId=activeTabId,
│   │     onSelect=setActiveTabId, onClose=closeTab, onTogglePin=togglePin … G6
│   │
│   └── <div className="content-area">
│         activeEditorTab ? <EditorView ... onChange/onSave> … G6
│         : activeDiffTab ? <DiffView ... sideBySide/onToggleSideBySide> … G6
│         : null
│
├── {hasActiveContent && <div className="resize-handle" onMouseDown={handleResizeStart} />} … G10
│
├── <aside className="claude-code-panel">
│   ├── <header>
│   │   ├── <AppMenu>  (G1 の onNewProject 等を同じ props で渡す、Sidebar と重複)
│   │   ├── toolbar buttons: palette / settings … G11
│   │   └── <div> + ボタン + tab-create-menu
│   │         addTerminalTab(claude/codex) / setTeamModalOpen    … G7+G8
│   │
│   ├── {pendingTeamClose && <div className="team-close-confirm"> … G8
│   │     ・doCloseTeam  ・doCloseTab + setTeams/setTerminalTabs  ・cancel
│   │
│   └── <div className="claude-code-panel__body" data-panes={n}>
│         checking   : <div>...</div>
│         missing    : <ClaudeNotFound onRetry/onOpenSettings>   … G9
│         ok         : terminalTabs.map(tab => (
│             <div className="terminal-pane">
│               {terminalTabs.length>1 && <div className="terminal-pane__header"
│                   draggable onDragStart/Over/Leave/Drop/End
│                   (dragTabId/dragOverTabId を mutate)         … G7
│                   子: agent アイコン / Crown / role / team 名 / close>
│               }
│               <TerminalView
│                 ref=terminalRefs.set(id)
│                 cwd, command, args=getTerminalArgs(tab),
│                 env=getTerminalEnv(tab), teamId,
│                 initialMessage=getRolePrompt(tab),
│                 agentId, role,
│                 onStatus / onExit / onSessionId=handleTerminalSessionId
│               />                                              … G7+G5+G8
│             </div>
│         ))
│
├── <SettingsModal open=settingsOpen onClose/onApply/onReset>     … G11
├── <CommandPalette open=paletteOpen commands onClose>            … G11
├── {contextMenu && <ContextMenu x y items onClose>}              … G11
└── <TeamCreateModal
       open=teamModalOpen onClose, onCreate=handleCreateTeam,
       savedPresets, onSavePreset, onDeletePreset,
       maxTerminals=MAX_TERMINALS,
       currentTabCount=terminalTabs.length,
       existingTeams=teams>                                        … G8
```

### 抽出候補の子コンポーネント

`render` の中で「ひと塊」になっている箇所は、hook 化と並行して**そのまま子コンポーネントとして切り出す**のが効く。

1. **`<ClaudeCodePanel>`** — `<aside className="claude-code-panel">` 全体（ヘッダー、作成メニュー、確認ダイアログ、ペイン一覧）。props: `terminalTabs / teams / activeTerminalTabId / dragTabId / dragOverTabId / claudeCheck / handlers…`。L1666〜1886 の 220 行がそっくり消える。
2. **`<TerminalPane>`** — `terminalTabs.map` の中身（L1784〜1883）。props: `tab / teams / isActive / dragOverTabId / handlers…`。
3. **`<TabCreateMenu>`** — `+` ボタン下ドロップダウン（L1698〜1741）。
4. **`<PendingTeamCloseDialog>`** — L1745〜1761。
5. **`<ProjectMenuBar>`** — `Toolbar` と `AppMenu` で**完全に同じ props 配列**を渡している（L1608〜1618 と L1669〜1676）ので、App から“プロジェクトメニュー関連の actions オブジェクト”を 1 つだけ作って両者に流し込む薄いアダプタを作ると見通しが良くなる。
6. **`<ContentArea>`** — L1629〜1653 の editor / diff 切替分岐（小さいので優先度は低）。

---

## 6. 推奨リファクタ順序（おまけ）

依存の**末端側（葉）**から順に剥がしていくのが事故が少ない。

1. `useAppZoom` + `useClaudeCheck` + `useClaudeCodePanelResize`（孤立しているので最速で抽出可）
2. `useGitStatus` + `useSessions` + `useTeamHistory`（副作用が小さく、初期ロードで埋めるだけ）
3. `useDiffEditorTabs`（`refreshGit` だけ外から貰えば独立）
4. `useTerminalTabs`（`teams`/`teamHubInfo` を引数で受ける方針）
5. `useTeamManager`（`useTerminalTabs` と `useTeamHistory` の API を合成）
6. `useProjectLoader`（ここまでの hook の reset API を集約）
7. `useCommandPalette` + `useKeyboardShortcuts`（全部揃ってから最後に）
8. 子コンポーネント切り出し（`ClaudeCodePanel` / `TerminalPane`）

1〜2 は各 1 コミット、3〜6 はそれぞれ独立コミットにできる。7 は大きいので 2 分割推奨（palette / shortcut）。

---

## 7. 所見サマリ

- `App.tsx` は **11 個のロジックグループ**と **14 個以上の useCallback/useEffect**が同居しているため、機械的に抽出するだけでも 1928 行 → 400 行前後まで圧縮可能。
- **真の困難ポイントは useTerminalTabs ⇔ useTeamManager の双方向依存**。hook 宣言順序と引数方向を固定すれば循環は回避できる。
- `loadProject` は hook を跨ぐ reset を全て背負っており、抽出時に**最大の注意**が必要。各 hook に `resetForProjectChange()` を持たせ、`useProjectLoader` が集約する設計が事故を減らす。
- `commands` useMemo と keyboard shortcut useEffect は**どの抽出戦略を採っても依存が広い**ので、他の hook が全部揃った最後に触るのが正解。
- render 部の `<ClaudeCodePanel>` と `terminalTabs.map` の中身は、hook 抽出と並行して**子コンポーネント化**すると App.tsx 本体がさらに半減する。
