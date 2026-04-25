import { useState } from 'react';
import type { TeamMember, TeamPreset, TerminalAgent } from '../../../types/shared';

/**
 * Issue #83: 内部用に安定 uid を持たせる。
 * map key={idx} だと削除や並び替えで入力 state が隣のメンバーに引き継がれてしまう。
 * TeamMember は serialize 対象なので uid は含めず、form state 用だけに付与する。
 */
export interface MemberDraft extends TeamMember {
  _uid: string;
}

let memberUidSeq = 0;
function nextMemberUid(): string {
  memberUidSeq += 1;
  return `m${memberUidSeq}-${Date.now().toString(36)}`;
}

export interface TeamBuilderForm {
  teamName: string;
  leaderAgent: TerminalAgent;
  members: MemberDraft[];
  saveAsPreset: boolean;
  presetName: string;
  editingPresetId: string | null;
}

export interface TeamBuilderActions {
  setTeamName: (v: string) => void;
  setLeaderAgent: (v: TerminalAgent) => void;
  setSaveAsPreset: (v: boolean) => void;
  setPresetName: (v: string) => void;
  setEditingPresetId: (v: string | null) => void;
  addMember: (remaining: number) => void;
  removeMember: (idx: number) => void;
  updateMember: (idx: number, field: keyof TeamMember, value: string) => void;
  loadPresetForEdit: (preset: TeamPreset) => void;
  cancelEdit: () => void;
  resetAfterCreate: () => void;
}

// v3 (architecture rework): 固定ワーカーロールは撤廃。Leader が team_recruit で動的に
// 役職を作る前提なので、TeamCreateModal が事前に追加するメンバーは "worker" 仮ラベル
// (実体は動的ロールに置き換わる) を持たせる。
const DEFAULT_MEMBER: TeamMember = { agent: 'claude', role: 'worker' };
const makeDraftMember = (m: TeamMember = DEFAULT_MEMBER): MemberDraft => ({
  ...m,
  _uid: nextMemberUid()
});

/**
 * TeamCreateModal のフォーム state とアクションを一本化したフック。
 * remaining (残席) は add 判定時に渡す。
 */
export function useTeamBuilder(): {
  form: TeamBuilderForm;
  actions: TeamBuilderActions;
  totalNeeded: number;
} {
  const [teamName, setTeamName] = useState('');
  const [leaderAgent, setLeaderAgent] = useState<TerminalAgent>('claude');
  const [members, setMembers] = useState<MemberDraft[]>([makeDraftMember()]);
  // デフォルトで保存する: 作成したチームが何もしないで消えてしまうと不便なので、
  // 明示的にチェックを外したときだけ保存しない挙動にする
  const [saveAsPreset, setSaveAsPreset] = useState(true);
  const [presetName, setPresetName] = useState('');
  const [editingPresetId, setEditingPresetId] = useState<string | null>(null);

  const totalNeeded = 1 + members.length;

  const addMember = (remaining: number): void => {
    if (totalNeeded >= remaining) return;
    setMembers((prev) => [...prev, makeDraftMember()]);
  };

  const removeMember = (idx: number): void => {
    setMembers((prev) => prev.filter((_, i) => i !== idx));
  };

  const updateMember = (
    idx: number,
    field: keyof TeamMember,
    value: string
  ): void => {
    setMembers((prev) =>
      prev.map((m, i) => (i === idx ? { ...m, [field]: value } : m))
    );
  };

  const loadPresetForEdit = (preset: TeamPreset): void => {
    const leader = preset.members.find((m) => m.role === 'leader');
    const others = preset.members.filter((m) => m.role !== 'leader');
    setTeamName(preset.name);
    setLeaderAgent(leader?.agent ?? 'claude');
    setMembers(
      others.length > 0 ? others.map((m) => makeDraftMember(m)) : [makeDraftMember()]
    );
    setEditingPresetId(preset.id);
    setPresetName(preset.name);
    setSaveAsPreset(true);
  };

  const cancelEdit = (): void => {
    setEditingPresetId(null);
    setSaveAsPreset(false);
    setPresetName('');
    setTeamName('');
    setLeaderAgent('claude');
    setMembers([makeDraftMember()]);
  };

  const resetAfterCreate = (): void => {
    setEditingPresetId(null);
  };

  return {
    form: {
      teamName,
      leaderAgent,
      members,
      saveAsPreset,
      presetName,
      editingPresetId
    },
    actions: {
      setTeamName,
      setLeaderAgent,
      setSaveAsPreset,
      setPresetName,
      setEditingPresetId,
      addMember,
      removeMember,
      updateMember,
      loadPresetForEdit,
      cancelEdit,
      resetAfterCreate
    },
    totalNeeded
  };
}
