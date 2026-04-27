/**
 * RoleProfilesContext — built-in + ~/.vibe-editor/role-profiles.json を合成し、
 * effectiveProfiles として供給する。
 *
 * 合成規則:
 *   1. BUILTIN_ROLE_PROFILES (6 個) からスタート
 *   2. file.overrides[id] でフィールド単位マージ (label / color / prompt 等を user が部分上書き)
 *   3. file.custom[] を追加 (id 衝突は user 側採用 + console.warn)
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode
} from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { safeUnlisten } from './tauri-api';
import type {
  Language,
  RoleProfile,
  RoleProfilesFile
} from '../../../types/shared';
import {
  BUILTIN_ROLE_PROFILES,
  BUILTIN_BY_ID,
  composeWorkerProfile,
  toolsPlaceholder
} from './role-profiles-builtin';

/**
 * Leader が team_create_role / team_recruit(role_definition=...) で動的に作成したワーカーロール。
 * RoleProfilesContext の memory 内 cache に保持され、`compose()` 時に builtin/custom と合成される。
 * 永続化はしない (プロセス再起動で消える) ので、canvas 復元時には Tauri 側 TeamHub にも
 * 再投入する必要がある (現状は recruit-request payload に同梱される dynamicRole 経由で受け取る)。
 */
export interface DynamicRoleEntry {
  /** 通常 snake_case (例: "marketing_chief") */
  id: string;
  /** 表示名 */
  label: string;
  description: string;
  instructions: string;
  instructionsJa?: string;
  /** どのチームスコープか (チーム間で id 衝突を許容するため必要) */
  teamId: string;
}

interface RoleProfilesContextValue {
  /** 合成後の effective profiles (id → profile) */
  byId: Record<string, RoleProfile>;
  /** UI 表示順 (Leader 先頭、ほかは file 順 or builtin 順) */
  ordered: RoleProfile[];
  /** 設定ファイル本体 (overrides / custom / globalPreamble 等) */
  file: RoleProfilesFile;
  /** ファイル全体を保存 */
  saveFile: (next: RoleProfilesFile) => Promise<void>;
  /** id 個別の override を保存 (差分マージ) */
  upsertOverride: (
    id: string,
    patch: Partial<Omit<RoleProfile, 'id' | 'source' | 'schemaVersion'>>
  ) => Promise<void>;
  /** custom (新規) を 1 件追加。既存 id はエラー */
  addCustom: (profile: RoleProfile) => Promise<void>;
  /** custom を 1 件削除 (builtin は削除不可) */
  removeCustom: (id: string) => Promise<void>;
  /** Leader が動的に作ったワーカーロールを byId に登録 (memory only) */
  registerDynamicRole: (entry: DynamicRoleEntry) => void;
  /** 読み込みエラー (UI 通知用) */
  error: string | null;
}

const Ctx = createContext<RoleProfilesContextValue | null>(null);

const EMPTY_FILE: RoleProfilesFile = { schemaVersion: 1, overrides: {}, custom: [] };

function compose(
  file: RoleProfilesFile,
  dynamic: Record<string, DynamicRoleEntry>
): {
  byId: Record<string, RoleProfile>;
  ordered: RoleProfile[];
} {
  const byId: Record<string, RoleProfile> = {};
  // 1. builtin を base に置く
  for (const b of BUILTIN_ROLE_PROFILES) {
    byId[b.id] = { ...b };
  }
  // 2. overrides をフィールド単位マージ
  for (const [id, patch] of Object.entries(file.overrides ?? {})) {
    const base = byId[id];
    if (!base) {
      // builtin に無い id への override は無視 (custom で名乗るべき)
      continue;
    }
    byId[id] = {
      ...base,
      i18n: { ...base.i18n, ...(patch.i18n ?? {}) },
      visual: { ...base.visual, ...(patch.visual ?? {}) },
      prompt: { ...base.prompt, ...(patch.prompt ?? {}) },
      permissions: { ...base.permissions, ...(patch.permissions ?? {}) },
      defaultEngine: patch.defaultEngine ?? base.defaultEngine,
      singleton: patch.singleton ?? base.singleton
    };
  }
  // 3. custom を追加 (id 衝突は user 側採用)
  for (const c of file.custom ?? []) {
    if (byId[c.id]) {
      console.warn(
        `[role-profiles] custom id "${c.id}" collides with built-in. Built-in is overridden.`
      );
    }
    byId[c.id] = { ...c, source: 'user', schemaVersion: 1 };
  }
  // 4. 動的ロール (Leader が team_create_role で作成、または team_recruit(role_definition=...) で同時作成)
  //    builtin / custom と id が衝突したら衝突側を優先 (Tauri 側で reject されるが二重防衛)
  for (const [id, entry] of Object.entries(dynamic)) {
    if (byId[id]) continue;
    byId[id] = composeWorkerProfile({
      id: entry.id,
      label: entry.label,
      description: entry.description,
      instructions: entry.instructions,
      instructionsJa: entry.instructionsJa
    });
  }
  // 順序: leader 先頭 → builtin の元順 → user 追加分 → 動的ロール
  const ordered: RoleProfile[] = [];
  const leader = byId['leader'];
  if (leader) ordered.push(leader);
  for (const b of BUILTIN_ROLE_PROFILES) {
    if (b.id !== 'leader' && byId[b.id]) ordered.push(byId[b.id]);
  }
  for (const c of file.custom ?? []) {
    if (!BUILTIN_BY_ID[c.id]) ordered.push(byId[c.id]);
  }
  for (const id of Object.keys(dynamic)) {
    if (!BUILTIN_BY_ID[id] && !(file.custom ?? []).some((c) => c.id === id)) {
      const p = byId[id];
      if (p) ordered.push(p);
    }
  }
  return { byId, ordered };
}

