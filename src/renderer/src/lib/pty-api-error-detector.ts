/**
 * Issue #1097: claude CLI が「プラン未許可モデルで起動 → API 拒否 →
 * `API error · Retrying`」を繰り返すループを、PTY 出力の read-only 観測で検知する。
 *
 * 設計方針:
 * - **stream は一切改変しない** (観測のみ)。表示 / staircase / 二重出力に影響しない。
 * - **安定部分文字列マッチ**で検知する。claude CLI 側の文言が変わった場合は
 *   「検知しなくなるだけ」で誤動作しない (fail-safe degrade)。
 * - 検知は **セッション中 1 回だけ** 通知する (リトライ毎に通知して煩わせない)。
 *
 * 使い方: `observe(chunk)` を PTY 出力チャンク毎に呼ぶ。初めて API error リトライを
 * 検知したチャンクで `true` を 1 度だけ返す。以降は常に `false`。spawn やり直し時は
 * 新しい detector を作り直すか `reset()` する。
 */

/** チャンク境界をまたぐパターンを拾うための rolling 窓 (文字数)。 */
const WINDOW_CHARS = 4096;

export interface ApiErrorDetector {
  /**
   * PTY 出力チャンクを観測する。今回初めて API error リトライパターンを検知した場合のみ
   * `true` を返す (1 セッション 1 回)。それ以外は `false`。
   */
  observe(chunk: string): boolean;
  /** spawn やり直し等で検知状態をリセットする。 */
  reset(): void;
}

/**
 * `API error` と (`Retrying` または `attempt`) の併出を安定部分文字列で検知する。
 * 例: `API error (Connection error.) · Retrying in 1 seconds… (attempt 1/10)`
 */
function bufferLooksLikeApiErrorRetry(lower: string): boolean {
  return lower.includes('api error') && (lower.includes('retrying') || lower.includes('attempt'));
}

export function createApiErrorDetector(): ApiErrorDetector {
  let buf = '';
  let fired = false;
  return {
    observe(chunk: string): boolean {
      if (fired || !chunk) return false;
      // 大文字小文字を無視して照合。ANSI エスケープは単語内に割り込まないので
      // 部分文字列マッチで十分 (色付けは "API error" の前後にしか入らない)。
      buf = (buf + chunk.toLowerCase()).slice(-WINDOW_CHARS);
      if (bufferLooksLikeApiErrorRetry(buf)) {
        fired = true;
        buf = '';
        return true;
      }
      return false;
    },
    reset(): void {
      buf = '';
      fired = false;
    }
  };
}
