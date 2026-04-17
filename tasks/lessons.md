# vibe-editor 教訓集

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
