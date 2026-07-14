// tauri-api/app.ts — app.* IPC namespace (Phase 5 / Issue #373)

import { invokeCommand } from './command-error';
import type {
  AppUserInfo,
  ClaudeCheckResult,
  RecruitAckArgs,
  SetWindowEffectsResult,
  ThemeName,
  UpdaterShouldWarnResult
} from '../../../../types/shared';

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

export interface TeamMcpMember {
  agentId: string;
  role: string;
  agent: string;
}
export interface SetupTeamMcpResult {
  ok: boolean;
  error?: string;
  socket?: string;
  changed?: boolean;
}
export interface CleanupTeamMcpResult {
  ok: boolean;
  error?: string;
  removed?: boolean;
}
export interface ActiveLeaderResult {
  ok: boolean;
  error?: string;
}
export interface OpenExternalResult {
  ok: boolean;
  error?: string;
}
export interface TeamHubInfo {
  socket: string;
  token: string;
  bridgePath: string;
}

export interface PickedProjectFile {
  projectRoot: string;
  filePath: string;
}

export const app = {
  getProjectRoot: (): Promise<string> => invokeCommand('app_get_project_root'),
  /** startup raceを避けるため、native authority ledgerの復元完了後のactive rootを返す。 */
  restoreAuthorizedProjectRoot: (): Promise<string> =>
    invokeCommand('app_restore_authorized_project_root'),
  /**
   * Issue #1193: native folder pickerの結果をRust側で検証・永続化・active化する。
   * 任意pathを受け取るsetterは公開しない。
   */
  pickAndActivateProjectRoot: (title?: string): Promise<string | null> =>
    invokeCommand('app_pick_and_activate_project_root', { title: title ?? null }),
  /** recent pathはdialog初期位置にだけ使い、native再選択の結果をactive化する。 */
  reconfirmProjectRoot: (initialRoot: string, title?: string): Promise<string | null> =>
    invokeCommand('app_reconfirm_project_root', {
      initialRoot,
      title: title ?? null
    }),
  /** native file pickerの選択ファイルの親directoryを同一Rust transaction内でactive化する。 */
  pickFileAndActivateProjectRoot: (title?: string): Promise<PickedProjectFile | null> =>
    invokeCommand('app_pick_file_and_activate_project_root', { title: title ?? null }),
  clearActiveProjectRoot: (): Promise<void> =>
    invokeCommand('app_clear_active_project_root'),
  /** native pickerで選んだrootだけをworkspace authorityへ追加する。 */
  pickWorkspaceRoot: (title?: string): Promise<string | null> =>
    invokeCommand('app_pick_workspace_root', { title: title ?? null }),
  /** native pickerで承認済みのworkspaceだけをprimary projectとして有効化する。 */
  activateAuthorizedWorkspaceRoot: (projectRoot: string): Promise<string> =>
    invokeCommand('app_activate_authorized_workspace_root', { projectRoot }),
  /** authorityを追加しないrevoke操作。 */
  revokeWorkspaceRoot: (projectRoot: string): Promise<void> =>
    invokeCommand('app_revoke_workspace_root', { projectRoot }),
  restart: (): Promise<void> => invokeCommand('app_restart'),
  setWindowTitle: (title: string): Promise<void> => invokeCommand('app_set_window_title', { title }),
  checkClaude: (command: string): Promise<ClaudeCheckResult> =>
    invokeCommand('app_check_claude', { command }),
  setZoomLevel: (level: number): Promise<void> => invokeCommand('app_set_zoom_level', { level }),
  /**
   * Issue #260 PR-1: テーマに応じて OS ネイティブの window effect (Windows: Acrylic /
   * macOS: vibrancy) を切り替える。Linux 等は no-op (applied=false で返る)。
   * 引数を `ThemeName` に絞ることで誤った文字列での呼び出しをコンパイル時に弾く。
   */
  setWindowEffects: (theme: ThemeName): Promise<SetWindowEffectsResult> =>
    invokeCommand('app_set_window_effects', { theme }),
  setupTeamMcp: (
    projectRoot: string,
    teamId: string,
    teamName: string,
    members: TeamMcpMember[]
  ): Promise<SetupTeamMcpResult> =>
    invokeCommand('app_setup_team_mcp', { projectRoot, teamId, teamName, members }),
  cleanupTeamMcp: (projectRoot: string, teamId: string): Promise<CleanupTeamMcpResult> =>
    invokeCommand('app_cleanup_team_mcp', { projectRoot, teamId }),
  setActiveLeader: (teamId: string, agentId?: string | null): Promise<ActiveLeaderResult> =>
    invokeCommand('app_set_active_leader', { teamId, agentId }),
  getTeamFilePath: (teamId: string): Promise<string> =>
    invokeCommand('app_get_team_file_path', { teamId }),
  getMcpServerPath: (): Promise<string> => invokeCommand('app_get_mcp_server_path'),
  getTeamHubInfo: (): Promise<TeamHubInfo> => invokeCommand('app_get_team_hub_info'),
  /** RoleProfile summary を Hub へ同期 (team_list_role_profiles / permissions 検証用) */
  setRoleProfileSummary: (summary: RoleProfileSummary[]): Promise<void> =>
    invokeCommand('app_set_role_profile_summary', { summary }),
  /** recruit を手動キャンセル (timeout 待ち中にユーザーがカードを × で閉じた等) */
  cancelRecruit: (agentId: string): Promise<void> =>
    invokeCommand('app_cancel_recruit', { agentId }),
  /**
   * Issue #342 Phase 1 / #728: recruit-request の受領 / 失敗を Hub に通知する。
   * 引数 5 個 (newAgentId / teamId / ok / reason / phase) を flat camelCase で渡す。
   */
  recruitAck: (args: RecruitAckArgs): Promise<void> =>
    invokeCommand('app_recruit_ack', {
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
  getUserInfo: (): Promise<AppUserInfo> => invokeCommand('app_get_user_info'),
  openExternal: (url: string): Promise<OpenExternalResult> => invokeCommand('app_open_external', { url }),
  /** Issue #251: OS のファイルマネージャで親フォルダを開き該当ファイルをハイライト */
  revealInFileManager: (path: string): Promise<OpenExternalResult> =>
    invokeCommand('app_reveal_in_file_manager', { path }),
  /**
   * Issue #609 (Security): updater の minisign 署名検証失敗を「24h に 1 度だけ」
   * ユーザーに通知するための cooldown 判定。`shouldWarn=true` のときだけ renderer は
   * toast を出し、その直後に必ず `updaterRecordSignatureWarning()` を呼ぶ。
   */
  updaterShouldWarnSignature: (): Promise<UpdaterShouldWarnResult> =>
    invokeCommand('app_updater_should_warn_signature'),
  /** Issue #609: 警告 toast 表示直後に最終警告 timestamp を更新する。 */
  updaterRecordSignatureWarning: (): Promise<void> =>
    invokeCommand('app_updater_record_signature_warning')
};
