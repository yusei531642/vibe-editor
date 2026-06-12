import { useCallback, useEffect, useRef, useState } from 'react';
import type { StatusMascotState } from '../status-mascot';

/**
 * 3 分以上ユーザー入力が無ければ `sleep` 状態に上書きする閾値。
 */
const SLEEP_THRESHOLD_MS = 3 * 60 * 1000;
/**
 * `excited` (クリック) 状態の自動復帰時間。
 */
const EXCITED_DURATION_MS = 1200;
/**
 * `done` (タスク完了) 状態の自動復帰時間。
 */
const DONE_DURATION_MS = 1600;
/**
 * 入力イベントによる sleep timer 再予約の throttle。
 * mousemove が高頻度に発火しても、500ms に 1 回しか timer を張り直さない。
 */
const INPUT_TIMER_THROTTLE_MS = 500;

export interface MascotOrchestrator {
  /** 最終的に StatusMascot に渡すべき state */
  state: StatusMascotState;
  /** mascot がクリックされた時に呼ぶ。1.2s だけ `excited` に上書き */
  onMascotClick: () => void;
  /** タスク完了を外部から通知する。1.6s だけ `done` に上書き */
  triggerDone: () => void;
}

interface OneShot {
  state: 'excited' | 'done';
  /** Date.now() 基準の解除時刻 */
  until: number;
}

/**
 * base state (getStatusMascotState の結果) を受け取り、以下の上書きルールを
 * 適用して最終 state を返す:
 *
 *  - `error` は最優先 (oneShot より強い)
 *  - クリックで `excited` (1.2s) / 外部から `triggerDone()` で `done` (1.6s) を
 *    一時的に上書き。base が `error` 以外で base よりも oneShot を優先
 *  - base が `idle` のとき、最後の入力から 3 分超で `sleep` に置き換える
 *
 * 入力監視: window 全体の mousemove / mousedown / keydown / wheel / touchstart で
 * `lastInputAt` を更新し、sleep timer だけを再予約する。入力中に React state を
 * 更新しないことで、AppShell 全体の再レンダーを避ける。
 *
 * Issue #717.
 */
export function useMascotOrchestrator(baseState: StatusMascotState): MascotOrchestrator {
  const lastInputAtRef = useRef<number>(Date.now());
  const lastInputTimerRef = useRef<number>(0);
  const sleepTimerRef = useRef<number | null>(null);
  const baseStateRef = useRef<StatusMascotState>(baseState);
  const oneShotRef = useRef<OneShot | null>(null);
  const sleepingRef = useRef(false);
  const [sleeping, setSleepingState] = useState(false);
  const [oneShot, setOneShot] = useState<OneShot | null>(null);

  baseStateRef.current = baseState;
  oneShotRef.current = oneShot;
  sleepingRef.current = sleeping;

  const clearSleepTimer = useCallback(() => {
    if (sleepTimerRef.current !== null) {
      window.clearTimeout(sleepTimerRef.current);
      sleepTimerRef.current = null;
    }
  }, []);

  const setSleeping = useCallback((next: boolean) => {
    sleepingRef.current = next;
    setSleepingState((prev) => (prev === next ? prev : next));
  }, []);

  const scheduleSleepTimer = useCallback(() => {
    clearSleepTimer();
    if (baseStateRef.current !== 'idle' || sleepingRef.current) return;

    const remaining = SLEEP_THRESHOLD_MS - (Date.now() - lastInputAtRef.current);
    if (remaining <= 0) {
      if (!oneShotRef.current) setSleeping(true);
      return;
    }

    sleepTimerRef.current = window.setTimeout(() => {
      sleepTimerRef.current = null;
      if (baseStateRef.current !== 'idle' || sleepingRef.current) return;

      const nextRemaining = SLEEP_THRESHOLD_MS - (Date.now() - lastInputAtRef.current);
      if (nextRemaining <= 0 && !oneShotRef.current) {
        setSleeping(true);
      } else {
        scheduleSleepTimer();
      }
    }, remaining);
  }, [clearSleepTimer, setSleeping]);

  useEffect(() => {
    if (baseState !== 'idle') {
      setSleeping(false);
      clearSleepTimer();
      return;
    }
    scheduleSleepTimer();
  }, [baseState, clearSleepTimer, scheduleSleepTimer, setSleeping]);

  // 入力監視: lastInputAt 更新 + sleep timer 再予約。React state は sleep 解除時だけ更新する。
  useEffect(() => {
    const mark = (): void => {
      const now = Date.now();
      lastInputAtRef.current = now;
      if (sleepingRef.current) setSleeping(false);
      if (now - lastInputTimerRef.current > INPUT_TIMER_THROTTLE_MS) {
        lastInputTimerRef.current = now;
        scheduleSleepTimer();
      }
    };
    const events: Array<keyof WindowEventMap> = [
      'mousemove',
      'mousedown',
      'keydown',
      'wheel',
      'touchstart'
    ];
    for (const e of events) {
      window.addEventListener(e, mark, { passive: true });
    }
    return () => {
      for (const e of events) {
        window.removeEventListener(e, mark);
      }
      clearSleepTimer();
    };
  }, [clearSleepTimer, scheduleSleepTimer, setSleeping]);

  const onMascotClick = useCallback(() => {
    // クリック自体も「入力」として扱い、sleep を解除
    lastInputAtRef.current = Date.now();
    setSleeping(false);
    scheduleSleepTimer();
    setOneShot({ state: 'excited', until: Date.now() + EXCITED_DURATION_MS });
  }, [scheduleSleepTimer, setSleeping]);

  const triggerDone = useCallback(() => {
    setOneShot({ state: 'done', until: Date.now() + DONE_DURATION_MS });
  }, []);

  // oneShot の自動解除
  useEffect(() => {
    if (!oneShot) {
      scheduleSleepTimer();
      return;
    }
    const remaining = oneShot.until - Date.now();
    if (remaining <= 0) {
      setOneShot(null);
      return;
    }
    const id = window.setTimeout(() => setOneShot(null), remaining);
    return () => window.clearTimeout(id);
  }, [oneShot, scheduleSleepTimer]);

  let state: StatusMascotState = baseState;

  // error は base から最優先 — oneShot で上書きしない (注意を引き続ける)
  if (state !== 'error' && oneShot) {
    state = oneShot.state;
  }

  // base が idle のときだけ、長時間入力なしを sleep に格上げする
  if (state === 'idle' && sleeping) {
    state = 'sleep';
  }

  return { state, onMascotClick, triggerDone };
}
