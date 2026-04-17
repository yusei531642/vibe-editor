# vibe-editor リファクタ計画（planner 調査レポート）

対象: v1.0.0 時点の肥大化した5ファイル + `App.tsx`（researcher 担当）

原則:
- **機能追加は一切しない**。純粋なリファクタ。
- TypeScript strict 維持、IPC 境界（preload/contextBridge）維持、CSS 変数テーマ維持。
- 1 フェーズ = 1 PR 相当。後続フェーズが前フェーズの成果物に依存する直列順序。
- 各フェーズ終了時点で `npm run typecheck` と `npm run build` が通ること。

---

## 1. ファイル別 調査

### 1.1 `src/renderer/src/components/TerminalView.tsx` (454 行)

**責務の肥大化**

`useEffect` 1 本（L89–391、303 行）に以下が全部入っている:

| 塊 | 行 | 内容 |
|---|---|---|
| xterm 初期化 | L96–114 | `new Terminal()` + `FitAddon` + `open` |
| THEMES→xterm テーマ変換 | L93–111 | `claude-dark → selectionBackground` 等。**同じ式が L401–412 の「テーマ変更 effect」にも重複**。 |
| 画像ペースト共通関数 | L117–143 | `insertImageFromBlob`: Blob→base64→`terminal.savePastedImage`→pty 書き込み |
| キーバインディング | L149–194 | Ctrl+C / Ctrl+V（clipboard.read の画像対応 + readText フォールバック） |
| pty spawn + data/exit ハンドラ登録 | L216–304 | `snap` ref 経由スナップショット + `onSessionId`/`onData`/`onExit` |
| CLI ready 検出 + 初期メッセージ順次送信 | L268–291 | `? for shortcuts` / `❯` / `^>\s*$/m` の 3 パターン検出、`sendCooldown` 3 秒、`\n{2,}→ ' | '` 整形 |
| `term.onData` → pty write | L307–311 | ユーザー入力ブリッジ |
| clipboard `paste` DOM イベント | L314–341 | clipboard.read 非対応経路のフォールバック |
| ResizeObserver + rAF スロットル | L344–365 | |
| cleanup | L367–387 | タイマー群 + ResizeObserver + data/exit/sessionId + pty.kill + term.dispose |

さらに effect が 3 本あり、うち 2 本（テーマ変更、visible 切替）で `fit.fit()` + `resize` IPC を呼ぶ同じパターンを書いている。

**抽出単位**

| 抽出先 | 切り出す内容 |
|---|---|
| `lib/xterm-theme.ts` | `buildXtermTheme(themeName) → xtermTheme`。THEMES→xterm マッピングを一元化（重複 2 → 1）。 |
| `lib/cli-ready-detect.ts` | `isCliReadyForInput(chunk) → boolean`。ANSI 除去 + 3 パターン判定の純関数。ユニットテスト可能化。 |
| `lib/paste-image-client.ts` | `insertPastedImageToPty(blob, mime, writePty)`。Blob→base64→`terminal.savePastedImage`→書き込みを完結したヘルパ。 |
| `hooks/use-xterm-instance.ts` | `Terminal` + `FitAddon` 作成、テーマ/フォント反映、dispose。現行 effect のうち init 部と「テーマ変更 effect」を統合。 |
| `hooks/use-pty-session.ts` | `terminal.create` → `id` + `onData`/`onExit`/`onSessionId` 購読、cleanup。`TerminalViewHandle` の `sendCommand`/`focus` もここに寄せる。 |
| `hooks/use-terminal-clipboard.ts` | Ctrl+C/V カスタムキー + `paste` イベント登録。 |
| `hooks/use-auto-initial-message.ts` | `msgQueue` + `sendCooldown` + ready 検出フック。`onData` コールバックから呼ぶ純粋ロジック。 |
| `hooks/use-fit-to-container.ts` | `ResizeObserver` + rAF スロットル + `visible` 切替時の再 fit。 |

最終的に `TerminalView.tsx` は 120 行前後のオーケストレーション層になる想定。

**注意点（破壊してはいけない不変式）**

