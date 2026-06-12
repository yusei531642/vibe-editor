// Issue #931: spawn 失敗エラーの binary-missing 判定 (classifySpawnPhase) の回帰テスト。
import { describe, expect, it } from 'vitest';
import { classifySpawnPhase } from '../use-terminal-spawn';

describe('classifySpawnPhase (Issue #931)', () => {
  it('Windows resolve のロケール非依存メッセージを engine_binary_missing に分類する', () => {
    // pty/session/windows_resolve.rs が返す英語ハードコードメッセージ。
    // 従来は spawn に誤分類されていた回帰を固定する。
    expect(
      classifySpawnPhase('command executable was not found: claude (searched 12 PATH entries)')
    ).toBe('engine_binary_missing');
    expect(classifySpawnPhase('command executable was not found: codex')).toBe(
      'engine_binary_missing'
    );
  });

  it('OS / which 由来の binary-missing メッセージも従来どおり分類する', () => {
    for (const msg of [
      'ENOENT: no such file or directory',
      'No such file or directory (os error 2)',
      'The system cannot find the file specified',
      'cannot find binary path',
      'program not found',
      'command not found',
      "'claude' is not recognized as an internal or external command",
      '指定されたファイルが見つかりません。'
    ]) {
      expect(classifySpawnPhase(msg)).toBe('engine_binary_missing');
    }
  });

  it('binary-missing でない spawn 失敗は spawn に分類する', () => {
    for (const msg of [
      'Access is denied (os error 5)',
      'failed to allocate pty',
      'permission denied',
      'VIBE_ env filtered out a required variable'
    ]) {
      expect(classifySpawnPhase(msg)).toBe('spawn');
    }
  });
});
