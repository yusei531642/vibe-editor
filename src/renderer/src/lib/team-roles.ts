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
import { fallbackProfile, profileText } from './role-profiles-context';

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