- `args/env/initialMessage` の snapshot ref（L69–70）。並び替えで pty を巻き添え kill しない防御。
- `eslint-disable-next-line react-hooks/exhaustive-deps` が意図的（L390）。フックに分解しても同じ挙動を守る。
- `cleanupTimers.forEach(clearTimeout)` が setTimeout を必ず回収している（現状の重要な unmount 契約）。

---

### 1.2 `src/renderer/src/components/TeamCreateModal.tsx` (402 行)

**責務の肥大化**

- L7–51: 定数 3 種（AGENTS / MEMBER_ROLES / **BUILTIN_PRESETS**）がコンポーネント直書き。
- L82–143: フォーム state 6 本（teamName/leaderAgent/members/saveAsPreset/presetName/editingPresetId）と 6 つのハンドラ（addMember/removeMember/updateMember/loadPresetForEdit/handleSaveEditedPreset/cancelEdit）が hooks と JSX の間に挟まっている。
- L146–181: 作成系 3 本（handleCreate / handlePresetCreate / handleSavedPresetCreate）がほぼ同じ shape を別々に構築しており重複。
- L183–401: JSX が 1 関数に 220 行。プリセットリスト / カスタムビルダ / 保存セクション / フッタが同居。

**抽出単位**

| 抽出先 | 切り出す内容 |
|---|---|
| `lib/team-presets.ts` | `BUILTIN_PRESETS`, `AGENTS`, `MEMBER_ROLES` 定数 + `presetFromMembers(leaderAgent, members)` 純関数（`[leader, ...members]` 構築の一本化）。 |
| `hooks/use-team-builder.ts` | フォーム state 6 本と 6 つのハンドラを 1 フックに集約。戻り値は `{ form, actions, totalNeeded }`。 |
| `components/team/TeamPresetList.tsx` | builtin + saved プリセットのグリッド。`onPick` / `onEdit` / `onDelete` を props。 |
| `components/team/TeamMemberBuilder.tsx` | Leader 行 + メンバー行リスト + 追加ボタン。 |
| `components/team/TeamSavePresetField.tsx` | saveAsPreset チェック + 名前入力。 |
| `TeamCreateModal.tsx`（残り） | モーダル枠 + セクション配置 + フッタのみ。~120 行想定。 |

**重複の指摘**（Phase 6 訂正済み）

- 当初「4 箇所重複」と記載したが、reviewer 指摘により **実際は構築 2 箇所 + 分解 2 箇所** だった:
  - **構築側 2 箇所**: `handleCreate` / `handleSaveEditedPreset` → `[{agent, role:'leader'}, ...members]` を組み立て
  - **分解側 2 箇所**: `handleSavedPresetCreate` / `loadPresetForEdit` → `members.find(role==='leader')` + `filter(role!=='leader')` で分解
  - `handlePresetCreate` は builtin preset を素通しするだけで構築も分解もしない
- 正しくは `presetFromMembers(leaderAgent, members)` と逆方向の `splitLeaderAndMembers(members)` の 2 ヘルパで集約すべきだった（実装では Phase 4 で採用済み）。
- プリセットカードの「1 + members.length が remaining 超過時 disabled」判定が builtin と saved で二重化。ヘルパ `canSpawnPreset(preset, remaining)` に集約可。

---

### 1.3 `src/renderer/src/components/SettingsModal.tsx` (380 行)

**責務の肥大化**

- L16–53: 定数定義 4 本（THEME_OPTIONS / UI_FONT_PRESETS / EDITOR_FONT_PRESETS / DENSITY_OPTIONS）。
- L73–85: `update`, `handleApply`, `handleReset`。これだけなら hook 化せず素直に残すのが低リスク。
- L87–378: JSX が 290 行の巨大 return。セクション 8 個（言語 / テーマ / UIフォント / エディタフォント / ターミナル / 密度 / Claude 起動 / Codex 起動）。

フォント系 2 セクション（UI / エディタ）と起動オプション 2 セクション（Claude / Codex）は **ほぼ同じ shape の繰り返し** で、主な差はキー名のみ。

**抽出単位**

