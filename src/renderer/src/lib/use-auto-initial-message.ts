import { useEffect, useRef } from 'react';
import { isCliReadyForInput } from './cli-ready-detect';

const SEND_DELAY_MS = 500;
const COOLDOWN_MS = 3000;

/**
 * pty spawn 後に送る `initialMessage` を、CLI の入力待ち状態を検出してから
 * 順番に送出するためのフック。cleanupTimers の回収は cwd/command 再スポーン時と
 * アンマウント時の両方で行う (不変式 #3)。
 *
 * 使い方: `usePtySession` の onData 内で `observeChunk(data)` を呼ぶ。
 *
 * @param spawnKey cwd + command を結合した文字列など。再スポーン時に queue を初期化するために使う。
 */
export function useAutoInitialMessage(options: {
  spawnKey: string;
  initialMessageRef: React.MutableRefObject<string | string[] | undefined>;
  isDisposed: () => boolean;
  writeToPty: (text: string) => void;
}): {
  observeChunk: (data: string) => void;
} {
  const { spawnKey, initialMessageRef, isDisposed, writeToPty } = options;

  const queueRef = useRef<string[]>([]);
  const indexRef = useRef(0);
  const cooldownRef = useRef(false);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  const writeRef = useRef(writeToPty);
  writeRef.current = writeToPty;
  const isDisposedRef = useRef(isDisposed);
  isDisposedRef.current = isDisposed;

  // cwd/command が変わると pty は再起動する。
  // その際にメッセージキューをリセットし、保留中のタイマーも全破棄する。
  useEffect(() => {
    const initMsg = initialMessageRef.current;
    queueRef.current = initMsg
      ? Array.isArray(initMsg)
        ? [...initMsg]
        : [initMsg]
      : [];
    indexRef.current = 0;
    cooldownRef.current = false;
    timersRef.current.forEach(clearTimeout);
    timersRef.current = [];

    return () => {
      // 不変式 #3: 再スポーン / アンマウント時にタイマーを全回収
      timersRef.current.forEach(clearTimeout);
      timersRef.current = [];
    };
    // initialMessageRef は ref なので deps に含めない
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spawnKey]);

  const observeChunk = (data: string): void => {
    if (isDisposedRef.current()) return;
    if (indexRef.current >= queueRef.current.length) return;
    if (cooldownRef.current) return;
    if (!isCliReadyForInput(data)) return;

    cooldownRef.current = true;
    const msg = queueRef.current[indexRef.current++];
    const sendTimer = setTimeout(() => {
      if (!isDisposedRef.current()) {
        // 複数行は 1 行に整形して送信 (Claude Code はブラケットペースト非対応)
        const flat = msg.replace(/\n{2,}/g, ' | ').replace(/\n/g, ' ');
        writeRef.current(flat + '\r');
      }
      // 次のメッセージ送信まで少し待つ (CLI が処理完了するまで)
      const cooldownTimer = setTimeout(() => {
        cooldownRef.current = false;
      }, COOLDOWN_MS);
      timersRef.current.push(cooldownTimer);
    }, SEND_DELAY_MS);
    timersRef.current.push(sendTimer);
  };

  return { observeChunk };
}
