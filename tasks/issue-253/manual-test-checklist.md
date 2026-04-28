# Issue #253 — 実機 Tauri 手動テストチェックリスト

> Playwright E2E は Tauri 2 アプリで WebDriver 経由になり ROI が低いため、
> 実機 (Windows) での手動チェックリストに縮退。
> Phase 3 (統合検証) で全項目をパスすることを Phase 4 (Go/No-Go) の必須条件にする。

## 前提

- ブランチ: `fix/issue-253-canvas-fit-unscaled`
- ビルド: `npm run dev` (= `cargo tauri dev`)
- OS: Windows 11 (zooyo の自宅 PC で実施想定)
- 旧 persist データを残したまま起動 → v2→v3 migration の自動実行を観察
- DevTools コンソールを開き、`pty.resize` ログを確認しながら進める

## A. 既存ユーザー migration (v2 → v3) の動作

- [ ] **A-1**: v2 で作った旧サイズ (480x320) のカードが、初回起動後に **640x400** に拡大される
- [ ] **A-2**: 手動で 1000x600 にリサイズしていたカードは、サイズ変更されず **1000x600 のまま**
- [ ] **A-3**: 中間サイズ (例 600x320) のカードは、**width=600 のまま、height=400 に拡大**
- [ ] **A-4**: persist v3 後、再起動しても再拡大されない (= migration が冪等)
- [ ] **A-5**: AgentNodeCard を NodeResizer で **480x280 未満には縮められない** (新 NODE_MIN_W/H)

## B. Canvas zoom 0.3 / 1.0 / 1.5 で TUI が崩れない

各 zoom で以下を確認:

- [ ] **B-1 zoom=0.3 (引き気味)**: Codex 起動 → 起動バナー (Anthropic ロゴ ASCII art) が崩れず表示される
- [ ] **B-2 zoom=0.3**: Claude Code 起動 → ヘッダーが折り返しで崩れない
- [ ] **B-3 zoom=1.0 (デフォルト)**: Codex/Claude 共に起動 + プロンプト入力 + Enter で送信できる
- [ ] **B-4 zoom=1.5 (拡大気味)**: Codex/Claude のレスポンス改行が想定通り (cols が過大にならない)
- [ ] **B-5**: zoom を 0.3 → 1.0 → 1.5 と動的に変えても、debounce 100ms 後にレイアウトが追従する
- [ ] **B-6**: DevTools コンソールに `pty.resize` の zoom フィールドが現在の zoom 値を反映している

## C. 初回 spawn 経路 (CRITICAL)

- [ ] **C-1**: Canvas で新規 Codex カードを作成した直後の **最初の描画** で TUI が崩れていない
  - 旧コード (`fit.fit() → term.cols`) では zoom != 1 の状態で初回レンダーが崩れていた
  - S4 の usePtySession 統合で、unscaled な cols/rows が spawn 時に渡るようになった
- [ ] **C-2**: zoom=0.5 のままアプリを再起動 → 起動直後の Codex/Claude TUI が崩れない (再 spawn 経路でも unscaled が効く)

## D. fitView レース対策

- [ ] **D-1**: 起動時、persist された前回 viewport が表示される (zoom も復元される)
- [ ] **D-2**: 起動直後の TerminalCard が崩れずに描画される (旧 fitView による viewport 再計算と spawn のレースが消えている)
- [ ] **D-3**: 全体俯瞰したいときは `KEYS.fitView` キー操作で発動できる

## E. 可観測性ログ (DevTools)

開発ビルド (`npm run dev`) で `import.meta.env.DEV === true`。
DevTools コンソールで `pty.resize` を観察。

- [ ] **E-1**: 各 refit 後にログが出る (フィールド: `cols, rows, zoom, source, cellW, cellH, fallback`)
- [ ] **E-2**: `source: 'unscaled'` が Canvas モードで出力される
- [ ] **E-3**: `fallback: false` が実機で出る (canvas measureText が実測値を返している)
- [ ] **E-4**: IDE モード (TerminalView 単独) では `source: 'fit'` が出る (regression 確認)

## F. IDE モード regression 確認

- [ ] **F-1**: `Ctrl+Shift+M` で IDE モードに切替、ターミナルタブが従来通り fit 動作 (canvas mode の影響なし)
- [ ] **F-2**: フォントサイズ変更 → ターミナルが再 fit してセルサイズが反映
- [ ] **F-3**: テーマ切替 → ターミナル再描画が崩れない

## G. Codex 起動可能性 (FR-S1-011 の継続確認)

S0 で Windows ConstrainedLanguage 起因の Codex 即終了は別 Issue 扱い、と仕切り直したが、
本ブランチで状況が悪化していないことを再確認:

- [ ] **G-1**: Canvas モードで Codex が **起動できる** (PowerShell ConstrainedLanguage で即終了しない)
- [ ] **G-2**: Codex のプロンプト入力 → 応答が表示される (PTY 入出力が機能している)

## H. 既知の制約 / Issue として切り離す項目

- [ ] **H-1**: `RECRUIT_RADIUS=540` は NODE_W=480 想定の値。NODE_W=640 化により recruit 配置が
      若干窮屈になる可能性 → 観察し、問題があれば別 Issue で 720 程度に引き上げる
- [ ] **H-2**: Codex CLI の Windows ConstrainedLanguage 即終了は別 Issue（本 Issue のスコープ外）

---

## 完了条件

A〜G の全項目チェック → Phase 4 Go-判定。
1 項目でも fail なら、対応 Slice (S2-S7) に戻って修正 + 再テスト。