| 抽出先 | 切り出す内容 |
|---|---|
| `lib/settings-options.ts` | THEME_OPTIONS / FONT_PRESETS（UI/Editor 兼用）/ DENSITY_OPTIONS 定数。 |
| `components/settings/FontFamilySection.tsx` | `<SectionHeader>` + `FONT_PRESETS` select + サイズ数値 + カスタム入力。props: `title`, `familyKey`, `sizeKey`, `draft`, `update`。UI / Editor 両方で使用。 |
| `components/settings/CommandOptionsSection.tsx` | Claude/Codex の command/args/cwd 欄を汎用化。props: `title`, `commandKey`, `argsKey`, `cwdKey?`。 |
| `components/settings/ThemeSection.tsx` | THEME グリッド。 |
| `components/settings/LanguageSection.tsx` | 言語カード 2 枚。 |
| `components/settings/DensitySection.tsx` | 密度カード。 |
| `components/settings/TerminalSection.tsx` | ターミナルフォントサイズ。 |
| `SettingsModal.tsx`（残り） | モーダル枠 + セクション並べる + フッタ。~90 行想定。 |

**重複の指摘**

- UI フォントセクションとエディタフォントセクション（L159–251）はほぼコピペ。`FontFamilySection` 抽出で -60 行相当。
- Claude/Codex 起動オプション（L297–357）も同様で `CommandOptionsSection` により -40 行相当。

---

### 1.4 `src/main/ipc/terminal.ts` (324 行)

**責務の肥大化**

| 塊 | 行 | 内容 |
|---|---|---|
| `nodePty` 動的 require | L17–18 | |
| `Session` 型 + Map 2 つ（`sessions` / `agentSessions`） | L20–32 | 他モジュール（team-hub, sessions）と共有される **module レベルの state**。 |
| `resolveCommand` | L39–70 | Windows 固有の `.cmd`/`.bat`/拡張子無し → `cmd.exe /c` リライト。 |
| `watchClaudeSession` | L80–115 | `~/.claude/projects` 配下 jsonl の差分検出ポーリング（400ms, 20s）。 |
| `registerTerminalIpc` 内の `terminal:create` | L118–220 | spawn + セッション登録 + **8ms バッチ化 flush** + onExit/onData 配線 + ClaudeSession watcher 起動。 |
| `terminal:savePastedImage` | L251–310 | MIME→ext マッピング + 24h TTL 掃除 + タイムスタンプファイル名生成 + base64→buffer 書き出し。 |

**抽出単位**

| 抽出先 | 切り出す内容 |
|---|---|
| `main/lib/resolve-command.ts` | `resolveCommand()` 純関数。テスト可能化。 |
| `main/lib/claude-session-watcher.ts` | `watchClaudeSession()` を 1 関数 export。依存は `listClaudeSessionIds` と `sessions` Map チェック（コールバック化）。 |
| `main/lib/pty-data-batcher.ts` | `createBatchedDataSender(webContentsId, ptyId)`。8ms flush のクロージャを独立化。 |
| `main/lib/paste-image-store.ts` | `savePastedImage(base64, mime)`。MIME→ext、TTL 掃除、ファイル書き出しを内包。 |
| `main/lib/session-registry.ts` | `sessions` / `agentSessions` Map と `Session` 型の所有者。`team-hub.ts` / `ipc/sessions.ts` はここを参照。 |
| `main/lib/webcontents.ts` | `findWebContentsById(id)` ヘルパ。terminal.ts 内 3 箇所 + `updater.ts` 1 箇所で重複する `BrowserWindow.getAllWindows().find(...)?.webContents` を 1 本化。 |
| `ipc/terminal.ts`（残り） | `registerTerminalIpc` の IPC 配線のみ。~130 行想定。 |

**注意**

- `sessions` / `agentSessions` は `team-hub.ts` と `ipc/sessions.ts` から import されている可能性が高い。session-registry 抽出時に全 import 元を追跡して差し替える必要がある（破壊的変更候補）。
- `will-quit` でまとめて kill しているクリーンアップは session-registry 側の責務に移す。

---

### 1.5 `src/main/ipc/app.ts` (272 行)

**責務の肥大化**

1 ファイルに 3 つの論点が同居:

