const MIN_SPAWN_INTERVAL_MS = 150;

type PendingSpawn<T> = {
  task: () => Promise<T>;
  resolve: (value: T | null) => void;
  reject: (reason: unknown) => void;
  cancelled: boolean;
  started: boolean;
};

const queue: PendingSpawn<unknown>[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let nextStartAt = 0;

function pump(): void {
  if (timer !== null) return;
  while (queue[0]?.cancelled) queue.shift();
  if (queue.length === 0) return;
  const delay = Math.max(0, nextStartAt - Date.now());
  if (delay > 0) {
    timer = setTimeout(() => {
      timer = null;
      pump();
    }, delay);
    return;
  }
  const pending = queue.shift();
  if (!pending) return;
  pending.started = true;
  nextStartAt = Date.now() + MIN_SPAWN_INTERVAL_MS;
  void pending.task().then(pending.resolve, pending.reject);
  pump();
}

export function scheduleTerminalSpawn<T>(
  task: () => Promise<T>,
  paced: boolean
): { promise: Promise<T | null>; cancel: () => void } {
  if (!paced) return { promise: task(), cancel: () => undefined };
  let pending!: PendingSpawn<T>;
  const promise = new Promise<T | null>((resolve, reject) => {
    pending = { task, resolve, reject, cancelled: false, started: false };
    queue.push(pending as PendingSpawn<unknown>);
    pump();
  });
  return {
    promise,
    cancel: () => {
      if (pending.cancelled || pending.started) return;
      pending.cancelled = true;
      pending.resolve(null);
      if (timer !== null && queue.every((item) => item.cancelled)) {
        clearTimeout(timer);
        timer = null;
      }
      pump();
    }
  };
}

export function resetTerminalSpawnSchedulerForTest(): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  queue.splice(0).forEach((pending) => pending.resolve(null));
  nextStartAt = 0;
}
