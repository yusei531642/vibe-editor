// tauri-api/team-state.ts — TeamHub orchestration state の renderer 側 wrapper (Issue #514).
//
// Rust 側 `commands/team_state.rs` の `team_state_read` IPC を 1:1 で叩く薄いラッパー。
// project_root + team_id を指定して `~/.vibe-editor/team-state/<projectKey>/<teamId>.json`
// から persistence された orchestration state (tasks / worker_reports / human_gate /
// handoff_events) を読み出す。
//
// 既に読み出し系のみ存在する API。書き出しは MCP 経由で agent から行うため renderer 側
// wrapper は read のみ用意する (write は agent が `team_assign_task` 等を MCP で叩く)。

// Issue #737: Rust 側 `team_state_*` / `recruit_observed_while_hidden` は `CommandResult<T>`
// を返すため、reject を共通 `CommandError` に正規化する `invokeCommand` 経由で呼ぶ。
import type {
  RecruitObservedWhileHiddenArgs,
  TeamOrchestrationState
} from '../../../../types/shared';
import { invokeCommand } from './command-error';

export const teamState = {
  /** 永続化されたチームの orchestration state を読み出す。未保存なら null。 */
  read: (projectRoot: string, teamId: string): Promise<TeamOrchestrationState | null> =>
    invokeCommand('team_state_read', { projectRoot, teamId }),

  /**
   * Issue #578: Canvas (Tauri webview) が非表示の間に `team:recruit-request` が走った
   * 観測点を Hub 側ログに残す。renderer 側で hidden 経過時間 >= 5000ms を満たす場合のみ呼ぶ。
   */
  recruitObservedWhileHidden: (args: RecruitObservedWhileHiddenArgs): Promise<void> =>
    invokeCommand('recruit_observed_while_hidden', { args })
};