| 塊 | 行 | 内容 |
|---|---|---|
| `checkClaudeAvailable` | L15–44 | PATH 解決（`where`/`which`）。`claude` 前提の名前だが実態は汎用。 |
| 軽量 app handler 群 | L46–74 | `getProjectRoot`, `restart`, `setWindowTitle`, `setZoomLevel` 等。 |
| **Claude MCP 設定書き換え** | L110–147 | `~/.claude.json` の mcpServers を diff して書き換え。 |
| **Codex MCP 設定書き換え** | L151–205 | `~/.codex/config.toml` の TOML 手パース（`removeTomlSection`）+ section 追記。 |
| `setupTeamMcp` / `cleanupTeamMcp` handler | L209–253 | 上記 2 つの setup/cleanup を並行実行。 |
| 後方互換スタブ | L256–272 | `getTeamFilePath`, `getMcpServerPath` 等。 |

**抽出単位**

| 抽出先 | 切り出す内容 |
|---|---|
| `main/lib/check-command.ts` | `checkCommandAvailable(command)`。`ClaudeCheckResult` を汎用名にリネームするかは後述。 |
| `main/lib/mcp-config/claude-mcp.ts` | `setupClaudeMcp()` / `cleanupClaudeMcp()`。`bridgeDesired` を引数で受ける。 |
| `main/lib/mcp-config/codex-mcp.ts` | `setupCodexMcp()` / `cleanupCodexMcp()` / `removeTomlSection()`。 |
| `main/lib/mcp-config/index.ts` | `bridgeDesired(teamHub)` を集約した factory。 |
| `ipc/app.ts`（残り） | IPC 配線のみ。~110 行想定。 |

**重複の指摘**

- `removeTomlSection` は TOML の手パースだがこのファイル内専用。抽出時にテストを付けるかは Phase 6 で判断。
- `BridgeDesired` 型は Claude/Codex 両方の config が「同じ bridge path + env」を共有していることを示しており、現状は各 setup 関数が重複で構築している。Factory 化で一本化。

---

## 2. 既存 `lib/` / `types/` との整合

既存（確認済み）:

- `src/renderer/src/lib/`: `commands.ts`, `i18n.ts`, `language.ts`, `monaco-setup.ts`, `parse-args.ts`, `settings-context.tsx`, `themes.ts`, `toast-context.tsx`, `use-animated-mount.ts`
- `src/types/shared.ts`: AppSettings / ThemeName / Team* / Terminal* 型を集約

方針:

- 新設する renderer 側ユーティリティは **全て `src/renderer/src/lib/` に配置**。フック（`use-*.ts`）も現状の `use-animated-mount.ts` に倣い `lib/` に置くか、コンポーネント化する切り出し先に合わせて `lib/hooks/` を新設する（新設する場合は Phase 0 の最初にディレクトリ作成のみを先に済ませる）。
- 新設する main 側ユーティリティは **新設ディレクトリ `src/main/lib/`** に置く（現状 `src/main/` 直下は `index.ts`, `team-hub.ts`, `updater.ts` のみ、`ipc/` と階層を分ける）。
- `shared.ts` の型追加は極力避ける。現行型で足りる抽出のみを Phase 1–5 で行い、型の再編は researcher の App.tsx 分析と突き合わせてから Phase 6 で行う。
- `THEMES` の利用者が増えないよう、xterm 変換ヘルパ（`buildXtermTheme`）は `lib/xterm-theme.ts` で `themes.ts` を import する形にして一方向依存を保つ。

**改名候補（互換性に影響）**:

- `ClaudeCheckResult` → `CommandCheckResult` にする案（`shared.ts`）。ただし preload IPC 名 `app:checkClaude` は残す前提（破壊的変更を避ける）。型名のみのリネームであればフェーズ 2 の範囲内で実施可能。

---

## 3. コンポーネント横断の重複

| 重複箇所 | 統合先 |
|---|---|
| `TerminalView.tsx` 内の xterm テーマ式 ×2（init / テーマ変更 effect） | `lib/xterm-theme.ts` の `buildXtermTheme()` |
| `TeamCreateModal.tsx` 内の `[{agent:leaderAgent, role:'leader'}, ...members]` 構築 ×4 箇所 | `lib/team-presets.ts` の `presetFromMembers()` |
| `SettingsModal.tsx` の UI/Editor フォントセクション | `FontFamilySection` コンポーネント |
| `SettingsModal.tsx` の Claude/Codex 起動オプション | `CommandOptionsSection` コンポーネント |
| `terminal.ts` の `BrowserWindow.getAllWindows().find(w => w.webContents.id === id)?.webContents` ×3 + `updater.ts` ×1 | `main/lib/webcontents.ts` の `findWebContentsById()` |
| `app.ts` の Claude/Codex bridge 設定構築 | `mcp-config/index.ts` の `bridgeDesired()` factory |

