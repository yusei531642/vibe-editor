# Refactor Smoke Test Checklist (Issue #373)

このチェックリストは Issue #373 の Phase 0 〜 Phase 5 の各 PR 完了ごとに手動で回す。
**1 項目でも fail したら revert 候補**。挙動を変えるリファクタは禁止 (issue の不変式参照)。

## 環境
- `npm run dev` で起動 (= `cargo tauri dev`)
- 検証用ワークスペース: 任意の git リポジトリ (例: `F:\vive-editor` 自身)
- Claude CLI が `claudeCommand` 設定で解決可能なこと (未設定なら `ClaudeNotFound` が出るので先に設定)
- ベースライン取得時はクリーンな `~/.vibe-editor/settings.json` 推奨 (もしくは事前に backup)

---

## 1. IDE 初回ターミナルで Claude banner が欠落しない

**過去の回帰**: Issue #285 / PR #291 (pre-subscribe race — `terminal_create` 直後の最初の数百 ms に届く banner 行が drop されていた)

**関連コード**:
- `src/renderer/src/lib/use-pty-session.ts:344-363` (`attemptPreSubscribe`: `onDataReady` / `onExitReady` / `onSessionIdReady` を **`terminal_create` 呼び出し前に** await して張る)
- `src/renderer/src/lib/use-pty-session.ts:530-540` (新規 spawn 経路は `requestedId` を渡して必ず `*Ready` で再 await)
- `src/renderer/src/lib/subscribe-event.ts:8-56` (pre-subscribe パターンの内部実装)
- `src/renderer/src/lib/tauri-api.ts:291` (`onDataReady` 等の wrapper)

**手順**:
1. アプリを完全終了 (タスクトレイからも) し `npm run dev` で fresh 起動。
2. プロジェクトルートを開く (`F:\vive-editor` 等)。
3. ビューモードが **IDE** であることを確認 (Canvas 状態で起動した場合は `Ctrl+Shift+M` で切替)。
4. ターミナルが自動で 1 本立ち上がる (`Claude #1`)。**マウス・キー操作を一切せず** xterm の出力を観察する。
5. Claude Code の起動バナーが表示されきるまで待つ (通常 1〜3 秒)。

**期待結果**:
- バナー先頭の `Welcome to Claude Code` 行から末尾のプロンプト ( `>` または `│` ) まで **1 行も欠けず** に表示される。
- 行頭が「途中文字列から」始まる現象 (例: `come to Claude Code`) が無い。
- ANSI 色制御が崩れず、枠線が正しく描画される。

**Pass 判定**: [ ] OK / [ ] NG (NG の場合は当該 PR を revert)

---

## 2. Canvas モードで agent ノードを立ち上げ → 初回出力が出る

**過去の回帰**: Canvas モード固有の spawn 経路で `requestedId` を渡し忘れると Issue #285 と同型の race が再発する。

