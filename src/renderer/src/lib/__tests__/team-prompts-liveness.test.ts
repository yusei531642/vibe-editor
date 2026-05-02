/**
 * Issue #409: Worker / Leader テンプレに「ACK / 進捗 / 無応答判定ガード」が
 * 確実に埋め込まれていることを保証する回帰テスト。
 *
 * これらの語が消えると Leader が `team_read` 0 件で即時 dismiss する旧挙動に戻り、
 * Issue #409 の root cause が再発する。
 */
import { describe, expect, it } from 'vitest';
import { WORKER_TEMPLATE_EN, WORKER_TEMPLATE_JA, BUILTIN_BY_ID } from '../role-profiles-builtin';

describe('Issue #409: worker template enforces ACK / progress / completion protocol', () => {
  it('English worker template requires ACK + team_update_task on receipt', () => {
    expect(WORKER_TEMPLATE_EN).toMatch(/ACK:/);
    expect(WORKER_TEMPLATE_EN).toMatch(/team_update_task\(N, "in_progress"\)/);
  });

  it('English worker template requires periodic team_status while working', () => {
    expect(WORKER_TEMPLATE_EN).toMatch(/team_status\(/);
    expect(WORKER_TEMPLATE_EN).toMatch(/team_diagnostics/);
  });

  it('English worker template requires done/blocked update on completion', () => {
    expect(WORKER_TEMPLATE_EN).toMatch(/team_update_task\(N, "done"\)/);
    expect(WORKER_TEMPLATE_EN).toMatch(/"blocked"/);
  });

  it('Japanese worker template requires ACK + team_update_task on receipt', () => {
    expect(WORKER_TEMPLATE_JA).toMatch(/ACK:/);
    expect(WORKER_TEMPLATE_JA).toMatch(/team_update_task\(N, "in_progress"\)/);
  });

  it('Japanese worker template requires periodic team_status while working', () => {
    expect(WORKER_TEMPLATE_JA).toMatch(/team_status\(/);
    expect(WORKER_TEMPLATE_JA).toMatch(/team_diagnostics/);
  });

  it('Japanese worker template requires done/blocked update on completion', () => {
    expect(WORKER_TEMPLATE_JA).toMatch(/team_update_task\(N, "done"\)/);
    expect(WORKER_TEMPLATE_JA).toMatch(/"blocked"/);
  });
});

describe('Issue #409: leader template forbids dismiss-on-team_read-zero', () => {
  const leader = BUILTIN_BY_ID['leader'];

  it('leader is registered in builtin profiles', () => {
    expect(leader).toBeTruthy();
  });

  it('English leader template tells the leader not to dismiss on team_read 0 alone', () => {
    const en = leader.prompt.template;
    // do NOT dismiss / team_diagnostics の確認手順 / team_get_tasks の確認 が必要
    expect(en).toMatch(/do NOT dismiss/i);
    expect(en).toMatch(/team_diagnostics/);
    expect(en).toMatch(/team_get_tasks/);
    expect(en).toMatch(/lastSeenAt/);
    // 60 秒で切らない / 数分は待つ ニュアンス
    expect(en).toMatch(/60 seconds|several minutes/);
  });

  it('Japanese leader template embeds the same liveness-judgment guard', () => {
    const ja = leader.prompt.templateJa ?? '';
    expect(ja).toMatch(/team_dismiss/);
    expect(ja).toMatch(/team_diagnostics/);
    expect(ja).toMatch(/team_get_tasks/);
    expect(ja).toMatch(/lastSeenAt/);
    expect(ja).toMatch(/60 秒|数分/);
  });
});
