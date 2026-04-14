import { useState } from 'react';
import type { TeamMember, TeamPreset, TerminalAgent } from '../../../types/shared';

export interface TeamBuilderForm {
  teamName: string;
  leaderAgent: TerminalAgent;
  members: TeamMember[];
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

const DEFAULT_MEMBER: TeamMember = { agent: 'claude', role: 'programmer' };

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
  const [members, setMembers] = useState<TeamMember[]>([{ ...DEFAULT_MEMBER }]);
  // デフォルトで保存する: 作成したチームが何もしないで消えてしまうと不便なので、
  // 明示的にチェックを外したときだけ保存しない挙動にする
  const [saveAsPreset, setSaveAsPreset] = useState(true);
  const [presetName, setPresetName] = useState('');
  const [editingPresetId, setEditingPresetId] = useState<string | null>(null);

  const totalNeeded = 1 + members.length;

  const addMember = (remaining: number): void => {
    if (totalNeeded >= remaining) return;
    setMembers((prev) => [...prev, { ...DEFAULT_MEMBER }]);
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
    setMembers(others.length > 0 ? others : [{ ...DEFAULT_MEMBER }]);
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
    setMembers([{ ...DEFAULT_MEMBER }]);
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
