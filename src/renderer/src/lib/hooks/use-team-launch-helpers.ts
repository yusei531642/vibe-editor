/**
 * use-team-launch-helpers — 旧 `use-team-management.ts` (524 行) のうち
 * TerminalView の props として渡される起動引数 / 環境変数 / 初期メッセージ生成関数群:
 *   - `getTerminalArgs` (Claude `--append-system-prompt` / Codex paste burst 対策)
 *   - `getCodexInstructions` (Codex 専用の system 指示テキスト)
 *   - `getRolePrompt` (タブのロールに対応する初期メッセージ)
 *   - `getTerminalEnv` (TeamHub socket / token / 役割識別子)
 * を切り出した。Issue #487 でファイル分割した 3 本目。挙動は不変、構造のみ整理。
 */
import { useCallback, useRef } from 'react';
import type { Team } from '../../../../types/shared';
import { useSettingsValue } from '../settings-context';
import { parseShellArgs } from '../parse-args';
import {
  generateTeamAction,
  generateTeamSystemPrompt,
  ROLE_DESC
} from '../team-prompts';
import type { TerminalTab } from './use-terminal-tabs';
import type { TeamHubInfo } from './use-team-state';

export interface UseTeamLaunchHelpersOptions {
  teams: Team[];
  teamHubInfo: TeamHubInfo | null;
  /** チーム検索 + system prompt 生成のために最新 terminalTabs を ref で参照する */
  terminalTabs: TerminalTab[];
}

export interface UseTeamLaunchHelpersResult {
  getTerminalArgs: (tab: TerminalTab) => string[];
  getCodexInstructions: (tab: TerminalTab) => string | undefined;
  getRolePrompt: (tab: TerminalTab) => string | undefined;
  getTerminalEnv: (tab: TerminalTab) => Record<string, string> | undefined;
}

export function useTeamLaunchHelpers(
  opts: UseTeamLaunchHelpersOptions
): UseTeamLaunchHelpersResult {
  const claudeArgs = useSettingsValue('claudeArgs');
  const codexArgs = useSettingsValue('codexArgs');

  const optsRef = useRef(opts);
  optsRef.current = opts;

  const getTerminalArgs = useCallback(
    (tab: TerminalTab): string[] => {
      const isCodex = tab.agent === 'codex';
      const base = parseShellArgs(isCodex ? codexArgs || '' : claudeArgs || '');
      if (tab.resumeSessionId && !isCodex) {
        // Issue #660: 初回 spawn は `--session-id <uuid>` で id を claude に強制注入し、
        // 新規 jsonl を確定させる。`onSessionId` 受信で freshSessionId が false に倒れた
        // 後 (= jsonl 永続化済み) の再 spawn は `--resume <uuid>` で前回会話を resume する。
        if (tab.freshSessionId) {
          base.push('--session-id', tab.resumeSessionId);
        } else {
          base.push('--resume', tab.resumeSessionId);
        }
      }
      // Claude のチーム指示は --append-system-prompt で直接渡す。
      if (!isCodex && tab.teamId) {
        const team =
          optsRef.current.teams.find((x) => x.id === tab.teamId) ?? null;
        const sysPrompt = generateTeamSystemPrompt(
          tab,
          optsRef.current.terminalTabs,
          team
        );
        if (sysPrompt) {
          base.push('--append-system-prompt', sysPrompt);
        }
      }
      // Codex の paste_burst 検出を無効化する。
      // チーム通信では team_send が chat_composer に文字列を直接流し込むが、
      // Codex は高速連続入力を「ペースト扱い」にバッファしてしまい、
      // 末尾の Enter が送信ではなく確定として飲み込まれて返信できなくなる。
      // ユーザが codexArgs で明示的に設定している場合はそちらを尊重する。
      const userCodexArgs = codexArgs || '';
      if (isCodex && tab.teamId && !userCodexArgs.includes('disable_paste_burst')) {
        base.push('-c', 'disable_paste_burst=true');
      }
      return base;
    },
    [claudeArgs, codexArgs]
  );

  /**
   * Codex 向けのシステム指示。main 側で一時ファイルに書き出されて
   * `-c model_instructions_file=<path>` として渡される。
   */
  const getCodexInstructions = useCallback(
    (tab: TerminalTab): string | undefined => {
      if (tab.agent !== 'codex' || !tab.teamId) return undefined;
      const team =
        optsRef.current.teams.find((x) => x.id === tab.teamId) ?? null;
      return generateTeamSystemPrompt(tab, optsRef.current.terminalTabs, team);
    },
    []
  );

  const getTerminalEnv = useCallback(
    (tab: TerminalTab): Record<string, string> | undefined => {
      if (!tab.teamId || !tab.role) return undefined;
      const hub = optsRef.current.teamHubInfo;
      if (!hub) return undefined;
      return {
        VIBE_TEAM_ID: tab.teamId,
        VIBE_TEAM_ROLE: tab.role,
        VIBE_AGENT_ID: tab.agentId,
        VIBE_TEAM_SOCKET: hub.socket,
        VIBE_TEAM_TOKEN: hub.token
      };
    },
    []
  );

  /** タブのロールに対応する初期メッセージ（短いアクション指示のみ） */
  const getRolePrompt = useCallback((tab: TerminalTab): string | undefined => {
    if (!tab.role) return undefined;
    // スタンドアロン (チーム無し)
    if (!tab.teamId) {
      if (tab.role === 'leader') return undefined;
      return `${ROLE_DESC[tab.role]}に集中してください。`;
    }
    return generateTeamAction(tab);
  }, []);

  return {
    getTerminalArgs,
    getCodexInstructions,
    getRolePrompt,
    getTerminalEnv
  };
}
