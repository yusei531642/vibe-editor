// tauri-api/team-presets.ts — Team Preset の保存 / 一覧 / 削除 wrapper (Issue #522).
//
// Rust 側 commands/team_presets.rs の `team_presets_*` IPC を 1:1 で叩く薄いラッパー。
// `team` namespace (tauri-api/team.ts; #511, #521) とは別 namespace `teamPresets` を採る:
//   - team        = ライブの TeamHub 操作 (summary / retryInject 等の "今のチーム")
//   - teamPresets = 永続化されたテンプレ (CRUD)
// と意味が分かれるため。

import { invoke } from '@tauri-apps/api/core';
import type {
  TeamPreset,
  TeamPresetMutationResult
} from '../../../../types/shared';

export const teamPresets = {
  list: (): Promise<TeamPreset[]> => invoke('team_presets_list'),
  load: (id: string): Promise<TeamPreset | null> =>
    invoke('team_presets_load', { id }),
  save: (preset: TeamPreset): Promise<TeamPresetMutationResult> =>
    invoke('team_presets_save', { preset }),
  delete: (id: string): Promise<TeamPresetMutationResult> =>
    invoke('team_presets_delete', { id })
};
