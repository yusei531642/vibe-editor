---
name: pty-portable-debugging
description: vibe-editor の PTY (`src-tauri/src/pty/`, portable-pty + xterm.js) のデバッグ・拡張時に必ず使う skill。reader thread / mpsc / batcher (16ms or 32KB) / tauri emit のデータフロー、Windows ConPTY の罠 (環境変数 escape / 親プロセス終了後の zombie / パス区切り)、文字化け対策 (CP932 / Shift_JIS encoding_rs, Issue #120)、外部ファイル変更検出 (sha2 + size + mtime, Issue #119)、SessionRegistry の race condition、resize / kill / writer Mutex の使い分け、claude_watcher (claude session 検出)、画像ペースト (`SavePastedImageResult`) のフロー、xterm 側 deadlock の見分け方をカバー。ユーザーが「ターミナルが固まる」「PTY がハング」「ConPTY」「portable-pty」「Shift_JIS / CP932 文字化け」「外部変更検出が効かない」「resize で落ちる」「画像ペーストが動かない」「Claude セッションが検出されない」「session registry」「batcher」「pty:data event」「writer Mutex」等を言ったとき、また `src-tauri/src/pty/` を触りそうなときには必ずこの skill を起動すること。
---

# pty-portable-debugging

vibe-editor のターミナル基盤 (`src-tauri/src/pty/`) は **portable-pty + 自前 batcher + Tauri emit** という 3 層構造で、Windows / Unix 双方の罠を内部で吸収している。
このレイヤを触る作業 (新機能追加 / デバッグ / 退行修正) はミスのコストが大きいので、必ずこの skill のチェックリストに沿う。

---

## データフロー (これを最初に頭に入れる)

```
                       (1) spawn_session(SpawnOptions)
                              │
                              ▼
     ┌────────────────────────────────┐
     │ portable-pty PtyPair (Windows  │
     │ は ConPTY、Unix は openpty)     │
     └──────┬───────────────────┬─────┘
            │ master read       │ master write
            ▼                   ▲
   ┌──────────────────┐   ┌──────────────────────┐
   │ reader 標準スレ │   │ writer (Mutex 保護) │ ← user_input / paste
   │ ブロッキング read│   └──────────────────────┘
   └────┬─────────────┘
        │ Vec<u8>
        ▼
   mpsc::Sender<...>
        ▼
   ┌──────────────────────────┐
   │ batcher (16ms or 32KB)   │  ← Issue #119 の hash 計算もここ近辺
   └────┬─────────────────────┘
        │ chunked Vec<u8>
        ▼
   tauri::AppHandle::emit("pty:data", ...)
        ▼
   Renderer (xterm.js) — UnlistenFn で購読
```

主要ファイル:

- `src-tauri/src/pty/session.rs` — spawn / lifecycle (SpawnOptions / UserWriteOutcome)
- `src-tauri/src/pty/registry.rs` — SessionRegistry (AppState 経由で共有)
- `src-tauri/src/pty/batcher.rs` — 出力束ね (16ms / 32KB)
- `src-tauri/src/pty/claude_watcher.rs` — Claude Code の session id 検出 (resume 用)
- `src-tauri/src/pty/path_norm.rs` — Windows パス正規化
- `src-tauri/src/commands/terminal.rs` — IPC handler (create / write / resize / kill / paste image)

---

## 触る前に読むべき場所 (順番)

1. `src-tauri/src/pty/mod.rs` の冒頭コメント (設計概要)。
2. 該当機能の既存 IPC handler (`commands/terminal.rs`)。
3. `pty/session.rs` の `spawn_session` 周辺 (lifecycle 全部)。
4. `pty/batcher.rs` (出力タイミング — UI のチラつきや遅延報告はだいたいここ)。

---

## Windows ConPTY の主要な罠

### 1. 環境変数 / 引数の escape

ConPTY (Windows) と Unix PTY で **引数 / 環境変数の解釈が違う**。
特に `args` にスペースを含む文字列を渡すとき、Windows は内部で再 quote される — 既に quote 済みだと double quote になって壊れる。

→ 既存実装 (`session.rs` の `SpawnOptions`) で吸収しているが、新しい spawn パターンを足すなら **Windows 実機でテスト必須**。

### 2. 親プロセス終了後の zombie

WebView 強制終了 / アプリ kill 時に PTY child が孤立する場合がある。
ConPTY job object でグループ kill するか、`Drop` で `kill()` を確実に呼ぶ実装が `session.rs` にあるはず。新 spawn パターンを足すなら **`drop` 時の kill 経路** を必ず動作確認する。

### 3. パス区切り

Windows: `\` / Unix: `/`。`pty/path_norm.rs` が正規化を吸収。
新たに「Renderer から渡された path」を spawn 引数に使うなら **path_norm 経由**。

### 4. CP932 / Shift_JIS 文字化け (Issue #120)

Windows のコンソールはロケールによって CP932 / Shift_JIS で出力する場合がある。
`encoding_rs` でデコードしてから xterm に送る実装が入っている。

新出力経路 (例: 別プロセスをラップ) を足すときも **encoding_rs を経由**して UTF-8 化する。
**生 bytes をそのまま emit すると mojibake が xterm に届く**。

---

## reader / writer / batcher の使い分け

### reader

- **標準スレッド (std::thread)** で動かす — tokio の async read は portable-pty の master reader と相性が悪い (ブロッキング read が tokio scheduler を詰まらせる)。
- 読んだ bytes は `mpsc::Sender` で batcher に送る。

### writer

- **`Arc<Mutex<...>>`** で保護 — 複数経路 (user_input / paste / resize) から書き込まれる可能性がある。
- async から呼ぶなら `tokio::sync::Mutex`、sync から呼ぶなら `parking_lot::Mutex`。**実装の流儀に合わせる**。

### batcher

- **16ms or 32KB に達したら emit** する設計。低遅延と CPU 負荷のバランス点。
- 値を変えるなら **Renderer 側 xterm の rendering FPS** との兼ね合いを見る (体感での確認必須)。
- batcher 内で hash 計算や filter を入れると遅延が伸びる — そういう加工は Renderer 側でやるのが基本。

---

## SessionRegistry の race condition

`pty/registry.rs` の SessionRegistry は AppState 経由で共有される。
**create / kill / lookup が並行する**ため、ロック順序を間違えると deadlock する。

注意:

- `lock()` は **必ず短時間**。spawn / IO の最中にロックを握り続けない。
- session 削除と reader thread 終了は **どちらが先でも安全に**。reader が `RecvError` を見たら自分で片付ける、registry kill が来たらマスターを drop して reader を終わらせる、両経路を許容する設計。
- 新コマンドを足すなら `lock` の hold 時間を最小化する (lookup → clone Arc → unlock の順)。

---

## claude_watcher (Claude Code の session id 検出)

`pty/claude_watcher.rs` は xterm 出力をスキャンして「`Claude Code session: xxxxx` のようなマーカーを拾い、Canvas の `payload.resumeSessionId` に書き込む」役割。

- 出力ストリームを **重複処理しない**: batcher の前で 1 回だけ tap する。
- 検出後は zustand の `setCardPayload` (canvas.ts:46) を IPC 経由でトリガーする。
- 正規表現を変えたら **既存 fixtures (CHANGELOG / issue にスクリーンショットあり)** で再現テストする。

---

## 画像ペースト (`SavePastedImageResult`)

Renderer が clipboard から base64 画像を渡す → Rust 側 `commands/terminal.rs` の handler で temp file に保存 → ファイルパスを返す → Renderer 側で xterm に「`@/path/to/temp.png`」を挿入する流れ。

罠:

- temp file の cleanup は **アプリ終了時にも消える** ように tempdir の中に書く。
- 巨大画像 (10MB 超) はメモリで base64 デコードすると重い。stream で書く。
- Windows のパス区切りに注意 (Renderer 側で `\` を扱える形に正規化)。

---

## 外部ファイル変更検出 (Issue #119)

`commands/files.rs` (または近辺) で sha2 ハッシュ + size + mtime の 3 点比較で外部変更を検出している。

- ハッシュだけ / mtime だけ では誤検出が多い。**3 点 AND** で「変わった可能性」、ハッシュ一致なら「同一」、ハッシュ不一致なら「変わった」を確定。
- watcher (`fs_watch.rs`) 通知と組み合わせる場合、debounce を 500ms 程度入れる (保存中の連続イベントで誤発火を抑える)。

---

## デバッグの第一手 (順序固定)

ターミナル絡みでバグが報告されたとき:

1. **再現条件を狭める**: OS (Win/macOS/Linux)、shell、入力サイズ、文字種 (ASCII か日本語か絵文字か)、resize の有無、画像ペーストの有無。
2. **どの層のバグか切り分け**:
   - `tracing::info!` を spawn / read / batcher / emit / xterm 受信 の各点に仕込む。
   - bytes 数が合わないなら reader / batcher のバグ。
   - bytes は届いてるが画面が壊れているなら xterm レンダリング / encoding (CP932) のバグ。
   - resize 後に黙る → SessionRegistry / writer Mutex / ConPTY resize のバグ。
3. **再現プロジェクト最小化**: `examples/` 相当に持っていく — フルアプリで再現させない。
4. **Windows / Unix 両方で再現**するか確認 (片方だけなら ConPTY / openpty 差を疑う)。

---

## 検証

```bash
cargo check --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml
npm run typecheck
npm run dev
```

実機:

- `cargo tauri dev` で起動 → 複数 PTY タブ同時運用 → resize / paste / 巨大ログ流入 / Ctrl+C → アプリ終了。child が zombie 化していないか (`Get-Process` / `tasklist` で確認)。
- 文字化けは **CP932 出力するコマンド** (`echo こんにちは` を chcp 932 のシェルで) で再現テスト。

---

## やってはいけないこと

- **reader を tokio で書き直す**: portable-pty の API と相性が悪い。標準スレッドのまま。
- **batcher の閾値を雰囲気で変える**: 体感とテストデータ両方で確認してから。
- **registry のロックを長時間保持する**: 即 deadlock の温床。
- **path をそのまま spawn args に渡す**: `path_norm` を必ず通す。
- **生 bytes を emit する**: `encoding_rs` を経由して UTF-8 化してから。
- **resize handler を sync で書く**: ConPTY の resize は数 ms かかることがあり UI を詰まらせる。

---

## 関連 skill

- 全体の地図 / IPC レシピ → **`vibeeditor`** skill
- 新 IPC コマンドを足す → **`tauri-ipc-commands`** skill
- どうしても直らない時 → **`finalfix`** skill (Explore で並列調査して仮説 5 個から)
