/**
 * use-terminal-spawn — Issue #342 Phase 1
 *
 * recruit 経路で立ったエージェントカードの spawn 失敗を Hub に ack するための
 * 薄いコールバック生成フック。
 *
 * 旧挙動: `terminal_create` IPC が失敗すると `usePtySession` が xterm に
 * `[起動エラー]` を書くだけで Hub には何も返らず、`team_recruit` MCP は
 * 30 秒の handshake timeout を待ってから「the spawned agent failed to handshake」
 * を返していた (事象 2 の主因の 1 つ)。
 *
 * 本フックを使うと:
 *   1. `terminal_create` の失敗を `onSpawnError(error)` で受け取る
 *   2. error 文字列のヒューリスティックで `phase` を `engine_binary_missing` /
 *      `spawn` に分類する (engine binary が PATH に無い ENOENT 系を切り出す)
 *   3. `ackRecruit({ ok: false, reason, phase })` を invoke する
 *   4. Hub は受け取り次第 `cancel_pending_recruit` + `team:recruit-cancelled`
 *      emit を行い、useRecruitListener の cancelled ハンドラ経由で当該カードを
 *      removeCard する (チャネル方向の一意化)
 *
 * agentId / teamId が無い (= recruit 経路で生成されたカードではない) 場合は
 * 何もしない安全側に倒す。Hub も pending 不在を no-op + warn する多層防御だが、
 * 余計な invoke を避けるため renderer 側でも先にガードする。
 */

import { useCallback } from 'react';
import { ackRecruit, type RecruitAckPhase } from './recruit-ack';

/**
 * 「engine binary が PATH に無い」系のエラーを判別するヒューリスティック。
 *
 * portable-pty (`spawn_command`) は OS の CreateProcess / execvp 失敗をそのまま
 * `io::Error` で投げるため、Rust 側から見たエラーメッセージはロケールと OS で
 * バラつく:
 *   - Windows ja-JP: 「指定されたファイルが見つかりません。」
 *   - Windows en-US: "The system cannot find the file specified." / "program not found"
 *   - Unix:          "No such file or directory" / "ENOENT"
 *   - which::which:  "cannot find binary path"
 *
 * 上記のいずれかにマッチすれば `engine_binary_missing` で返す。マッチしなければ
 * 汎用 `spawn` (= PTY allocation failure / 権限エラー / 環境変数 escape 失敗等)
 * として扱う。Phase 1 ではこのヒューリスティックで十分 (Rust 側で構造化エラー化
 * するのは Phase 3 のスコープ)。
 */
function classifySpawnPhase(error: string): RecruitAckPhase {
  const e = error.toLowerCase();
  if (
    e.includes('enoent') ||
    e.includes('no such file or directory') ||
    e.includes('cannot find the file') ||
    e.includes('cannot find binary') ||
    e.includes('program not found') ||
    e.includes('command not found') ||
    e.includes('not recognized') ||
    error.includes('指定されたファイルが見つかりません') ||
    error.includes('ファイルが見つかりません')
  ) {
    return 'engine_binary_missing';
  }
  return 'spawn';
}

/**
 * agentId / teamId が分かっているカード (recruit 経路で立った AgentNode 等) で
 * 使う。返された関数を `<TerminalView onSpawnError={...} />` にそのまま渡す。
 *
 * agentId / teamId のいずれかが空なら no-op を返す。
 *
 * 例:
 * ```tsx
 * const onSpawnError = useRecruitSpawnAck(payload.agentId, payload.teamId);
 * <TerminalView onSpawnError={onSpawnError} ... />
 * ```
 */
export function useRecruitSpawnAck(
  agentId: string | undefined,
  teamId: string | undefined
): (error: string) => void {
  return useCallback(
    (error: string) => {
      if (!agentId || !teamId) {
        // recruit 経路ではない (= 通常タブで開かれた terminal 等)。Hub に ack は不要。
        return;
      }
      const phase = classifySpawnPhase(error);
      // reason は 256 byte 上限を Rust 側で課す予定なので、こちらでも長すぎる
      // エラー文字列は先頭 240 byte に切り詰める (UTF-8 の境界を尊重するため
      // String.prototype.slice ではなく TextEncoder で正確にカウント)。
      const reason = truncateBytes(error, 240);
      void ackRecruit(agentId, teamId, { ok: false, reason, phase }).catch((err) => {
        console.warn('[recruit] ack(spawn-failure) failed', err);
      });
    },
    [agentId, teamId]
  );
}

/** UTF-8 byte 単位で文字列を切り詰める。multi-byte の途中で切らない。 */
function truncateBytes(s: string, maxBytes: number): string {
  const enc = new TextEncoder();
  const buf = enc.encode(s);
  if (buf.length <= maxBytes) return s;
  // maxBytes 以下になる最後の char index を探す
  let bytes = 0;
  let out = '';
  for (const ch of s) {
    const chBytes = enc.encode(ch).length;
    if (bytes + chBytes > maxBytes) break;
    bytes += chBytes;
    out += ch;
  }
  return out;
}
