import { findWebContentsById } from './webcontents';

const FLUSH_INTERVAL_MS = 8;

export interface BatchedDataSender {
  push: (chunk: string) => void;
  flush: () => void;
  dispose: () => void;
}

/**
 * pty.onData の細かい呼び出しを 8ms 窓でバッチ化して IPC 送信するヘルパ。
 *
 * 3 つ以上の Claude Code が同時に走る場面では、pty→IPC の send 数が
 * 線形に増えてレンダラ負荷が跳ね上がるため、細切れの出力を 1 回にまとめる。
 * WebContents が破棄されていれば静かに捨てる。
 */
export function createBatchedDataSender(
  webContentsId: number,
  channel: string
): BatchedDataSender {
  let pendingChunks: string[] = [];
  let flushTimer: NodeJS.Timeout | null = null;
  let disposed = false;

  const flush = (): void => {
    flushTimer = null;
    if (pendingChunks.length === 0) return;
    const payload = pendingChunks.join('');
    pendingChunks = [];
    if (disposed) return;
    const wc = findWebContentsById(webContentsId);
    if (wc) {
      wc.send(channel, payload);
    }
  };

  const push = (chunk: string): void => {
    if (disposed) return;
    pendingChunks.push(chunk);
    if (flushTimer === null) {
      flushTimer = setTimeout(flush, FLUSH_INTERVAL_MS);
    }
  };

  const dispose = (): void => {
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    // 保留中のチャンクがあれば最終送信してから閉じる
    if (pendingChunks.length > 0 && !disposed) {
      const payload = pendingChunks.join('');
      pendingChunks = [];
      const wc = findWebContentsById(webContentsId);
      if (wc) wc.send(channel, payload);
    }
    disposed = true;
    pendingChunks = [];
  };

  return { push, flush, dispose };
}