**関連コード**:
- `src/renderer/src/layouts/CanvasLayout.tsx:119-145` (CanvasLayout を常時マウント、`isCanvasActive` で表示制御)
- `src/renderer/src/components/canvas/cards/AgentNodeCard.tsx:175` (Issue #342 Phase 1: recruit 経路の ack コールバック)
- `src/renderer/src/lib/use-terminal-spawn.ts` (Canvas 経由の spawn ヘルパ)
- `src/renderer/src/lib/use-pty-session.ts:344-363` (pre-subscribe 経路は IDE と共通)

**手順**:
1. 起動後、IDE モードであれば `Ctrl+Shift+M` で **Canvas モード**に切替。
2. キャンバス上で右クリック → **Add Card** → `Claude` (or `Codex`) agent を選択して 1 枚追加。または preset spawn ボタンを使う。
3. 追加された AgentNodeCard 内の埋め込み xterm を観察する。

**期待結果**:
- カード内 xterm に **数秒以内に** Claude Code バナーが流れ始める (黒画面のままにならない)。
- バナーの 1 行目から表示される (途中欠落なし)。
- カードのステータス表示が `starting` → `running` (or 同等の表示) に遷移する。

**Pass 判定**: [ ] OK / [ ] NG

---

## 3. Canvas ↔ IDE 切替で PTY が生存する

**過去の回帰**: 旧実装では `viewMode === 'canvas'` のときだけ `CanvasLayout` をマウントしていたため、IDE→Canvas→IDE と切替えると `AgentNodeCard` が unmount → `usePtySession` cleanup が走り PTY が kill されて Claude セッションが全消失。`CanvasLayout` を常時マウント + `display:none` で解決済み。

**関連コード**:
- `src/renderer/src/layouts/CanvasLayout.tsx:119-126` (常時マウント + `isCanvasActive` flag、コメントに経緯あり)
- `src/renderer/src/lib/use-pty-session.ts:550-557` (HMR remount 用 `ptyId` と世代番号を退避)
- `src/renderer/src/App.tsx:254-257` (App 側も裏でマウントされる前提でガード)

**手順**:
1. Canvas モードで Claude agent カードを 1 枚立ち上げ、バナー表示を待つ。
2. xterm に短いコマンドを入力 (例: `echo hello` を Claude プロンプトに送る、または bash 系なら `echo hello`)。応答が返ってきたことを確認。
3. `Ctrl+Shift+M` で **IDE モードに切替**。IDE 側のターミナルタブを 1 つ開いてバナー表示まで待つ。
4. 再度 `Ctrl+Shift+M` で **Canvas モードに戻る**。
5. 元のカード xterm の状態を確認する。
6. もう 1 度 `Ctrl+Shift+M` でトグルを 2〜3 往復する。

**期待結果**:
- Canvas に戻ったとき、元のカードの xterm 内容 (バナー + 入力履歴 + 応答) が **そのまま残っている**。
- カードのプロンプトが live なまま (新しいコマンドを送れる)。
- IDE 側のターミナルも切替後に黒画面化したり PID が変わったりしない。
- `ps` (or タスクマネージャ) で `claude` プロセス数が切替前後で同じ。

**Pass 判定**: [ ] OK / [ ] NG

---

## 4. 設定モーダルを Canvas / IDE 双方から開閉

**関連コード**:
- `src/renderer/src/App.tsx:258` (`settingsOpen` local state for IDE)
- `src/renderer/src/layouts/CanvasLayout.tsx:151-152` (`useUiStore` の `settingsOpen` / `setSettingsOpen` を Canvas で使用)
- `src/renderer/src/components/SettingsModal.tsx`
- グローバルショートカット: `src/renderer/src/App.tsx:1709-` (`Ctrl+,`)

**手順**:
1. **IDE モード**で `Ctrl+,` を押す → 設定モーダルが開く。テーマや密度を 1 つ変更し、`Esc` で閉じる。変更が即座に反映されるか確認。
2. もう 1 度 `Ctrl+,` で開く → 「設定」タブの中で 2〜3 個別タブを切替できることを確認 → モーダル外側クリックで閉じる。
3. `Ctrl+Shift+M` で **Canvas モード**に切替。
4. Canvas で `Ctrl+,` を押す → 設定モーダルが開く。先ほどの変更が永続化されていることを確認。
5. Canvas のトップバー / Rail にある歯車アイコンからも開閉できることを確認。`Esc` で閉じる。

**期待結果**:
- IDE / Canvas 双方で `Ctrl+,` がモーダルを開く。
- IDE と Canvas で同じ settings state が共有されている (片方で変更した値がもう片方でも見える)。
- 開閉時にフォーカスが奪われたり xterm に文字が誤入力されたりしない。
- モーダルを開いている間、裏の Canvas/IDE が暴走しない (CPU が張り付かない)。

**Pass 判定**: [ ] OK / [ ] NG

---

## 5. HMR (vite reload) で xterm が attach replay される

**過去の回帰**: HMR remount で PTY が新規 spawn され直すと履歴が失われる。`hmrPtyCache` で `ptyId` を退避して attach 経路に切替える設計が崩れると再発。

**関連コード**:
- `src/renderer/src/lib/use-pty-session.ts:550-557` (`hmrPtyCache` への ptyId / generation 退避)
- `src/renderer/src/lib/use-pty-session.ts:561-600` (`attached === true` 時の attach 経路 + replay queue)
- `src/renderer/src/lib/use-pty-session.ts:563-580` (Issue #285 follow-up: snapshot replay → queue flush の順序保証)
- `src/renderer/src/lib/__tests__/use-pty-session-hmr.test.ts` (回帰テスト)

**手順**:
1. `npm run dev` で起動した状態で IDE ターミナルを 1 本開き、Claude にいくつか質問して履歴を作る (3〜5 ターン)。
2. エディタで `src/renderer/src/App.tsx` の **コメント行を 1 行だけ編集** (例: `// hmr test` 追記) して保存 → vite が HMR を発火させる。
3. xterm が再 attach される様子を観察する。
4. Canvas モードでも同じ手順を繰り返す (AgentNodeCard で履歴を作ってから保存トリガ)。

**期待結果**:
- HMR 後、xterm の **scrollback (履歴) が消えない**。
- snapshot replay と新着出力の **順序が逆転しない** (古い banner の途中に新着行が割り込むような表示にならない)。
- PTY プロセス自体は kill されない (PID 据え置き)。
- 「最初の payload を queue に溜め、replay 後に flush」というシーケンスにより、replay 末尾と queue 先頭が一部重複する程度は許容 (xterm が re-render で吸収)。

**Pass 判定**: [ ] OK / [ ] NG

---

## 6. Team recruit → message → dismiss が 1 サイクル完走

**過去の回帰**: Issue #342 Phase 1 — recruit 経路で `terminal_create` が失敗すると Hub に ack されず requester が無限待機。Phase 1 で `recruit-ack.ts` 経由の `ack(false)` を追加して解決済み。

**関連コード**:
- `src/renderer/src/lib/use-recruit-listener.ts:147-234` (recruit listener: 2 段階 requester 探索 → addCard → ack)
- `src/renderer/src/lib/recruit-ack.ts` (ack helper)
- `src/renderer/src/lib/use-terminal-spawn.ts` (spawn helper)
- `src/renderer/src/lib/use-pty-session.ts:520-528` (spawn 失敗時の ack(false) フォールバック)
- `src/renderer/src/components/canvas/cards/AgentNodeCard.tsx:651` (terminal_create 失敗を Hub に ack)
- Rust 側: `src-tauri/src/team_hub/protocol.rs`

**手順**:
1. Canvas モードに切替。
2. **Leader** ロールの Claude agent カードを 1 枚 spawn する (preset の Team や手動で leader 指定)。
3. Leader の xterm にユーザー指示として `programmer ロールを 1 名 recruit して "echo from teammate" と発言させてください` のように入力。
4. Leader が `team_recruit` MCP ツールを呼ぶ → 新しいカードがキャンバス上に出現するのを確認。
5. 新カードの xterm に Claude バナーが表示され、leader からの指示メッセージが `[Team ← leader]` プレフィックス付きで届くのを確認。
6. teammate が応答 → Leader 側で `team_read` 等で受信できることを確認。
7. Leader に `team_dismiss` で teammate を解雇させる → カードが消える / PTY が片付くことを確認。

**期待結果**:
- recruit から 5 秒以内に新カードが Canvas に追加される。
- 新カードの PTY が banner 含めて正常に立ち上がる (Issue #1 と同じ banner チェックを通過)。
- team_send / team_read の 1 往復が成立する。
- dismiss 後、カードが消え PTY プロセスも残らない (タスクマネージャで確認)。
- 過程で Hub から `recruit failed` 系の error が出ていない (出ていれば failure ack が機能していること自体は OK だが、recruit が成功しているはず)。

**Pass 判定**: [ ] OK / [ ] NG

---

## 7. `Ctrl+Shift+M` / `Ctrl+Shift+P` / `Ctrl+,` ショートカット

**関連コード**:
- `src/renderer/src/App.tsx:1699-1707` (Shift+ホイール zoom — 巻き添え検証用)
- `src/renderer/src/App.tsx:1709-` (`useEffect` のグローバル KeyboardEvent ハンドラ)
- `src/renderer/src/stores/ui.ts` (`viewMode` / `setViewMode` / `settingsOpen`)
- CommandPalette: `src/renderer/src/components/CommandPalette.tsx`

**手順**:
1. IDE モードで以下を順に押下し、各回ごとに動作確認:
   - `Ctrl+Shift+P` → コマンドパレット が開く。`Esc` で閉じる。
   - `Ctrl+,` → 設定モーダルが開く。`Esc` で閉じる。
   - `Ctrl+Shift+M` → Canvas モードに切替。
2. Canvas モードで同じ 3 つのショートカットを再度押下:
   - `Ctrl+Shift+P` → コマンドパレットが開く (Canvas 上でも動く)。
   - `Ctrl+,` → 設定モーダルが開く。
   - `Ctrl+Shift+M` → IDE に戻る。
3. macOS 環境でテストする場合は `Cmd+Shift+M` も試す (Ctrl 版と同等に動くべし)。
4. xterm にフォーカスがある状態でも各ショートカットが効くことを確認 (フォーカスを xterm に置いた直後に押下)。

**期待結果**:
- 6 通り (3 ショートカット × 2 モード) すべてで期待通り動く。
- xterm にフォーカスがあっても、ショートカットが xterm に「文字入力」として漏れない (例えば `^M` が xterm に入力されない)。
- 連打しても toggle が一貫する (Canvas↔IDE が往復する、モーダルが二重に開かない)。
- Shift+ホイールの zoom (`webviewZoom`) と干渉しない。

**Pass 判定**: [ ] OK / [ ] NG

---

## 補足: Phase ごとの実施タイミング

| Phase | 必須項目 | 任意項目 |
|---|---|---|
| Phase 0 (本 PR / ベースライン) | 全項目 (#1〜#7) ベースライン取得 | — |
| Phase 1 各 hook 切り出し PR | #1, #4, #7 | #2, #3, #5, #6 |
| Phase 2 (team_hub `protocol.rs` 分解) | #6 | #1, #2 |
| Phase 3 (PTY 境界の整理) | #1, #2, #3, #5 | #4, #7 |
| Phase 4 / 5 (App.tsx 大規模分解 / 仕上げ) | 全項目 (#1〜#7) | — |

## 補足: NG 時の対応
- 該当 PR を `git revert` (force push 禁止)。
- 失敗ログ (xterm 出力 / devtools console / `~/.vibe-editor/logs/`) を Issue #373 に貼って次サイクルの参考にする。
- Phase 0 ベースライン取得時に既に NG な項目は Phase 0 PR 内では修正せず、別 issue として切る (この checklist はあくまで「リファクタで挙動が変わっていないこと」の検証用)。