export function RoleProfilesProvider({ children }: { children: ReactNode }): JSX.Element {
  const [file, setFile] = useState<RoleProfilesFile>(EMPTY_FILE);
  const [error, setError] = useState<string | null>(null);
  /**
   * Leader 動的ロールの memory 内 cache (id → DynamicRoleEntry)。
   * - team:role-created event (team_create_role 経由) で追加される
   * - team:recruit-request event の dynamicRole フィールドでも追加される (1 ステップ採用時)
   * canvas restore 時には useRecruitListener が再投入する想定。
   */
  const [dynamic, setDynamic] = useState<Record<string, DynamicRoleEntry>>({});

  // 起動時に 1 回ロード
  useEffect(() => {
    let cancelled = false;
    void window.api.roleProfiles
      .load()
      .then((loaded) => {
        if (cancelled) return;
        if (loaded && loaded.schemaVersion === 1) {
          setFile({
            schemaVersion: 1,
            overrides: loaded.overrides ?? {},
            custom: loaded.custom ?? [],
            globalPreamble: loaded.globalPreamble,
            messageTagFormat: loaded.messageTagFormat
          });
        }
      })
      .catch((err) => {
        console.warn('[role-profiles] load failed:', err);
        setError(String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Tauri 側 TeamHub からの team:role-created を購読してメモリキャッシュへ反映
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let disposed = false;
    void listen<{
      teamId: string;
      role: {
        id: string;
        label: string;
        description: string;
        instructions: string;
        instructionsJa?: string;
      };
    }>('team:role-created', (e) => {
      if (disposed) return;
      const { role, teamId } = e.payload;
      setDynamic((prev) => ({
        ...prev,
        [role.id]: {
          id: role.id,
          label: role.label,
          description: role.description,
          instructions: role.instructions,
          instructionsJa: role.instructionsJa,
          teamId
        }
      }));
    })
      .then((u) => {
        if (disposed) {
          safeUnlisten(u);
        } else {
          unlisten = u;
        }
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      // unlisten 由来の race 例外 (handlerId undefined) を吸収する。
      safeUnlisten(unlisten);
      unlisten = null;
    };
  }, []);

  const { byId, ordered } = useMemo(() => compose(file, dynamic), [file, dynamic]);

  // Tauri TeamHub に role profile summary を同期 (team_list_role_profiles / permissions 検証用)。
  // 動的ロールは Hub 側で別管理 (team_id スコープ) なので、ここでは builtin / custom だけを送る。
  useEffect(() => {
    const dynamicIds = new Set(Object.keys(dynamic));
    const summary = ordered
      .filter((p) => !dynamicIds.has(p.id))
      .map((p) => ({
        id: p.id,
        labelEn: p.i18n.en.label,
        labelJa: p.i18n.ja?.label,
        descriptionEn: p.i18n.en.description,
        descriptionJa: p.i18n.ja?.description,
        canRecruit: p.permissions.canRecruit,
        canDismiss: p.permissions.canDismiss,
        canAssignTasks: p.permissions.canAssignTasks,
        canCreateRoleProfile: p.permissions.canCreateRoleProfile,
        defaultEngine: p.defaultEngine,
        singleton: !!p.singleton
      }));
    void window.api.app.setRoleProfileSummary(summary).catch((err) => {
      console.warn('[role-profiles] sync to hub failed:', err);
    });
  }, [ordered, dynamic]);

  const saveFile = useCallback(async (next: RoleProfilesFile): Promise<void> => {
    setFile(next);
    try {
      await window.api.roleProfiles.save(next);
    } catch (err) {
      setError(String(err));
      throw err;
    }
  }, []);

  const upsertOverride = useCallback(
    async (id: string, patch: Partial<Omit<RoleProfile, 'id' | 'source' | 'schemaVersion'>>): Promise<void> => {
      const next: RoleProfilesFile = {
        ...file,
        overrides: { ...(file.overrides ?? {}), [id]: { ...(file.overrides?.[id] ?? {}), ...patch } }
      };
      await saveFile(next);
    },
    [file, saveFile]
  );

  const addCustom = useCallback(
    async (profile: RoleProfile): Promise<void> => {
      if (BUILTIN_BY_ID[profile.id]) {
        throw new Error(`id "${profile.id}" is reserved (built-in). Use overrides for built-ins.`);
      }
      if ((file.custom ?? []).some((c) => c.id === profile.id)) {
        throw new Error(`Custom id "${profile.id}" already exists.`);
      }
      const next: RoleProfilesFile = {
        ...file,
        custom: [...(file.custom ?? []), { ...profile, source: 'user', schemaVersion: 1 }]
      };
      await saveFile(next);
    },
    [file, saveFile]
  );

  const removeCustom = useCallback(
    async (id: string): Promise<void> => {
      if (BUILTIN_BY_ID[id]) {
        throw new Error(`Cannot remove built-in profile "${id}". Use overrides instead.`);
      }
      const next: RoleProfilesFile = {
        ...file,
        custom: (file.custom ?? []).filter((c) => c.id !== id)
      };
      await saveFile(next);
    },
    [file, saveFile]
  );

  const registerDynamicRole = useCallback((entry: DynamicRoleEntry): void => {
    setDynamic((prev) => ({ ...prev, [entry.id]: entry }));
  }, []);

  const value: RoleProfilesContextValue = {
    byId,
    ordered,
    file,
    saveFile,
    upsertOverride,
    addCustom,
    removeCustom,
    registerDynamicRole,
    error
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useRoleProfiles(): RoleProfilesContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useRoleProfiles must be used within RoleProfilesProvider');
  return v;
}

/**
 * id が無いとき / built-in にも無いときの「不明ロール」placeholder。
 * プロセスが古い resumeSession で復活したケースで未知 id を踏むことがあるため、無効化せず描画する。
 */
export function fallbackProfile(id: string): RoleProfile {
  return {
    schemaVersion: 1,
    id,
    source: 'user',
    i18n: {
      en: { label: id, description: `Unknown role "${id}"` },
      ja: { label: id, description: `未知のロール "${id}"` }
    },
    visual: { color: '#7a7afd', glyph: id.slice(0, 1).toUpperCase() || '?' },
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

/** language を考慮した label / description */
export function profileText(
  profile: RoleProfile,
  language: Language
): { label: string; description: string } {
  const lang = profile.i18n[language] ?? profile.i18n.en;
  return { label: lang.label, description: lang.description };
}

/** system prompt をテンプレ展開する。
 *  受け取る `members` は { agentId, roleProfileId, agent } のリスト。 */
export function renderSystemPrompt(
  args: {
    profile: RoleProfile;
    profilesById: Record<string, RoleProfile>;
    teamName: string;
    selfAgentId: string;
    members: { agentId: string; roleProfileId: string; agent: 'claude' | 'codex' }[];
    globalPreamble?: { en?: string; ja?: string };
    language: Language;
  }
): string {
  const { profile, profilesById, teamName, selfAgentId, members, globalPreamble, language } = args;
  const tpl =
    language === 'ja' && profile.prompt.templateJa
      ? profile.prompt.templateJa
      : profile.prompt.template;
  if (!tpl) return '';

  const selfText = profileText(profile, language);
  const roster = members
    .map((m) => {
      const p = profilesById[m.roleProfileId] ?? fallbackProfile(m.roleProfileId);
      const label = profileText(p, language).label;
      const engine = m.agent === 'claude' ? 'Claude Code' : 'Codex';
      const youMarker = language === 'ja' ? ' ← あなた' : ' <-- you';
      const isYou = m.agentId === selfAgentId ? youMarker : '';
      return `${label}(${engine})${isYou}`;
    })
    .join(', ');

  const preamble = (language === 'ja' ? globalPreamble?.ja : globalPreamble?.en) ?? '';
  const tools = toolsPlaceholder(language);

  // dynamicInstructions は composeWorkerProfile() の段階で既に template/templateJa に
  // 埋め込み済み。ここでは標準プレースホルダのみを展開する。
  return tpl.replace(
    /\{(teamName|selfLabel|selfDescription|roster|tools|globalPreamble)\}/g,
    (_, key: string) => {
      switch (key) {
        case 'teamName':
          return teamName;
        case 'selfLabel':
          return selfText.label;
        case 'selfDescription':
          return selfText.description;
        case 'roster':
          return roster;
        case 'tools':
          return tools;
        case 'globalPreamble':
          return preamble;
        default:
          return `{${key}}`;
      }
    }
  );
}
