import { describe, expect, it } from 'vitest';
import type { RoleProfile } from '../../../../types/shared';
import { resolveAgentVisual } from '../agent-visual';

function profile(id: string, color: string, glyph: string, label = id): RoleProfile {
  return {
    schemaVersion: 1,
    id,
    source: 'user',
    i18n: {
      en: { label, description: `${label} role` },
      ja: { label: `${label} ja`, description: `${label} role ja` }
    },
    visual: { color, glyph },
    prompt: { template: '' },
    permissions: {
      canRecruit: false,
      canDismiss: false,
      canAssignTasks: false,
      canCreateRoleProfile: false
    },
    defaultEngine: 'claude'
  };
}

describe('resolveAgentVisual', () => {
  const profiles = {
    leader: profile('leader', '#a78bfa', 'L', 'Leader'),
    reviewer: profile('reviewer', '#22c55e', 'R', 'Reviewer'),
    custom_operator: profile('custom_operator', '#f97316', 'O', 'Operator')
  };

  it('uses roleProfileId before the legacy role field', () => {
    const visual = resolveAgentVisual(
      { roleProfileId: 'reviewer', role: 'leader' },
      profiles,
      'en'
    );

    expect(visual.roleProfileId).toBe('reviewer');
    expect(visual.agentAccent).toBe('#22c55e');
    expect(visual.glyph).toBe('R');
    expect(visual.label).toBe('Reviewer');
  });

  it('keeps custom and dynamic role profile colors instead of falling back to builtin colors', () => {
    const visual = resolveAgentVisual(
      { roleProfileId: 'custom_operator' },
      profiles,
      'en'
    );

    expect(visual.agentAccent).toBe('#f97316');
    expect(visual.organizationAccent).toBe('#f97316');
  });

  it('falls back to the legacy role field for old canvas payloads', () => {
    const visual = resolveAgentVisual({ role: 'leader' }, profiles, 'en');

    expect(visual.roleProfileId).toBe('leader');
    expect(visual.agentAccent).toBe('#a78bfa');
  });

  it('uses organization color only for the organization accent', () => {
    const visual = resolveAgentVisual(
      {
        roleProfileId: 'reviewer',
        organization: {
          id: 'org-1',
          name: 'Org',
          color: '#0ea5e9'
        }
      },
      profiles,
      'en'
    );

    expect(visual.agentAccent).toBe('#22c55e');
    expect(visual.organizationAccent).toBe('#0ea5e9');
  });
});
