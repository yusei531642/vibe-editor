# ADR-1: PTY 実装方式 (portable-pty + tokio batcher)

**Status**: Accepted
**Date**: 2026-04-17
**Phase**: 0
**PoC**: `experiments/pty-poc/`

## Context
node-pty を使う Electron 実装から脱却し、Rust 側で PTY を扱う必要がある。Windows の ConPTY 対応が要件。

## Decision
- **portable-pty 0.9** を採用 (Wezterm の作者が保守、最も成熟した Windows ConPTY ラッパ)
- **tokio multi-thread runtime** で読み取りスレッド + バッチャーを並走
- 既存 `pty-data-batcher.ts` の **16ms フラッシュ + 32KB 上限** を Rust で再現
- spawn 側は `CommandBuilder` + `cwd` 設定

## PoC 実証
- ✅ Rust 1.95.0 + MSVC linker で **9.49 秒でコンパイル成功**
- ✅ ConPTY を開いて `cmd.exe` / `whoami` を spawn 可能
- ✅ ConPTY が cursor position query (`\x1b[6n`) を出力 → 真の TTY emulation 動作確認
- ✅ tokio mpsc + interval(16ms) で batcher 動作確認
- ⚠️ Windows ConPTY の EOF propagation は master を明示 drop しないと遅延する場合あり (Phase 1 で `drop(master)` 順序を厳密化)

## Phase 1 への引き継ぎ
- `src-tauri/src/pty/session_registry.rs`: `Mutex<HashMap<String, PtySession>>` (現 `session-registry.ts`)
- `src-tauri/src/pty/batcher.rs`: 本 PoC の batcher コードをそのまま流用
- mpsc → `tauri::ipc::Channel<bytes::Bytes>` に置換
- `pair.master` を struct に保持し、resize/kill 時にメソッド経由
- 子プロセス exit 検出は `child.try_wait()` を 100ms ポーリング

## 却下案
- **conpty-rs**: 単独だと低レベル過ぎ、portable-pty の方が抽象度が適切
- **pty crate (Unix only)**: Windows 非対応で却下
- **node-pty を sidecar として残す**: ハイブリッド戦略の主目的に反する
