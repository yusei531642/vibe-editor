// tauri-api/team-state.ts — TeamHub orchestration state の renderer 側 wrapper (Issue #514).
//
// Rust 側 `commands/team_state.rs` の `team_state_read` IPC を 1:1 で叩く薄いラッパー。
// project_root + team_id を指定して `~/.vibe-editor/team-state/<projectKey>/<teamId>.json`
// から persistence された orchestration state (tasks / worker_reports / human_gate /
// handoff_events) を読み出す。
//
// 既に読み出し系のみ存在する API。書き出しは MCP 経由で agent から行うため renderer 側
// wrapper は read のみ用意する (write は agent が `team_assign_task` 等を MCP で叩く)。

import { invoke } from '@tauri-apps/api/core';
import type { TeamOrchestrationState } from '../../../../types/shared';

export const teamState = {
  /** 永続化されたチームの orchestration state を読み出す。未保存なら null。 */
  read: (projectRoot: string, teamId: string): Promise<TeamOrchestrationState | null> =>
    invoke('team_state_read', { projectRoot, teamId })
};
