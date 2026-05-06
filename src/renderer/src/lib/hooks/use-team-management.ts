/**
 * use-team-management — 旧 524 行の単一 hook を以下の 3 hook + 互換 wrapper に
 * 整理した (Issue #487):
 *
 *   - `use-team-state.ts`         — teams 配列 / spawnStaggerTimers / TeamHub 接続
 *                                    情報 / doCloseTeam / handleCloseLeaderOnly /
 *                                    プロジェクト切替時の reset
 *   - `use-team-history-sync.ts`  — teamHistoryEntries 配列 / debounce save /
 *                                    handleResumeTeam / handleDeleteTeamHistory /
 *                                    handleTerminalSessionId / persistTerminalCustomLabel
 *   - `use-team-launch-helpers.ts`— TerminalView 起動引数生成 (getTerminalArgs /
 *                                    getCodexInstructions / getRolePrompt /
 *                                    getTerminalEnv)
 *
 * 本ファイルは 3 つを組み合わせる薄い wrapper。`UseTeamManagementOptions` /
 * `UseTeamManagementResult` の公開シグネチャは不変なので、App.tsx の import / 呼び
 * 出し方は変えなくて良い。
 *
 * 旧コメント (Issue #373 Phase 1-4 の流儀) も継承:
 * - opts は `optsRef.current = opts` で毎 render 更新し、内部 useCallback の
 *   deps から外す (use-project-loader / use-file-tabs / use-terminal-tabs と統一)。
 * - useT / useSettingsValue は hook 内で直接呼ぶ。
 * - 純粋関数 (generateTeamSystemPrompt 等) は src/renderer/src/lib/team-prompts.ts
 *   に切り出し済み。
 *
 * Phase 1-3 hook (useTerminalTabs) との接続:
 * - terminalTabs / setTerminalTabs / setActiveTerminalTabId / nextTerminalIdRef /
 *   addTerminalTab / doCloseTab を opts で受ける (= 上から下への一方向参照)。
 * - 戻り値の doCloseTeam を App.tsx 側で `closeTeamRef` ブリッジ経由で
 *   useTerminalTabs.opts.closeTeam に注入する (唯一の逆方向参照)。
 */
import type { Team, TeamHistoryEntry } from '../../../../types/shared';
import {
  type AddTerminalTabOptions,
  type TerminalTab
} from './use-terminal-tabs';
import { useTeamState } from './use-team-state';
import { useTeamHistorySync } from './use-team-history-sync';
import { useTeamLaunchHelpers } from './use-team-launch-helpers';

type ToastFn = (
  msg: string,
  opts?: { tone?: 'info' | 'success' | 'warning' | 'error' }
) => void;

export interface UseTeamManagementOptions {
  projectRoot: string;
  showToast: ToastFn;

  // ---- Phase 1-3 hook 戻り値ブリッジ ----
  terminalTabs: TerminalTab[];
  setTerminalTabs: React.Dispatch<React.SetStateAction<TerminalTab[]>>;
  setActiveTerminalTabId: React.Dispatch<React.SetStateAction<number>>;
  nextTerminalIdRef: React.MutableRefObject<number>;
  addTerminalTab: (opts?: AddTerminalTabOptions) => number | null;
  doCloseTab: (tabId: number) => void;
}

export interface UseTeamManagementResult {
  // ---- state ----
  teams: Team[];
  teamHistoryEntries: TeamHistoryEntry[];

  // ---- close / leader 操作 ----
  doCloseTeam: (teamId: string) => void;
  handleCloseLeaderOnly: (tabId: number, teamId: string) => void;

  // ---- resume / delete ----
  handleResumeTeam: (entry: TeamHistoryEntry) => Promise<void>;
  handleDeleteTeamHistory: (entryId: string) => Promise<void>;

  // ---- history sync (TerminalView callback で呼ばれる) ----
  handleTerminalSessionId: (tab: TerminalTab, sessionId: string) => void;
  persistTerminalCustomLabel: (tab: TerminalTab, trimmed: string) => void;

  // ---- terminal launch helpers (TerminalView props にそのまま渡せる形) ----
  getTerminalArgs: (tab: TerminalTab) => string[];
  getCodexInstructions: (tab: TerminalTab) => string | undefined;
  getRolePrompt: (tab: TerminalTab) => string | undefined;
  getTerminalEnv: (tab: TerminalTab) => Record<string, string> | undefined;

  // ---- project switch ----
  resetForProjectSwitch: () => void;
}

export function useTeamManagement(
  opts: UseTeamManagementOptions
): UseTeamManagementResult {
  const teamState = useTeamState({
    projectRoot: opts.projectRoot,
    showToast: opts.showToast,
    setTerminalTabs: opts.setTerminalTabs,
    setActiveTerminalTabId: opts.setActiveTerminalTabId,
    nextTerminalIdRef: opts.nextTerminalIdRef,
    addTerminalTab: opts.addTerminalTab,
    doCloseTab: opts.doCloseTab
  });

  const history = useTeamHistorySync({
    projectRoot: opts.projectRoot,
    showToast: opts.showToast,
    terminalTabs: opts.terminalTabs,
    setTerminalTabs: opts.setTerminalTabs,
    addTerminalTab: opts.addTerminalTab,
    teams: teamState.teams,
    setTeams: teamState.setTeams,
    clearSpawnTimers: teamState.clearSpawnTimers
  });

  const launch = useTeamLaunchHelpers({
    teams: teamState.teams,
    teamHubInfo: teamState.teamHubInfo,
    terminalTabs: opts.terminalTabs
  });

  return {
    teams: teamState.teams,
    teamHistoryEntries: history.teamHistoryEntries,
    doCloseTeam: teamState.doCloseTeam,
    handleCloseLeaderOnly: teamState.handleCloseLeaderOnly,
    handleResumeTeam: history.handleResumeTeam,
    handleDeleteTeamHistory: history.handleDeleteTeamHistory,
    handleTerminalSessionId: history.handleTerminalSessionId,
    persistTerminalCustomLabel: history.persistTerminalCustomLabel,
    getTerminalArgs: launch.getTerminalArgs,
    getCodexInstructions: launch.getCodexInstructions,
    getRolePrompt: launch.getRolePrompt,
    getTerminalEnv: launch.getTerminalEnv,
    resetForProjectSwitch: teamState.resetForProjectSwitch
  };
}
