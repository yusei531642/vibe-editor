# vibe-editor 教訓集

## TeamHub / MCP 再発防止 (2026-05-04)

- `team_send` の成功は「recipient terminal への delivery」であり、recipient が読んだ / 着手した ACK ではない。liveness 判定では `lastSeenAt` を delivery で更新しない。
- delivered-but-unread は `team_diagnostics.pendingInbox*` と `stalledInbound` で見えるようにし、Leader 側の判断材料にする。
- standalone Codex / Claude の vibe-team env 未注入は起動失敗にしない。MCP `initialize` と `tools/list` は no-op で返し、session 必須の `tools/call` だけ明示的な tool error にする。
- Codex-only / same-engine のユーザー制約は HR 採用にも引き継ぐ。HR / worker の `team_recruit` では `engine:"codex"` を省略しない。

## ツールチェーン

### winget の Rust パッケージ ID
- ❌ `Microsoft.Rustup` (存在しない)
- ✅ `Rustlang.Rustup` が公式
- 確認コマンド: `winget search rustup`

### Rust on Windows MSVC
- VS 2022 BuildTools が `C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\` にあれば cl.exe が PATH になくても cargo が自動検出 (cc-rs クレート経由)
- bash PATH に cargo は入らないので `/c/Users/yusei/.cargo/bin/cargo.exe` を直接呼ぶ運用

## Tauri 2

### capabilities/ ファイルが必須
- Tauri 2 のデフォルト permissions は **renderer から event listen も許可されない**
- `src-tauri/capabilities/default.json` に最低限 `core:event:default` 等を書く
- 書かないと「Rust 側で `app.emit()` は成功するが renderer の `listen()` が受信しない」状態になる
- デバッグ手がかり: `tracing` で emit 成功ログを取り、`listen` 側だけ無音なら capabilities を疑う

### `cargo tauri dev` のリビルド対象
- src-tauri/src/**/*.rs の変更は自動再ビルド
- **capabilities/*.json の変更は再ビルドされない** → 任意の Rust ファイルを touch して誘発する
- tauri.conf.json も同様（基本 cargo run 単位）

### frontendDist は実在ディレクトリ必須
- `tauri::generate_context!()` がコンパイル時に検証
- vite build 前なら `dist/` を空でも作成しておく必要あり

### debug 中は DevTools 自動オープン
```rust
#[cfg(debug_assertions)]
if let Some(window) = app.get_webview_window("main") {
    window.open_devtools();
}
```

### CreateProcessW の PATHEXT 非対応
- Windows の生 `CreateProcessW` は `claude` を `claude.cmd` に自動解決しない
- Node.js (node-pty) は内部で解決していたが、portable-pty / cmd 直叩きでは未対応
- `which::which("claude")` で事前に絶対パス + 拡張子付きに変換してから spawn する
- エラー: `os error 193` (`%1 は有効な Win32 アプリケーションではありません`)

## PTY / ConPTY

### Windows ConPTY の EOF 挙動
- `portable-pty` で子プロセスが exit してもマスター reader は EOF を返さないことがある
- 対策: `pair.master` を明示 `drop()` してから `reader.read()` の break を待つ
- 関連: wez/wezterm の ConPTY 同期 issue

### ConPTY の cursor query
- 起動直後に `\x1b[6n` (DSR cursor position) が出力される
- これは ConPTY が正しく TTY emulation していることの証拠
- 対話 CLI を spawn する場合はクライアント側で `\x1b[<row>;<col>R` を返す必要あり

### tokio mpsc batcher パターン
- portable-pty reader はブロッキング → `std::thread::spawn` で読み取り
- mpsc::unbounded_channel で tokio runtime に橋渡し
- batcher は `select!` で `tick(16ms)` と `recv()` を待ち、`32KB` か timer で flush
- emit は `app.emit("terminal:data:{id}", String::from_utf8_lossy(...))`

## ブラウザ / Playwright

### Tauri UI の視覚確認は `npm run dev` を使う
- Vite 直アクセス (`npm run dev:vite`) は `__TAURI_INTERNALS__` が存在しないため、WindowControls や IPC 依存箇所が Tauri 実行時と同じ条件にならない。
- ステータスバー、WebView2、Tauri IPC、ウィンドウフレームに関わる UI は `npm run dev` (`cargo tauri dev`) でネイティブウィンドウを起動して確認する。
- 補助的にブラウザで DOM を確認する場合も、最終判定は Tauri ネイティブウィンドウのログと画面キャプチャで行う。

### Playwright headless の FPS 計測は不正確
- `requestAnimationFrame` がバックグラウンド throttle される (~1Hz)
- パフォーマンス計測は実ブラウザ (chrome --headless=new でも同様) で
- 代替: Chrome DevTools Performance タブ + `performance.now()` の手動サンプリング

### PrintWindow API は WebView2 の GPU compositing を捕えない
- PW_RENDERFULLCONTENT (flag 2) を渡しても WebView2 の Direct Composition で描画された内容は黒く出る
- 解決策: `Graphics.CopyFromScreen` で実画面を撮り、ウィンドウを最前面に持ってきて maximize → 全画面キャプチャ
- AttachThreadInput → SetForegroundWindow → SetWindowPos(HWND_TOPMOST→NOTOPMOST) のテクニックで強制最前面化

## React Flow (`@xyflow/react`)

### v12 でのパッケージ名変更
- 旧: `react-flow-renderer` / `reactflow`
- 新: `@xyflow/react` (v12 から rebrand)
- CSS import: `import '@xyflow/react/dist/style.css';`

### xterm 大量配置時のメモリ
- 1 ノード (xterm + scrollback 500) で約 1MB Heap
- 50 ノードで 50〜80MB Heap → 仮想化で active 5〜6 個に絞る方針が必要
- `onlyRenderVisibleElements` は viewport 外の React node を unmount する → xterm dispose も走るので state 保存戦略が必要 (Phase 4)

## Settings / Default 値

### Rust が `null` を返した時の React 取り扱い
- 旧 Electron: `settings.load()` は未保存時 `DEFAULT_SETTINGS` を返していた
- 新 Tauri: 素直に `Value::Null` を返すと React 側で `null.theme` で TypeError → 全画面崩壊
- `tauri-api.ts` 側で `{ ...DEFAULT_SETTINGS, ...(raw ?? {}) }` で部分マージするのが安全

## Codex CLI Bash 経由起動の安定化

### 症状
- `codex exec ... "$(cat /tmp/prompt.txt)"` を Git Bash 経由で起動した際、1 回目は完走するが 2 回目以降が `Reading additional input from stdin...` の 1 行で止まり exit 127 で死亡。
- 出力末尾に `ERROR codex_core::session: failed to record rollout items: thread <id> not found` が残ることがある。
- 1 回目の出力でも、稀に同じ最終回答が 2 回連続で出る（rollout 失敗 → 内部 retry の副作用）。

### 根本原因（最有力仮説）
1. **Codex の stdin 二重読み仕様** — `codex exec --help` に明記:
   > "If stdin is piped and a prompt is also provided, stdin is appended as a `<stdin>` block."
   引数で prompt を渡しても、stdin がパイプ判定されると EOF まで追加読み込みする。Bash の `"$(cat ...)"` はコマンド置換で「引数」になる一方、Claude Code ハーネス側から起動された Bash 子プロセスは stdin が tty ではなく **未 close の pipe** になっているため、Codex が「stdin もある」と誤判定 → EOF を待ち続けて hang。
2. **PowerShell ConstrainedLanguage 干渉** — Codex は内部で `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8` を発行する。組織ポリシー (AppLocker / WDAC) で ConstrainedLanguage が効いていると `PropertySetterNotSupportedInConstrainedLanguage` で拒否され、Codex が stdin fallback 経路に落ちる原因にもなる。
3. **rollout thread 不整合** — `~/.codex/state_5.sqlite-wal` が肥大 (約 2.5MB) しており、セッション終了処理で rollout の thread が見つからず ERROR。これ自体はクラッシュ要因ではないが、**1 回目の最終回答が 2 重出力される副作用**を起こす。

### How to apply（今後 Codex を Bash から呼ぶときの厳守ルール）
- [ ] **prompt は stdin で渡し、引数を空にする** — `cat /tmp/prompt.txt | codex exec [opts]`。これで「引数あり + stdin」の二重読み判定を完全に避けられる。
- [ ] **どうしても引数で渡したい場合は stdin を明示クローズ** — `codex exec [opts] "$(cat /tmp/prompt.txt)" < /dev/null`。`< /dev/null` を付けて即 EOF を保証する。
- [ ] **`--color never` を付ける** — Bash 経由で ANSI エスケープが混じってログ解析を壊さないため。
- [ ] **`-c tools.shell.enabled=false` の時は PowerShell 系コマンドが拒否される** — Codex 側が `rg` / `git` への自動切替を試みるが、その前に prompt で「PowerShell コマンドを発行しないこと、`rg --files` のみ許可」と明示する。
- [ ] **`~/.codex/state_5.sqlite*` が 5MB を超えたら pre-clean** — 古い rollout を整理。`codex` を完全終了 (`taskkill` 含む) してから `state_5.sqlite-wal` を削除。
- [ ] **長時間 hung を検知するためタイムアウト必須** — `timeout 600 codex exec ...` で 10 分を超えたら強制終了。
- [ ] **同一プロンプトで連続呼び出ししない** — 1 回目で残った rollout state が 2 回目に干渉する。呼び出しの間に最低 2 秒空けるか、`--ephemeral` フラグを使う。

### 即効回避策（今すぐ使える）
```bash
# 推奨: stdin から渡し、ANSI を抑止し、stdin を明示閉じる必要なし
cat /tmp/codex_review_prompt.txt | timeout 600 codex exec \
  --sandbox read-only \
  --color never \
  --ephemeral \
  -c approval_policy='"never"' \
  -c tools.shell.enabled=false \
  --cd "C:/Users/zooyo/Documents/GitHub/vibe-editor"

# やむを得ず引数で渡す場合（stdin を明示クローズ）
codex exec --sandbox read-only --color never --ephemeral \
  -c approval_policy='"never"' \
  --cd "C:/Users/zooyo/Documents/GitHub/vibe-editor" \
  "$(cat /tmp/codex_review_prompt.txt)" < /dev/null
```

### 不確定要素
- exit 127 が「Bash の command not found 規約」由来か Codex 自身の戻り値か未確定。Claude Code ハーネスのプロセス kill 後の表示の可能性が高い (codex 自体は通常 0 / 1 を返す)。
- ConstrainedLanguage の影響度。1 回目は完走したことから「常に致命的」ではなく、「内部 fallback の停止点」と推定。
- 2 回目失敗時のセッションファイルが `~/.codex/sessions/2026/04/28/` に**作られていない**ことから、Codex CLI 起動初期のプロンプト読み込み段階で詰まっており、rollout 機構には到達していない。

## Glass テーマのアクセント背景に白文字を固定しない

- Glass の `--accent` は `#00FFFF` のため、`#fff` / `#fffdf7` / Glass text `#E0E0FF` を重ねるとコントラストが約 1.0〜1.2:1 になり読めない。
- Glass の `--bg` は透明なので、アクセント背景上の文字色として `var(--bg)` を流用しない。
- ボタンやバッジで `background: var(--accent)` を使う場合は、テーマ側から `--accent-foreground` のような専用トークンを流し、Glass では濃色ネイビーを使う。
- テーマ色を調整するときは `themes.ts` の `ThemeVars`、CSS 変数流し込み、対象 CSS、必要なコントラスト検証をセットで確認する。

## Issue #469 - Canvas sidebar width

- IDE と Canvas で同じ `Sidebar` を再利用していても、親レイアウトが Grid から flex に変わると幅制約は引き継がれない。
- 「IDE と同じ幅に合わせる」系の UI 修正では、既存 token の `--shell-sidebar-w` を参照し、別の px 値を直書きしない。
- Canvas 固有の表示不具合は `canvas.css` 側へ局所化し、shared `.sidebar` や `FileTreePanel` へ波及させない。
