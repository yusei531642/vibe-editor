// tauri-api/app.ts — app.* IPC namespace (Phase 5 / Issue #373)

import { invoke } from '@tauri-apps/api/core';
import type {
  AppUserInfo,
  ClaudeCheckResult,
  RecruitAckArgs,
  SetWindowEffectsResult,
  ThemeName,
  UpdaterShouldWarnResult
} from '../../../../types/shared';
import { invokeCommand } from './command-error';

/** Tauri 側 TeamHub に同期する role profile の要約形 */
export interface RoleProfileSummary {
  id: string;
  labelEn: string;
  labelJa?: string;
  descriptionEn: string;
  descriptionJa?: string;
  canRecruit: boolean;
  canDismiss: boolean;
  canAssignTasks: boolean;
  /** Leader が team_create_role / team_recruit(role_definition=...) で動的ロールを作れるか */
  canCreateRoleProfile: boolean;
  defaultEngine: string;
  singleton: boolean;
}

interface TeamMcpMember {
  agentId: string;
  role: string;
  agent: string;
}
interface SetupTeamMcpResult {
  ok: boolean;
  error?: string;
  socket?: string;
  changed?: boolean;
}
interface CleanupTeamMcpResult {
  ok: boolean;
  error?: string;
  removed?: boolean;
}
interface ActiveLeaderResult {
  ok: boolean;
  error?: string;
}
interface OpenExternalResult {
  ok: boolean;
  error?: string;
}
interface TeamHubInfo {
  socket: string;
  token: string;
  bridgePath: string;
}

export const app = {
  getProjectRoot: (): Promise<string> => invoke('app_get_project_root'),
  /** Issue #29: renderer 側で project root が切り替わったとき Rust 側 state を同期する */
  setProjectRoot: (projectRoot: string): Promise<void> =>
    invoke('app_set_project_root', { projectRoot }),
  restart: (): Promise<void> => invoke('app_restart'),
  setWindowTitle: (title: string): Promise<void> => invoke('app_set_window_title', { title }),
  checkClaude: (command: string): Promise<ClaudeCheckResult> =>
    invoke('app_check_claude', { command }),
  setZoomLevel: (level: number): Promise<void> => invoke('app_set_zoom_level', { level }),
  /**
   * Issue #260 PR-1: テーマに応じて OS ネイティブの window effect (Windows: Acrylic /
   * macOS: vibrancy) を切り替える。Linux 等は no-op (applied=false で返る)。
   * 引数を `ThemeName` に絞ることで誤った文字列での呼び出しをコンパイル時に弾く。
   */
  setWindowEffects: (theme: ThemeName): Promise<SetWindowEffectsResult> =>
    invoke('app_set_window_effects', { theme }),
  setupTeamMcp: (
    projectRoot: string,
    teamId: string,
    teamName: string,
    members: TeamMcpMember[]
  ): Promise<SetupTeamMcpResult> =>
    invoke('app_setup_team_mcp', { projectRoot, teamId, teamName, members }),
  cleanupTeamMcp: (projectRoot: string, teamId: string): Promise<CleanupTeamMcpResult> =>
    invoke('app_cleanup_team_mcp', { projectRoot, teamId }),
  setActiveLeader: (teamId: string, agentId?: string | null): Promise<ActiveLeaderResult> =>
    invoke('app_set_active_leader', { teamId, agentId }),
  getTeamFilePath: (teamId: string): Promise<string> =>
    invoke('app_get_team_file_path', { teamId }),
  getMcpServerPath: (): Promise<string> => invoke('app_get_mcp_server_path'),
  getTeamHubInfo: (): Promise<TeamHubInfo> => invoke('app_get_team_hub_info'),
  /** RoleProfile summary を Hub へ同期 (team_list_role_profiles / permissions 検証用) */
  setRoleProfileSummary: (summary: RoleProfileSummary[]): Promise<void> =>
    invoke('app_set_role_profile_summary', { summary }),
  /** recruit を手動キャンセル (timeout 待ち中にユーザーがカードを × で閉じた等) */
  cancelRecruit: (agentId: string): Promise<void> =>
    invoke('app_cancel_recruit', { agentId }),
  /**
   * Issue #342 Phase 1 / #728: recruit-request の受領 / 失敗を Hub に通知する。
   * 引数 5 個 (newAgentId / teamId / ok / reason / phase) を flat camelCase で渡す。
   */
  recruitAck: (args: RecruitAckArgs): Promise<void> =>
    invoke('app_recruit_ack', {
      newAgentId: args.newAgentId,
      teamId: args.teamId,
      ok: args.ok,
      reason: args.reason ?? null,
      phase: args.phase ?? null
    }),
  /**
   * `<projectRoot>/.claude/skills/vibe-team/SKILL.md` を書き出す。
   * setupTeamMcp でも best-effort で実行されるが、Onboarding / 設定 UI から手動で
   * 強制再配置 (forceOverwrite=true) したい場合のために露出する。
   *
   * Issue #737: Rust 側 `app_install_vibe_team_skill` は `CommandResult<T>` を返すため、
   * reject を共通 `CommandError` に正規化する `invokeCommand` 経由で呼ぶ。
   */
  installVibeTeamSkill: (
    projectRoot: string,
    forceOverwrite?: boolean
  ): Promise<{
    ok: boolean;
    path?: string;
    skipped?: boolean;
    overwritten?: boolean;
    error?: string;
  }> =>
    invokeCommand('app_install_vibe_team_skill', {
      projectRoot,
      forceOverwrite: !!forceOverwrite
    }),
  getUserInfo: (): Promise<AppUserInfo> => invoke('app_get_user_info'),
  openExternal: (url: string): Promise<OpenExternalResult> => invoke('app_open_external', { url }),
  /** Issue #251: OS のファイルマネージャで親フォルダを開き該当ファイルをハイライト */
  revealInFileManager: (path: string): Promise<OpenExternalResult> =>
    invoke('app_reveal_in_file_manager', { path }),
  /**
   * Issue #609 (Security): updater の minisign 署名検証失敗を「24h に 1 度だけ」
   * ユーザーに通知するための cooldown 判定。`shouldWarn=true` のときだけ renderer は
   * toast を出し、その直後に必ず `updaterRecordSignatureWarning()` を呼ぶ。
   */
  updaterShouldWarnSignature: (): Promise<UpdaterShouldWarnResult> =>
    invoke('app_updater_should_warn_signature'),
  /** Issue #609: 警告 toast 表示直後に最終警告 timestamp を更新する。 */
  updaterRecordSignatureWarning: (): Promise<void> =>
    invoke('app_updater_record_signature_warning')
};
