/**
 * Claude Code が生成する新しい jsonl ファイルを検出するウォッチャー。
 *
 * - spawn 直前の session id 集合をスナップショット
 * - 400ms 間隔で差分を見る（最大 20 秒）
 * - 新規ファイルが 1 つでも現れたら先頭を採用
 * - isAlive() が false になったら早期終了
 *
 * session-registry を直接参照しないよう、死活チェックと通知は
 * 呼び出し側が注入するコールバックに任せる。
 */

export interface WatchClaudeSessionOptions {
  projectRoot: string;
  listClaudeSessionIds: (root: string) => Promise<Set<string>>;
  isAlive: () => boolean;
  onSessionFound: (sessionId: string) => void;
  /** デフォルト 400ms。テスト用に短縮可能 */
  intervalMs?: number;
  /** デフォルト 20,000ms */
  maxMs?: number;
}

export async function watchClaudeSession(opts: WatchClaudeSessionOptions): Promise<void> {
  const {
    projectRoot,
    listClaudeSessionIds,
    isAlive,
    onSessionFound,
    intervalMs = 400,
    maxMs = 20_000
  } = opts;

  const before = await listClaudeSessionIds(projectRoot);
  const started = Date.now();

  while (Date.now() - started < maxMs) {
    if (!isAlive()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
    const now = await listClaudeSessionIds(projectRoot);
    const newIds: string[] = [];
    for (const id of now) {
      if (!before.has(id)) newIds.push(id);
    }
    if (newIds.length > 0) {
      // 複数新規が見つかった場合、このウォッチャーに該当しそうなものを選ぶ必要があるが、
      // 単純に先頭を採用する。他は後発ウォッチャーに拾われる。
      onSessionFound(newIds[0]);
      return;
    }
  }
  // タイムアウト。静かに諦める
}
