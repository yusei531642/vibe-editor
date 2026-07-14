import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  resetTerminalSpawnSchedulerForTest,
  scheduleTerminalSpawn
} from '../terminal-spawn-scheduler';

describe('terminal spawn scheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    resetTerminalSpawnSchedulerForTest();
  });

  afterEach(() => {
    resetTerminalSpawnSchedulerForTest();
    vi.useRealTimers();
  });

  it('paces a 17-card restore burst below the backend 10/s gate', async () => {
    const starts: number[] = [];
    const requests = Array.from({ length: 17 }, () =>
      scheduleTerminalSpawn(async () => {
        starts.push(Date.now());
        return true;
      }, true)
    );

    await vi.advanceTimersByTimeAsync(3_000);
    await Promise.all(requests.map((request) => request.promise));

    expect(starts).toHaveLength(17);
    for (const start of starts) {
      expect(starts.filter((value) => value >= start && value < start + 1_000).length).toBeLessThan(10);
    }
  });

  it('cancels a queued spawn before invoking terminal.create', async () => {
    const blocker = scheduleTerminalSpawn(async () => true, true);
    const task = vi.fn(async () => true);
    const queued = scheduleTerminalSpawn(task, true);
    queued.cancel();

    await vi.advanceTimersByTimeAsync(500);

    await expect(blocker.promise).resolves.toBe(true);
    await expect(queued.promise).resolves.toBeNull();
    expect(task).not.toHaveBeenCalled();
  });

  it('does not pace attach calls', async () => {
    const task = vi.fn(async () => true);
    const attach = scheduleTerminalSpawn(task, false);

    await expect(attach.promise).resolves.toBe(true);
    expect(task).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not discard a spawn result after the task has started', async () => {
    let finish!: (value: string) => void;
    const task = scheduleTerminalSpawn(
      () => new Promise<string>((resolve) => {
        finish = resolve;
      }),
      true
    );

    task.cancel();
    finish('pty-1');

    await expect(task.promise).resolves.toBe('pty-1');
  });
});
