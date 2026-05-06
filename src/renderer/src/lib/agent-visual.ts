import type {
  Language,
  RoleProfile,
  TeamOrganizationMeta
} from '../../../types/shared';
import { fallbackProfile, profileText } from './role-profiles-context';

export interface AgentVisualPayload {
  roleProfileId?: string;
  role?: string;
  organization?: TeamOrganizationMeta;
}

export interface AgentVisual {
  roleProfileId: string;
  profile: RoleProfile;
  label: string;
  description: string;
  glyph: string;
  agentAccent: string;
  organizationAccent: string;
}

export function resolveAgentVisual(
  payload: AgentVisualPayload | undefined,
  profilesById: Record<string, RoleProfile>,
  language: Language
): AgentVisual {
  const roleProfileId = payload?.roleProfileId ?? payload?.role ?? 'leader';
  const profile = profilesById[roleProfileId] ?? fallbackProfile(roleProfileId);
  const text = profileText(profile, language);
  const agentAccent = profile.visual.color;

  return {
    roleProfileId,
    profile,
    label: text.label,
    description: text.description,
    glyph: profile.visual.glyph,
    agentAccent,
    organizationAccent: payload?.organization?.color ?? agentAccent
  };
}
