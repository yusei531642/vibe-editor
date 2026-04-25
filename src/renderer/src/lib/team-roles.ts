/**
 * team-roles.ts (compat shim)
 *
 * 旧 5 種固定 ROLE_META + buildTeamSystemPrompt 時代の API を、
 * RoleProfile ベースの新システムへ薄くブリッジする。
 *
 * - 新規コードは role-profiles-context.tsx の useRoleProfiles + renderSystemPrompt を使う。
 * - ここは「過去にハードコード値で参照していた箇所が壊れない」ためのシム。
 */
import type { Language, RoleProfile, TeamRole } from '../../../types/shared';
import { BUILTIN_BY_ID, BUILTIN_ROLE_PROFILES } from './role-profiles-builtin';
import { fallbackProfile, profileText, renderSystemPrompt } from './role-profiles-context';

export interface RoleMeta {
  role: string;
  label: string;
  description: string;
  /** ノード/エッジ/バッジに使う基底色 (hex) */
  color: string;
  /** 旧 ROLE_META に存在した accent (現在は未使用、互換のため空文字を埋める) */
  accent: string;
  /** 1 文字アバター */
  glyph: string;
}

function profileToMeta(p: RoleProfile, language: Language = 'en'): RoleMeta {
  const text = profileText(p, language);
  return {
    role: p.id,
    label: text.label,
    description: text.description,
    color: p.visual.color,
    accent: p.visual.color,
    glyph: p.visual.glyph
  };
}

/** 後方互換: 旧 5 種 ROLE_META。新コードは useRoleProfiles を使うこと。 */
export const ROLE_META: Record<string, RoleMeta> = Object.fromEntries(
  BUILTIN_ROLE_PROFILES.map((p) => [p.id, profileToMeta(p, 'en')])
);

/** language に応じた meta を返す (古い builtin 5 種だけ対応する旧 API) */
export function roleMetaFor(role: TeamRole, language: Language): RoleMeta {
  const p = BUILTIN_BY_ID[role];
  if (!p) return profileToMeta(fallbackProfile(role), language);
  return profileToMeta(p, language);
}

/**
 * UI 表示順。固定ワーカーロール撤廃に伴い、ビルトインは leader / hr のみ。
 * 動的ロール (Leader が team_recruit で生成) は UI 側でメンバーカード単位に並ぶため、
 * ここには含めない。
 */
export const ROLE_ORDER: TeamRole[] = ['leader', 'hr'];

export interface TeamMemberSeed {
  agentId: string;
  role: TeamRole;
  agent: 'claude' | 'codex';
}

/**
 * @deprecated 新コードは role-profiles-context の renderSystemPrompt を直接使う。
 *             builtin の 5 種を使うレガシー経路のみ維持。
 */
export function buildTeamSystemPrompt(
  selfAgentId: string,
  selfRole: TeamRole,
  teamName: string,
  members: TeamMemberSeed[],
  language: Language = 'en'
): string {
  const profile = BUILTIN_BY_ID[selfRole] ?? fallbackProfile(selfRole);
  const profilesById: Record<string, RoleProfile> = Object.fromEntries(
    BUILTIN_ROLE_PROFILES.map((p) => [p.id, p])
  );
  return renderSystemPrompt({
    profile,
    profilesById,
    teamName,
    selfAgentId,
    members: members.map((m) => ({
      agentId: m.agentId,
      roleProfileId: m.role,
      agent: m.agent
    })),
    globalPreamble: undefined,
    language
  });
}

export function colorOf(role: string | undefined): string {
  if (!role) return '#7a7afd';
  const p = BUILTIN_BY_ID[role];
  return p?.visual.color ?? '#7a7afd';
}

export function metaOf(role: string | undefined): RoleMeta | null {
  if (!role) return null;
  const p = BUILTIN_BY_ID[role];
  if (!p) return null;
  return profileToMeta(p, 'en');
}
