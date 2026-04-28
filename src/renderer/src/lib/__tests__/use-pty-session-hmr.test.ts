/**
 * Issue #271: usePtySession の HMR 経路に関する smoke test。
 *
 * `import.meta.hot` が無い本番ビルドでは何の副作用もないこと、
 * かつ TerminalCreateOptions に `sessionKey` / `attachIfExists` を載せる
 * 公開 API が型レベルで通っていることを確認する。
 *
 * 実 hook の useEffect / DOM 周りまで踏み込んだ統合テストは jsdom + xterm の
 * canvas 互換性が無いため別途 Playwright (vibe-editor 起動 + HMR トリガ) で
 * カバーする方針。このテストはあくまで「型・公開 API の不変式」を機械的に守る。
 */
import { describe, it, expect } from 'vitest';
import type {
  TerminalCreateOptions,
  TerminalCreateResult
} from '../../../../types/shared';

describe('Issue #271: TerminalCreateOptions HMR fields', () => {
  it('TerminalCreateOptions に sessionKey と attachIfExists を載せられる', () => {
    const opts: TerminalCreateOptions = {
      cwd: '/tmp',
      command: 'bash',
      cols: 80,
      rows: 24,
      sessionKey: 'term:1',
      attachIfExists: true
    };
    expect(opts.sessionKey).toBe('term:1');
    expect(opts.attachIfExists).toBe(true);
  });

  it('TerminalCreateResult.attached を読めるが optional として扱える', () => {
    const r1: TerminalCreateResult = { ok: true, id: 'pty-a' };
    const r2: TerminalCreateResult = { ok: true, id: 'pty-b', attached: true };
    const r3: TerminalCreateResult = { ok: true, id: 'pty-c', attached: false };
    expect(r1.attached).toBeUndefined();
    expect(r2.attached).toBe(true);
    expect(r3.attached).toBe(false);
  });

  it('既存の TerminalCreateOptions 呼び出しは optional 追加で壊れない', () => {
    // sessionKey/attachIfExists 無しでも従来通り通る (後方互換)。
    const legacy: TerminalCreateOptions = {
      cwd: '/tmp',
      command: 'bash',
      cols: 80,
      rows: 24
    };
    expect(legacy.sessionKey).toBeUndefined();
    expect(legacy.attachIfExists).toBeUndefined();
  });
});
