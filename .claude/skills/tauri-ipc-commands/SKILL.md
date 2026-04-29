---
name: tauri-ipc-commands
description: vibe-editor で新しい Tauri IPC コマンド (Rust → Renderer) を追加・変更するときに必ず使うチェックリスト skill。`src/types/shared.ts` の型・`src-tauri/src/commands/<領域>.rs` の Rust 構造体 (`#[serde(rename_all = "camelCase")]`)・`src-tauri/src/commands/mod.rs` のモジュール宣言・`src-tauri/src/lib.rs` の `invoke_handler!` 登録・`src/renderer/src/lib/tauri-api.ts` の wrapper の **5 点同期** が外れると runtime エラーや silent 失敗を起こすため、必ずこの skill の手順で進める。ユーザーが「IPC を足す」「invoke を追加」「tauri command を新規」「Rust から呼べるように」「shared.ts に型を足して」「window.api.◯◯ を追加」「Rust ↔ TS の型同期」「emit / listen を追加」「PTY コマンドを追加」「git コマンドを追加」「settings に保存項目を追加」等を言ったとき、また `#[tauri::command]` を新規に書きそうなとき、`commands/<領域>.rs` を編集するときには必ずこの skill を起動すること。
---

# tauri-ipc-commands

vibe-editor で「Rust 側の機能を Renderer から呼べるようにする」ときの **5 点同期チェックリスト**。
1 か所でも漏れると、`window.api.xxx is not a function` / `invoke "xxx" not found` / camelCase ⇄ snake_case の型不一致 / runtime エラーが発生する。

> 既存コマンドは `src-tauri/src/commands/{app,git,terminal,settings,dialog,sessions,team_history,files,fs_watch,atomic_write,role_profiles,vibe_team_skill}.rs`。
> Renderer 側ラッパは `src/renderer/src/lib/tauri-api.ts`。
> 型は `src/types/shared.ts`。

---

## 5 点同期 (どれも必須)

```
┌──────────────────────────────────────────┐
│ 1. src/types/shared.ts                  │  TS 型 (Request / Response, camelCase)
│ 2. src-tauri/src/commands/<領域>.rs     │  Rust 構造体 + #[tauri::command]
│ 3. src-tauri/src/commands/mod.rs        │  pub mod 宣言 (新ファイルを足したとき)
│ 4. src-tauri/src/lib.rs                 │  invoke_handler! に function 名を登録
│ 5. src/renderer/src/lib/tauri-api.ts    │  invoke('xxx', { ... }) wrapper
└──────────────────────────────────────────┘
```

**この順番で書くと最後に typecheck で必ず噛み合う**。逆順に書くと型不一致を検出するタイミングが遅れる。

---

## Step 1: `src/types/shared.ts` に Request / Response 型を追加

camelCase で書く (Rust 側で `#[serde(rename_all = "camelCase")]` するので、TS 側は素直な camelCase)。

```ts
// 例: ファイルのハッシュを取得する hashFile コマンド
export interface HashFileRequest {
  path: string;
  /** sha256 / md5。省略時は sha256 */
  algorithm?: 'sha256' | 'md5';
}

export interface HashFileResult {
  hash: string;
  byteLen: number;
  modifiedMs: number;
}
```

### 既存型の流用判断

- `path` 系は string で書く (Rust 側で `PathBuf` に from する)。
- 「成功 or エラー文字列」は `Result<T, String>` (= TS では throw に化ける) で表す。`{ ok: boolean, ... }` 形式は新規で増やさず、既存の慣例に合わせる。
- バイナリは `Vec<u8>` ↔ `number[]` ではなく **base64 文字列** で渡す (`SavePastedImageResult` など先例あり)。

---

## Step 2: Rust 側 `commands/<領域>.rs` に handler を実装

### 構造体は必ず `#[serde(rename_all = "camelCase")]`

