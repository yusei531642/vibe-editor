/**
 * CLI (Claude Code / Codex 等) が入力待ち状態に到達したかを文字列チャンクから推定する。
 *
 * - ANSI エスケープシーケンスを除去してから判定する
 * - Claude Code: "? for shortcuts" が描画された直後が準備完了
 * - Codex: "❯" もしくは行頭の "> " を検出する
 */
export function isCliReadyForInput(chunk: string): boolean {
  const stripped = chunk.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
  return (
    stripped.includes('? for shortcuts') ||
    stripped.includes('❯') ||
    /^\s*>\s*$/m.test(stripped)
  );
}
