/**
 * tauri-api/command-error.ts — IPC エラーの共通正規化層 (Issue #737 / #931)
 *
 * Rust 側は `commands/error.rs` の `CommandError` を `Serialize` で
 * **`{ code, message }` の構造化オブジェクト**として返す (Issue #931 で正式契約化)。
 * `code` は machine-readable な失敗分類 (`io` / `parse` / `validation` / `not_found` /
 * `internal` / `authz`、または `retry_*` 等の明示 code)。失敗理由の分岐は **必ず
 * `err.code` で行い**、`err.message` (人間向け表示文字列) への `includes` / `===` /
 * `startsWith` 分岐を書かないこと (#888 の dead branch の轍)。
 *
 * 旧契約 (message 文字列のみ + `{"code":...}` JSON-in-string ハック) のペイロードも
 * `CommandError.from()` が後方互換で解釈する。
 *
 * `@tauri-apps/api` の `invoke()` は Rust 側 `Err` を「シリアライズされた値そのもの」で
 * reject するため、これまで renderer 各所が「string で来るときと object で来るとき」を
 * 場当たり的に処理していた。本モジュールは:
 *   - `CommandError` … 全 IPC 失敗を表す共通 Error subclass。`code` と `message` を必ず持つ。
 *   - `invokeCommand()` … `invoke()` の薄いラッパ。reject を `CommandError` に正規化して
 *     再 throw する。成功時の戻り値・引数は `invoke()` と完全に同一。
 * を提供し、wrapper レベルでエラー型を 1 つに統一する。raw `invoke` の直接 import は
 * eslint `no-restricted-imports` (Issue #931) によりこのファイル以外で禁止されている。
 */
import { invoke, type InvokeArgs } from '@tauri-apps/api/core';

/**
 * すべての IPC コマンド失敗を表す共通 Error。
 *
 * `code` は Rust 側が `{"code":"...","message":"..."}` の JSON 文字列で返した場合のみ非 null。
 * 非構造化エラー (素の message 文字列) の場合は `code === null`。
 * `raw` には reject された元の値を保持する (デバッグ / 後方互換の JSON.parse 用)。
 */
export class CommandError extends Error {
  /** 構造化エラーの machine-readable code。非構造化なら null。 */
  readonly code: string | null;
  /** どの IPC コマンドで失敗したか。 */
  readonly command: string;
  /** reject された元の値 (string / object など)。 */
  readonly raw: unknown;

  constructor(command: string, message: string, code: string | null, raw: unknown) {
    super(message);
    this.name = 'CommandError';
    this.command = command;
    this.code = code;
    this.raw = raw;
  }

  /**
   * `invoke()` の reject 値を `CommandError` に正規化する。
   *
   * - 既に `CommandError` ならそのまま返す。
   * - string なら `{"code":"...","message":"..."}` JSON として parse を試み、成功すれば `code` を立てる。
   *   (Rust の `CommandError` は message 文字列で来るため、JSON でなければ message 全体を使う)
   * - object なら `code` / `message` フィールドを拾う。
   * - それ以外は `String(value)` を message にする。
   */
  static from(command: string, value: unknown): CommandError {
    if (value instanceof CommandError) {
      return value;
    }
    if (typeof value === 'string') {
      // `{"code":"...","message":"..."}` の構造化ペイロードを試行的に parse。
      // 旧来の素の message 文字列はここで parse 失敗 → message 全体をそのまま使う。
      try {
        const parsed: unknown = JSON.parse(value);
        if (parsed && typeof parsed === 'object') {
          const obj = parsed as Record<string, unknown>;
          const code = typeof obj.code === 'string' ? obj.code : null;
          const message = typeof obj.message === 'string' ? obj.message : value;
          if (code !== null) {
            return new CommandError(command, message, code, value);
          }
        }
      } catch {
        // 非 JSON の素の message 文字列。fall through。
      }
      return new CommandError(command, value, null, value);
    }
    if (value && typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      const code = typeof obj.code === 'string' ? obj.code : null;
      const message =
        typeof obj.message === 'string' ? obj.message : JSON.stringify(value);
      return new CommandError(command, message, code, value);
    }
    return new CommandError(command, String(value), null, value);
  }
}

/**
 * `invoke()` の薄いラッパ。reject を必ず `CommandError` に正規化して再 throw する。
 *
 * 成功時の戻り値・引数の渡し方は `invoke()` と完全に同一なので、既存 wrapper の
 * `invoke('cmd', args)` をそのまま `invokeCommand('cmd', args)` に置換できる。
 *
 * 呼び出し側の後方互換 (Issue #737): reject 値の型が「素の string / object」から
 * `CommandError` に変わる。ただし `CommandError` は `Error` のサブクラスであり、
 * `.message` / `String(err)` / `err instanceof Error` のいずれも従来どおり機能する。
 * renderer (`src/renderer/src`) 全体を監査した結果、catch したエラーを文字列特化で
 * 扱う箇所 (`JSON.parse(err)` / `err.startsWith()` / `err.includes()` 等) は 0 件で、
 * 全 caller は generic な error handler を使う。よって本ラッパへの切替で実行時に
 * 壊れる diff 外の呼び出し元は存在しない。
 */
export async function invokeCommand<T>(command: string, args?: InvokeArgs): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (err) {
    throw CommandError.from(command, err);
  }
}