---

## 4. フェーズ分け

順序は「main プロセス側（renderer への影響が局所的）→ renderer 側（モーダルから重い方へ）→ App.tsx 統合」。各フェーズは単独で typecheck + build が通る単位で区切る。

### Phase 0 — 準備（低リスク、0.5 PR 相当）

- `src/main/lib/` ディレクトリ新設（空の `.gitkeep` 等は不要、最初のファイル追加で生える）。
- `src/renderer/src/lib/hooks/` を使うかは採否を決めるだけ。現行の `use-animated-mount.ts` が `lib/` 直下にあるので **`lib/` 直下に `use-*.ts` を増やす方針**で合意する（researcher の App.tsx 分析が大量に hook を生む場合は Phase 6 で再編）。
- `tasks/refactor-plan.md`（本書）と `tasks/refactor-app-analysis.md`（researcher 到着後）を突き合わせ、hook 命名衝突がないことを確認。

**検証**: typecheck / build は不要（ドキュメントのみ）。

### Phase 1 — main 側純関数の抽出（1 PR）

対象: `terminal.ts` と `app.ts` の **副作用のない純関数** を `main/lib/` に切り出す。

- `main/lib/resolve-command.ts` ← `resolveCommand`
- `main/lib/paste-image-store.ts` ← `savePastedImage` 本体（MIME→ext/TTL/ファイル書き出し）
- `main/lib/webcontents.ts` ← `findWebContentsById`
- `main/lib/check-command.ts` ← `checkClaudeAvailable`
- `main/lib/mcp-config/codex-mcp.ts` ← `removeTomlSection` + `setupCodexMcp` + `cleanupCodexMcp`
- `main/lib/mcp-config/claude-mcp.ts` ← `setupClaudeMcp` + `cleanupClaudeMcp`
- `main/lib/mcp-config/index.ts` ← `bridgeDesired()`

`terminal.ts` / `app.ts` はこれらを import して使うのみに切り替える（handler は残す）。**IPC channel 名は一切変更しない**。

**検証**:

- `npm run typecheck` OK
- `npm run build` OK
- 手動: `npm run dev` でターミナル起動 → Claude/Codex 両方 spawn → 画像ペースト → チームモード → `claude mcp list` で `vive-team` が認識されること

**破壊的変更**: なし（module 内関数の移動のみ）。

**実績（完了）**:

- 新規ファイル:
  - `src/main/lib/resolve-command.ts` (34 行)
  - `src/main/lib/paste-image-store.ts` (73 行)
  - `src/main/lib/webcontents.ts` (11 行)
  - `src/main/lib/check-command.ts` (42 行)
  - `src/main/lib/mcp-config/codex-mcp.ts` (65 行)
  - `src/main/lib/mcp-config/claude-mcp.ts` (49 行)
  - `src/main/lib/mcp-config/index.ts` (25 行)
- `BrowserWindow.getAllWindows().find(...)?.webContents` の重複 3 箇所 + `updater.ts` 1 箇所を `findWebContentsById()` に集約。
- reviewer: ✅ 判定。
- 計画との差異: なし。

### Phase 2 — main 側 state / watcher の抽出（1 PR）

対象: `terminal.ts` の state 共有と watcher を分離。

- `main/lib/session-registry.ts` ← `sessions` / `agentSessions` Map + `Session` 型
- `main/lib/claude-session-watcher.ts` ← `watchClaudeSession`
- `main/lib/pty-data-batcher.ts` ← 8ms flush ロジック

`team-hub.ts` と `ipc/sessions.ts` から `sessions` / `agentSessions` を import している箇所を `session-registry.ts` に差し替える。

**検証**:

- typecheck / build OK
- 手動: Full Team 作成 → `team_send` で planner→leader にメッセージ注入が届くこと（session-registry 差し替えが team-hub を壊していないことの確認）
- 手動: Claude Code タブの **session id 検出**（右パネルに resume できる履歴が現れる）

**破壊的変更**: `team-hub.ts` / `ipc/sessions.ts` の import パスが変わる。内部のみ、外部 API に影響なし。

**実績（完了）**:

- 新規ファイル:
  - `src/main/lib/session-registry.ts` (50 行)
  - `src/main/lib/claude-session-watcher.ts` (53 行)
  - `src/main/lib/pty-data-batcher.ts` (63 行)
- `team-hub.ts` / `ipc/sessions.ts` の import 差し替え完了。
- **補修（reviewer 指摘）**: `pty-data-batcher` の `dispose()` 時、pending chunks が残っていると flush されず失われる問題を検出 → `dispose` 内で `clearTimeout` 後に残チャンクを即時 send してから `disposed = true` を立てるよう修正。`onExit` 直前の最後の出力が消えないことを保証。
- reviewer: ✅ 判定（補修後）。
- 計画との差異: pty-data-batcher の dispose 契約が当初計画に無く、補修フェーズで追加。

### Phase 3 — `SettingsModal` の分割（1 PR）

- `lib/settings-options.ts` 新設
- `components/settings/` 新設し `LanguageSection` / `ThemeSection` / `FontFamilySection` / `TerminalSection` / `DensitySection` / `CommandOptionsSection` を切り出す
- `SettingsModal.tsx` はセクションの並びとフッタのみに痩せる

**検証**:

- typecheck / build OK
- 手動: 設定モーダルを開き、全セクションが表示されること、Apply で `settings-context` に反映されること、Reset で `DEFAULT_SETTINGS` に戻ること、言語切替で i18n が即反映されること
- `data-state` アニメーションが壊れていないこと（`useAnimatedMount` はモーダル本体に残すため）

**破壊的変更**: なし。

**実績（完了）**:

- 新規ファイル:
  - `src/renderer/src/lib/settings-options.ts` (40 行)
  - `src/renderer/src/components/settings/types.ts`
  - `src/renderer/src/components/settings/LanguageSection.tsx` (36 行)
  - `src/renderer/src/components/settings/ThemeSection.tsx` (45 行)
  - `src/renderer/src/components/settings/FontFamilySection.tsx` (73 行)
  - `src/renderer/src/components/settings/TerminalSection.tsx` (30 行)
  - `src/renderer/src/components/settings/DensitySection.tsx` (34 行)
  - `src/renderer/src/components/settings/CommandOptionsSection.tsx` (75 行)
- `SettingsModal.tsx`: **380 行 → 137 行 (-243 行)**
- **補修（計画との差異）**: 当初計画では `FONT_PRESETS` を UI/Editor 兼用の 1 配列にまとめる予定だったが、`Noto Sans JP`（UI 用）と `Fira Code`（Editor 用）のように **互いに有意な選択肢が異なる**ため、`UI_FONT_PRESETS` / `EDITOR_FONT_PRESETS` の **2 配列に分離** で実装。`FontFamilySection` が `presets` を props で受け取る汎用コンポーネントになり、意味的に正しい形。
- reviewer: ✅ 判定。

### Phase 4 — `TeamCreateModal` の分割（1 PR）

- `lib/team-presets.ts` 新設（`BUILTIN_PRESETS`, `AGENTS`, `MEMBER_ROLES`, `presetFromMembers`, `canSpawnPreset`）
- `lib/use-team-builder.ts` 新設
- `components/team/` 新設し `TeamPresetList` / `TeamMemberBuilder` / `TeamSavePresetField` を切り出す
- 4 箇所の「leader + members 構築」を `presetFromMembers` に集約

**検証**:

- typecheck / build OK
- 手動: builtin プリセット 3 種（Dev Duo / Full Team / Code Squad）でチーム生成、remaining 不足時の disabled 表示、saved preset の編集/削除、「保存して作成」の 3 パターン（新規 / 既存 saved 編集 / チェック外し作成）

**破壊的変更**: なし。`teamPresets` の JSON shape は維持。