`commands/mod.rs` の冒頭コメントで明文化されている厳守ルール。

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HashFileRequest {
    pub path: String,
    #[serde(default)]
    pub algorithm: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HashFileResult {
    pub hash: String,
    pub byte_len: u64,
    pub modified_ms: i64,
}
```

### 関数シグネチャの流儀

```rust
#[tauri::command]
pub async fn hash_file(req: HashFileRequest) -> Result<HashFileResult, String> {
    // 1. 入力検証 (path traversal / 空文字 / 巨大ファイルへの対処)
    // 2. tokio::fs で非同期読み込み (sync な std::fs はメインスレッドで使わない)
    // 3. エラーは map_err(|e| e.to_string()) で String 化
    let bytes = tokio::fs::read(&req.path).await.map_err(|e| e.to_string())?;
    // ...
    Ok(HashFileResult { /* ... */ })
}
```

### コマンド名の慣習

- snake_case (`hash_file`、`team_history_list`、`session_resume`)。
- 領域 prefix を付ける (`settings_*` / `git_*` / `team_history_*` / `pty_*`)。`mod.rs` の `ping` のような無 prefix は基本やらない。
- AppState (グローバル) を触るなら `tauri::State<'_, AppState>` を引数に。`src-tauri/src/state.rs` 参照。

### よくある罠

- **path 引数を引数 1 個で書きたい誘惑**: `pub async fn hash_file(path: String)` は動くが、後で第 2 引数を増やす際に破壊変更になる。最初から Request 構造体で受ける。
- **同期 IO を `#[tauri::command] pub fn` (非 async) で書く**: メインスレッドをブロックすると UI が固まる。read/write が絡むなら基本 `async`。
- **`Result<T, anyhow::Error>` を直接返す**: serde で死ぬ。必ず `Result<T, String>` に揃える。
- **`#[serde(rename_all = "camelCase")]` 漏れ**: 一見動くが、フィールドが `byte_len` のままだと TS 側 `byteLen` と噛み合わず `undefined`。

---

## Step 3: `commands/mod.rs` への登録 (新ファイルを作ったときのみ)

```rust
// 例: commands/hashing.rs を新規作成したら
pub mod hashing;
```

既存ファイル (`files.rs` など) に追加するなら Step 3 は不要。

---

## Step 4: `src-tauri/src/lib.rs` の `invoke_handler!` に登録

`tauri::generate_handler![...]` の **すべての** 関数を列挙する場所がある。**忘れると invoke 時に `command "xxx" not found` で失敗する**。

```rust
.invoke_handler(tauri::generate_handler![
    commands::ping,
    commands::settings::settings_load,
    commands::settings::settings_save,
    // ...
    commands::hashing::hash_file,   // ← 追加
])
```

> ファイル全体を grep して既存登録の流儀 (フルパス vs `use` 文) に合わせる。途中で書式を変えない。

---

## Step 5: `tauri-api.ts` に wrapper を追加

```ts
import type { HashFileRequest, HashFileResult } from '../../../types/shared';

export const api = {
  // ...
  hashFile(req: HashFileRequest): Promise<HashFileResult> {
    return invoke<HashFileResult>('hash_file', { req });
  },
};
```

### 引数の渡し方の罠

- Tauri は **`invoke('cmd', { 引数名: 値 })` の形** で渡す。Rust 側のパラメータ名と完全一致させる。
- Rust 側 `pub async fn hash_file(req: HashFileRequest)` なら TS 側は `{ req }`。
- パラメータ名が **camelCase でも snake_case でも、Rust 側の引数名そのまま** を使う (Tauri はここだけ rename しない)。
  - 例: Rust 側 `pub async fn x(some_arg: String)` → TS 側 `{ someArg }` で動く (Tauri 2 はパラメータ名は camelCase 化される)。**ただし型と関数名のときは別** — フィールドは `#[serde(rename_all="camelCase")]` で camelCase。
  - 不安なら最初に `tracing::info!` でログを仕込んで実機で受信値を確認する。

### イベント (Rust → Renderer push) の場合

```rust
// Rust 側
app_handle.emit("pty:data", PtyDataEvent { session_id, chunk })?;
```

```ts
// Renderer 側 (tauri-api.ts に subscribe ヘルパを足す)
onPtyData(cb: (e: PtyDataEvent) => void): () => void {
  return subscribeEvent<PtyDataEvent>('pty:data', cb);
}
```

`subscribeEvent` (tauri-api.ts:21-40) は **早期 cleanup の orphan 対策**を含む既存ヘルパ。**直接 `listen()` を呼ばない** — ここを通すこと。

---

## Step 6: 検証

```bash
npm run typecheck
cargo check --manifest-path src-tauri/Cargo.toml
```

両方通らないと噛み合いが取れていない。さらに `npm run dev` で実機起動して、

- `tracing::info!` のログが Tauri DevTools 側 console に出るか
- 戻り値が JS 側で **camelCase で受け取れているか** (フィールド名を `console.log` で確認)
- エラー時の `Promise.reject(string)` が catch で拾えるか

を 1 度だけ手動確認する (CLAUDE.md「動作の証明」原則)。

---

## やってはいけないこと

- **5 点のうち 1〜2 点だけ書いて typecheck も通したつもりで終える**: invoke_handler! 登録漏れは typecheck では落ちず、起動後 invoke で初めて落ちる。**必ず実機で 1 度呼ぶ**。
- **`#[serde(rename_all = "camelCase")]` を省略**: silent に `undefined` 化して原因不明バグになる。
- **`Result<T, anyhow::Error>` を返す**: 必ず `Result<T, String>` に変換する。
- **`subscribeEvent` を経由せず素の `listen()` を呼ぶ**: 早期 cleanup で orphan listener が残る。
- **既存コマンドの引数を破壊変更する**: 永続化された値 (settings.json の旧スキーマ) と齟齬が出る。Issue #75 の `APP_SETTINGS_SCHEMA_VERSION` に倣って migration を書く。

---

## 既存実装の参照先 (作業前にチラ見すると速い)

- 単純な save/load 例: `src-tauri/src/commands/settings.rs` (atomic_write + Mutex 直列化)
- async + 戻り値構造体例: `src-tauri/src/commands/git.rs`
- イベント emit + State 共有例: `src-tauri/src/commands/terminal.rs` + `src-tauri/src/pty/`
- Mutex 連携 / 並列直列化の罠: settings.rs の SAVE_LOCK (Issue #37)
- Parse 失敗時のバックアップ戦略: settings.rs settings_load (Issue #170)

---

## 関連 skill

- 全体の地図と厳守ワークフロー → **`vibeeditor`** skill
- PR を出すフェーズ → **`pullrequest`** skill
- 設定永続化スキーマを変えるなら → `APP_SETTINGS_SCHEMA_VERSION` の bump も忘れず (vibeeditor 参照)
