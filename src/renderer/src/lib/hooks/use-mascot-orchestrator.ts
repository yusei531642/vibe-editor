import { useCallback, useEffect, useRef, useState } from 'react';
import type { StatusMascotState } from '../status-mascot';

/**
 * 3 分以上ユーザー入力が無ければ `sleep` 状態に上書きする閾値。
 */
const SLEEP_THRESHOLD_MS = 3 * 60 * 1000;
/**
 * `sleep` 判定のための tick 間隔。閾値より十分短くする。
 */
const SLEEP_TICK_INTERVAL_MS = 10 * 1000;
/**
 * `excited` (クリック) 状態の自動復帰時間。
 */
const EXCITED_DURATION_MS = 1200;
/**
 * `done` (タスク完了) 状態の自動復帰時間。
 */
const DONE_DURATION_MS = 1600;
/**
 * 入力イベントによる force re-render の throttle。
 * mousemove が高頻度に発火しても、500ms に 1 回しか setState しない。
 */
const INPUT_TICK_THROTTLE_MS = 500;

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
 * 入力監視: window 全体の mousemove / mousedown / keydown / wheel / touchstart を
 * 500ms throttle で `lastInputAt` 更新 + sleep 判定再評価のための tick。
 *
 * Issue #717.
 */
export function useMascotOrchestrator(baseState: StatusMascotState): MascotOrchestrator {
  const lastInputAtRef = useRef<number>(Date.now());
  const lastInputTickRef = useRef<number>(0);
  const [, forceTick] = useState(0);
  const [oneShot, setOneShot] = useState<OneShot | null>(null);

  // 入力監視: lastInputAt 更新 + (throttle して) 再 render
  useEffect(() => {
    const mark = (): void => {
      const now = Date.now();
      lastInputAtRef.current = now;
      if (now - lastInputTickRef.current > INPUT_TICK_THROTTLE_MS) {
        lastInputTickRef.current = now;
        forceTick((n) => n + 1);
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
    };
  }, []);

  // 一定間隔で再 render して sleep 判定を更新する
  useEffect(() => {
    const id = window.setInterval(() => {
      forceTick((n) => n + 1);
    }, SLEEP_TICK_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, []);

  // oneShot の自動解除
  useEffect(() => {
    if (!oneShot) return;
    const remaining = oneShot.until - Date.now();
    if (remaining <= 0) {
      setOneShot(null);
      return;
    }
    const id = window.setTimeout(() => setOneShot(null), remaining);
    return () => window.clearTimeout(id);
  }, [oneShot]);

  const onMascotClick = useCallback(() => {
    // クリック自体も「入力」として扱い、sleep を解除
    lastInputAtRef.current = Date.now();
    setOneShot({ state: 'excited', until: Date.now() + EXCITED_DURATION_MS });
  }, []);

  const triggerDone = useCallback(() => {
    setOneShot({ state: 'done', until: Date.now() + DONE_DURATION_MS });
  }, []);

  let state: StatusMascotState = baseState;

  // error は base から最優先 — oneShot で上書きしない (注意を引き続ける)
  if (state !== 'error' && oneShot) {
    state = oneShot.state;
  }

  // base が idle のときだけ、長時間入力なしを sleep に格上げする
  if (state === 'idle') {
    const idleMs = Date.now() - lastInputAtRef.current;
    if (idleMs >= SLEEP_THRESHOLD_MS) {
      state = 'sleep';
    }
  }

  return { state, onMascotClick, triggerDone };
}