**実績（完了）**:

- 新規ファイル:
  - `src/renderer/src/lib/team-presets.ts` (68 行) — `BUILTIN_PRESETS` / `AGENTS` / `MEMBER_ROLES` / `presetFromMembers` / `splitLeaderAndMembers` / `canSpawnPreset`
  - `src/renderer/src/lib/use-team-builder.ts` (116 行)
  - `src/renderer/src/components/team/TeamPresetList.tsx` (93 行)
  - `src/renderer/src/components/team/TeamMemberBuilder.tsx` (98 行)
  - `src/renderer/src/components/team/TeamSavePresetField.tsx` (43 行)
- `TeamCreateModal.tsx`: **402 行 → 170 行 (-232 行)**
- **計画との差異（reviewer 指摘）**: §1.2 の「4 箇所重複」は実際には構築 2 箇所 (`handleCreate` / `handleSaveEditedPreset`) のみ。残り 2 箇所 (`handleSavedPresetCreate` / `loadPresetForEdit`) は逆方向の分解パス。実装では `presetFromMembers` と `splitLeaderAndMembers` の 2 ヘルパで両方向を集約し、意味的に正しい形で統合。
- reviewer: ✅ 判定。

### Phase 5 — `TerminalView` の分割（1 PR、最重量）

依存関係のため最後に回す:

- `lib/xterm-theme.ts`
- `lib/cli-ready-detect.ts`
- `lib/paste-image-client.ts`
- `lib/use-xterm-instance.ts`
- `lib/use-pty-session.ts`
- `lib/use-terminal-clipboard.ts`
- `lib/use-auto-initial-message.ts`
- `lib/use-fit-to-container.ts`

`TerminalView.tsx` はフック呼び出しと ref forwarding のみの薄いオーケストレーション層に。

**重要な不変式**:

1. `cwd` / `command` が変わらない限り pty を再起動しない（現行 effect の deps が `[cwd, command]` のみ）。フック化後も同じ deps を維持する。
2. `args` / `env` / `initialMessage` の「初回 spawn 時スナップショット」。snap ref に退避するロジックを `use-pty-session` 内に閉じる。
3. `cleanupTimers.forEach(clearTimeout)` の回収タイミング。`use-auto-initial-message` 内で local state として持つ。
4. Ctrl+C は選択時のみコピー、非選択時は SIGINT（`term.attachCustomKeyEventHandler` が `true` を返すパス）。
5. `data-state` animation の `visible → fit` タイミング（30ms setTimeout）。

**検証**:

- typecheck / build OK
- 手動: Claude Code タブ起動 → 初期プロンプト自動送信 → 画像ペースト（Ctrl+V とドラッグ&ドロップ両方）→ Ctrl+C コピー / Ctrl+C 割り込み → タブ並び替えで pty 生存 → テーマ切替で xterm 色追従 → ウィンドウリサイズで fit 追従
- 複数 Claude Code 同時起動（3+）してレンダラ負荷が現状と同等であること（pty-data-batcher が正しく動いていることの確認）

**破壊的変更**: なし。ただし **最もリグレッション発生確率が高い** フェーズなので単独 PR とし、直前で全テーマ + 並び替え + 画像ペーストを手動回帰確認する。

**実績（完了）**:

- 新規ファイル:
  - `src/renderer/src/lib/xterm-theme.ts` (20 行)
  - `src/renderer/src/lib/cli-ready-detect.ts` (15 行)
  - `src/renderer/src/lib/paste-image-client.ts` (38 行)
  - `src/renderer/src/lib/use-xterm-instance.ts` (70 行)
  - `src/renderer/src/lib/use-pty-session.ts` (168 行)
  - `src/renderer/src/lib/use-terminal-clipboard.ts` (135 行)
  - `src/renderer/src/lib/use-auto-initial-message.ts` (83 行)
  - `src/renderer/src/lib/use-fit-to-container.ts` (85 行)
- `TerminalView.tsx`: **454 行 → 183 行 (-271 行)**
- reviewer: ✅ 判定（下記の差分を「現状実害なし」として承認）。
- **計画との差異 — mount-scoped Terminal の挙動差分（reviewer 指摘、未補修）**:
  - 旧実装では 1 本の巨大 `useEffect` で `cwd` / `command` を deps に持ち、これらが変わった瞬間にエフェクトが再走して pty を再起動していた。
  - フック分解後は `use-xterm-instance` が `Terminal` インスタンスの owner になり、`use-pty-session` が `cwd`/`command` を参照する。フック境界を挟むことで **Terminal インスタンスが mount 単位で存続する形**に挙動が変わった。
  - 結果として「同一 `TerminalView` インスタンスのまま `cwd`/`command` が差し替わったとき、旧実装は pty だけ再起動・xterm はそのまま、新実装は**再起動がそもそも発生しない**」という差分が発生する。
  - 現状 **実害なし**: 呼び出し側である App.tsx は `TerminalTab` の `id` を React `key` にしており、**`cwd`/`command` を変えたいときは必ずタブを作り直す（version++ 契約）**ため、同一 mount で差し替わる経路が存在しない。
  - **将来の回帰リスク**: App.tsx を分割して `useTerminalTabManager`（Phase 10）に移す際、この契約を維持しないと壊れる。対策として本計画末尾の「推奨 memo」セクションに `CLAUDE.md` / JSDoc 追記を記載。

### Phase 6 — researcher App.tsx 分析との統合（完了、計画書更新のみ）

- `tasks/refactor-app-analysis.md` を精読し、本計画に以下を反映:
  - Phase 1–5 の実績追記（上記各 Phase 節）
  - Phase 7–14 の新計画起草（下記 §8）
  - Phase 5 hook 群と Phase 7+ hook 群の命名衝突チェック（下記 §9）
  - `CLAUDE.md` / `TerminalView.tsx` JSDoc 追記推奨 memo（下記 §10）
- **計画上の判断**:
  - `types/shared.ts` への追加型は App.tsx 分割中に**必要が生じたときのみ**新設する。`ClaudeCheckResult → CommandCheckResult` のリネームも App.tsx 側で `useClaudeCheck` を抽出する Phase 7 に合わせて実施する（リネームだけで 1 PR を切らない）。
  - researcher 提案の「推奨リファクタ順序」（葉 → 幹 → パレット/ショートカット）を採用し、Phase 7–14 に落とし込んだ。
- reviewer: 計画書更新のみのため判定対象外。

**検証**: 本フェーズは計画書更新のみなのでビルド不要。

---

## 5. 破壊的変更の総括

| フェーズ | 破壊的変更 | 緩和策 |
|---|---|---|
| Phase 1 | なし | — |
| Phase 2 | `sessions` / `agentSessions` の import パス変更（main プロセス内部のみ） | 全 import 元を grep で追跡し同一 PR 内で差し替え |
| Phase 3 | なし | — |
| Phase 4 | なし（`teamPresets` JSON shape 不変） | — |
| Phase 5 | なし（public な `TerminalViewHandle` 不変） | — |
| Phase 6 | 型のリネーム可能性（`ClaudeCheckResult`） | preload チャネル名は維持。型名のみ変更で影響局所化 |

**IPC channel 名は全フェーズで不変**（preload/contextBridge を壊さない原則）。

---

## 6. 検証コマンド共通

```
npm run typecheck   # tsc --noEmit
npm run build       # vite + electron-builder (packaging なし)
npm run dev         # 手動回帰確認
```

各フェーズ完了時に上の 3 つを必ず通す。`npm run dist:win` はリリース直前のみ。

---

## 7. researcher 合流ポイント

researcher から `tasks/refactor-app-analysis.md` が到着したら:

1. App.tsx が参照している `TerminalView` / `TeamCreateModal` / `SettingsModal` の props 変更を Phase 3/4/5 に前もって織り込めないか確認。
2. App.tsx 側で抽出される hook が `lib/` 直下か `lib/hooks/` かの方針を統一。
3. `TerminalView` から切り出す予定のフック（Phase 5）が App.tsx 側でも共有できるなら、命名を共通化して Phase 5 の成果物をそのまま App.tsx 分割で再利用する。
4. Phase 6 で本ファイルに「App.tsx 分割フェーズ（Phase 7, 8, ...）」を追記する。

---

_作成: planner / 2026-04-14_
