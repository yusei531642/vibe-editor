import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  Team,
  TeamHistoryEntry
} from '../../../../types/shared';
import { useT } from '../i18n';
import { useSettingsValue } from '../settings-context';
import { parseShellArgs } from '../parse-args';
import {
  generateTeamAction,
  generateTeamSystemPrompt,
  ROLE_DESC
} from '../team-prompts';
import {
  MAX_TERMINALS,
  type AddTerminalTabOptions,
  type TerminalTab
} from './use-terminal-tabs';

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

/**
 * Issue #373 Phase 1-4: team management 関連の state / handler を App.tsx から
 * 切り出した hook。teams 配列、team-history (debounce 永続化込み)、TeamHub 接続情報、
 * doCloseTeam / handleCloseLeaderOnly / handleResumeTeam / handleDeleteTeamHistory、
 * terminal の起動引数合成 (getTerminalArgs / getCodexInstructions / getRolePrompt /
 * getTerminalEnv) を集約する。
 *
 * 流儀:
 * - opts は `optsRef.current = opts` で毎 render 更新し、内部 useCallback の
 *   deps から外す (use-project-loader / use-file-tabs / use-terminal-tabs と統一)。
 * - useT / useSettingsValue は hook 内で直接呼ぶ。
 * - 純粋関数 (generateTeamSystemPrompt 等) は src/renderer/src/lib/team-prompts.ts
 *   に切り出し済み。本 hook はそれを import するだけ。
 *
 * Phase 1-3 hook (useTerminalTabs) との接続:
 * - terminalTabs / setTerminalTabs / setActiveTerminalTabId / nextTerminalIdRef /
 *   addTerminalTab / doCloseTab を opts で受ける (= 上から下への一方向参照)。
 * - 戻り値の doCloseTeam を App.tsx 側で `closeTeamRef` ブリッジ経由で
 *   useTerminalTabs.opts.closeTeam に注入する (唯一の逆方向参照)。
 */
export function useTeamManagement(
  opts: UseTeamManagementOptions
): UseTeamManagementResult {
  const t = useT();
  const claudeArgs = useSettingsValue('claudeArgs');
  const codexArgs = useSettingsValue('codexArgs');
  const mcpAutoSetup = useSettingsValue('mcpAutoSetup');

  const optsRef = useRef(opts);
  optsRef.current = opts;

  const [teams, setTeams] = useState<Team[]>([]);
  const [teamHistoryEntries, setTeamHistoryEntries] = useState<TeamHistoryEntry[]>([]);

  /** チーム作成時のメンバースポーン遅延タイマー。破棄時にクリアできるよう保持 */
  const spawnStaggerTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const clearSpawnTimers = useCallback(() => {
    for (const timer of spawnStaggerTimers.current) clearTimeout(timer);
    spawnStaggerTimers.current = [];
  }, []);

  /**
   * team history save のデバウンス。sessionId が順次取れてくるときに
   * N 回ファイルに書き出すのを避ける。entryId ごとに最新値を 500ms 後に flush。
   */
  const teamHistoryPending = useRef(new Map<string, TeamHistoryEntry>());
  const teamHistoryFlushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushTeamHistoryNow = useCallback((): void => {
    if (teamHistoryFlushTimer.current) {
      clearTimeout(teamHistoryFlushTimer.current);
      teamHistoryFlushTimer.current = null;
    }
    if (!window.api.teamHistory) {
      teamHistoryPending.current.clear();
      return;
    }
    const entries = Array.from(teamHistoryPending.current.values());
    teamHistoryPending.current.clear();
    for (const e of entries) {
      void window.api.teamHistory.save(e);
    }
  }, []);
  const saveTeamHistory = useCallback((entry: TeamHistoryEntry) => {
    if (!window.api.teamHistory) return;
    teamHistoryPending.current.set(entry.id, entry);
    if (teamHistoryFlushTimer.current) return;
    teamHistoryFlushTimer.current = setTimeout(() => {
      teamHistoryFlushTimer.current = null;
      const entries = Array.from(teamHistoryPending.current.values());
      teamHistoryPending.current.clear();
      for (const e of entries) {
        void window.api.teamHistory.save(e);
      }
    }, 500);
  }, []);

  // アンマウント (アプリ終了直前) で pending を即 flush + 未発火 spawn timer を停止。
  useEffect(() => {
    return () => {
      flushTeamHistoryNow();
      clearSpawnTimers();
    };
  }, [flushTeamHistoryNow, clearSpawnTimers]);

  /** TeamHub 接続情報 (アプリ起動時に 1 回だけ解決)。 */
  const [teamHubInfo, setTeamHubInfo] = useState<{ socket: string; token: string } | null>(
    null
  );
  useEffect(() => {
    void window.api.app.getTeamHubInfo().then((info) => setTeamHubInfo(info));
  }, []);

  // プロジェクト変更時にチーム履歴をロード
  const refreshTeamHistory = useCallback(async () => {
    const projectRoot = optsRef.current.projectRoot;
    if (!projectRoot) return;
    if (!window.api.teamHistory) return; // preload が古い場合はスキップ
    try {
      const entries = await window.api.teamHistory.list(projectRoot);
      setTeamHistoryEntries(entries);
    } catch (err) {
      console.warn('[teamHistory] list failed:', err);
    }
  }, []);

  useEffect(() => {
    void refreshTeamHistory();
  }, [opts.projectRoot, refreshTeamHistory]);

  const doCloseTeam = useCallback(
    (teamId: string) => {
      const {
        projectRoot,
        setTerminalTabs,
        setActiveTerminalTabId,
        nextTerminalIdRef
      } = optsRef.current;
      // チーム作成進行中ならスタガー spawn を止める（同じチームかは問わない）
      clearSpawnTimers();
      setTerminalTabs((prev) => {
        const next = prev.filter((tab) => tab.teamId !== teamId);
        if (next.length === 0) {
          // チーム全員しかいない場合 → 新しいスタンドアロンタブを自動生成
          const newId = nextTerminalIdRef.current++;
          const fresh: TerminalTab = {
            id: newId,
            version: 1,
            agent: 'claude',
            role: null,
            teamId: null,
            agentId: `agent-${newId}`,
            status: '',
            exited: false,
            resumeSessionId: null,
            teamHistoryMemberIdx: null,
            label: 'Claude #1',
            customLabel: null
          };
          setActiveTerminalTabId(newId);
          return [fresh];
        }
        setActiveTerminalTabId((active) => {
          if (next.some((tab) => tab.id === active)) return active;
          return next[next.length - 1].id;
        });
        return next;
      });
      setTeams((prev) => prev.filter((x) => x.id !== teamId));
      // MCP クリーンアップ (失敗しても UI 側は続行。catch で unhandled rejection を抑止)
      if (projectRoot) {
        window.api.app
          .cleanupTeamMcp(projectRoot, teamId)
          .catch((err) => console.warn('[team] cleanupTeamMcp failed:', err));
      }
    },
    [clearSpawnTimers]
  );

  /**
   * Leader だけ閉じる (メンバーはチーム無しタブとして残す) パス。
   * doCloseTeam() と違って tabs は保持するが、"チームは終了" という意味で
   * MCP の参照カウントは減らす必要がある。
   */
  const handleCloseLeaderOnly = useCallback(
    (tabId: number, teamId: string) => {
      const { doCloseTab, projectRoot, setTerminalTabs } = optsRef.current;
      // 1) Leader タブだけ閉じる
      doCloseTab(tabId);
      // 2) 残りメンバーは通常タブへ降格 (teamId/role を外す)
      setTerminalTabs((prev) =>
        prev.map((tab) =>
          tab.teamId === teamId
            ? { ...tab, teamId: null, role: null, teamHistoryMemberIdx: null }
            : tab
        )
      );
      // 3) runtime チームを削除
      setTeams((prev) => prev.filter((x) => x.id !== teamId));
      // 4) MCP 参照カウントを減らす (doCloseTeam 相当だが spawnStaggerTimers は触らない)
      if (projectRoot) {
        void window.api.app
          .cleanupTeamMcp(projectRoot, teamId)
          .catch((err) => console.warn('[team] cleanup after closeLeaderOnly failed:', err));
      }
    },
    []
  );

  const handleResumeTeam = useCallback(
    async (entry: TeamHistoryEntry) => {
      const {
        projectRoot,
        showToast,
        terminalTabs,
        setTerminalTabs,
        addTerminalTab
      } = optsRef.current;
      if (!projectRoot) return;
      if (!entry.members || entry.members.length === 0) {
        showToast('チームメンバー情報が空のため復元できません', { tone: 'warning' });
        return;
      }
      if (entry.projectRoot && entry.projectRoot !== projectRoot) {
        showToast(
          `このチームは別プロジェクト(${entry.projectRoot.split(/[\\/]/).pop()})の履歴です`,
          { tone: 'warning' }
        );
        return;
      }
      // 容量チェック: 既存タブ + メンバー数 が上限を超えるなら断念
      if (terminalTabs.length + entry.members.length > MAX_TERMINALS) {
        showToast(`ターミナル上限(${MAX_TERMINALS})を超えるため復元できません`, {
          tone: 'warning'
        });
        return;
      }

      // 再利用時刻を更新
      const updated: TeamHistoryEntry = {
        ...entry,
        lastUsedAt: new Date().toISOString()
      };
      setTeamHistoryEntries((prev) => [
        updated,
        ...prev.filter((e) => e.id !== entry.id)
      ]);
      saveTeamHistory(updated);

      // ランタイム Team として登録（既に同じ teamId があればそのまま）
      setTeams((prev) =>
        prev.some((x) => x.id === entry.id)
          ? prev
          : [...prev, { id: entry.id, name: entry.name }]
      );

      // MCP は現行の TeamHub 情報で確実に再登録する
      const allMembers = entry.members.map((m, i) => ({
        agentId: `${entry.id}-${m.role}-${i}`,
        role: m.role,
        agent: m.agent
      }));
      let mcpChanged = false;
      if (mcpAutoSetup !== false) {
        try {
          const res = await window.api.app.setupTeamMcp(
            projectRoot,
            entry.id,
            entry.name,
            allMembers
          );
          mcpChanged = res.changed === true;
        } catch (err) {
          console.warn('[resume team] setupTeamMcp failed:', err);
        }
      }
      if (mcpChanged) {
        setTerminalTabs((prev) =>
          prev.map((tab) =>
            tab.agent === 'claude' && !tab.exited
              ? { ...tab, version: tab.version + 1, status: '' }
              : tab
          )
        );
      }

      // 各メンバーをタブとしてスポーン (sessionId があれば --resume 付き、customLabel があれば復元)
      for (let i = 0; i < entry.members.length; i++) {
        const m = entry.members[i];
        addTerminalTab({
          agent: m.agent,
          role: m.role,
          teamId: entry.id,
          agentId: allMembers[i].agentId,
          resumeSessionId: m.sessionId ?? null,
          teamHistoryMemberIdx: i,
          customLabel: m.customLabel ?? null
        });
      }

      showToast(t('teamHistory.resumed', { name: entry.name }), { tone: 'info' });
    },
    [mcpAutoSetup, saveTeamHistory, t]
  );

  const handleDeleteTeamHistory = useCallback(async (entryId: string) => {
    setTeamHistoryEntries((prev) => prev.filter((e) => e.id !== entryId));
    if (!window.api.teamHistory) return;
    try {
      await window.api.teamHistory.delete(entryId);
    } catch (err) {
      console.warn('[teamHistory] delete failed:', err);
    }
  }, []);

  /**
   * Claude Code 起動ログから session id が取れたときに該当タブのチーム履歴を更新。
   * NOTE: このコールバックは watcher 由来の非同期で、タブが既に閉じられた後に
   * 発火することがある。その場合 tab.teamId は残っているが entry 側は削除済みで
   * findIndex が -1 を返すので no-op。
   */
  const handleTerminalSessionId = useCallback(
    (tab: TerminalTab, sessionId: string) => {
      if (!tab.teamId || tab.teamHistoryMemberIdx == null) return;
      if (!sessionId) return;
      setTeamHistoryEntries((prev) => {
        const idx = prev.findIndex((e) => e.id === tab.teamId);
        if (idx < 0) return prev;
        const entry = prev[idx];
        const memberIdx = tab.teamHistoryMemberIdx!;
        if (memberIdx < 0 || memberIdx >= entry.members.length) return prev;
        if (entry.members[memberIdx].sessionId === sessionId) return prev;
        const nextMembers = entry.members.map((m, i) =>
          i === memberIdx ? { ...m, sessionId } : m
        );
        const nextEntry: TeamHistoryEntry = {
          ...entry,
          members: nextMembers,
          lastUsedAt: new Date().toISOString()
        };
        saveTeamHistory(nextEntry);
        const copy = [...prev];
        copy[idx] = nextEntry;
        return copy;
      });
    },
    [saveTeamHistory]
  );

  /**
   * タブの手動リネーム結果を team-history に反映する。
   * チーム所属タブのみ対象。スタンドアロンタブはメモリ揮発なのでスキップ。
   * trimmed が空文字なら customLabel = null (= 自動生成名へ復帰) として保存。
   */
  const persistTerminalCustomLabel = useCallback(
    (tab: TerminalTab, trimmed: string) => {
      if (!tab.teamId || tab.teamHistoryMemberIdx == null) return;
      const next: string | null = trimmed === '' ? null : trimmed;
      setTeamHistoryEntries((prev) => {
        const idx = prev.findIndex((e) => e.id === tab.teamId);
        if (idx < 0) return prev;
        const entry = prev[idx];
        const memberIdx = tab.teamHistoryMemberIdx!;
        if (memberIdx < 0 || memberIdx >= entry.members.length) return prev;
        if ((entry.members[memberIdx].customLabel ?? null) === next) return prev;
        const nextMembers = entry.members.map((m, i) =>
          i === memberIdx ? { ...m, customLabel: next } : m
        );
        const nextEntry: TeamHistoryEntry = {
          ...entry,
          members: nextMembers,
          lastUsedAt: new Date().toISOString()
        };
        saveTeamHistory(nextEntry);
        const copy = [...prev];
        copy[idx] = nextEntry;
        return copy;
      });
    },
    [saveTeamHistory]
  );

  // ---- terminal launch helpers (TerminalView の props で参照) ----

  const getTerminalArgs = useCallback(
    (tab: TerminalTab): string[] => {
      const isCodex = tab.agent === 'codex';
      const base = parseShellArgs(isCodex ? codexArgs || '' : claudeArgs || '');
      if (tab.resumeSessionId && !isCodex) {
        base.push('--resume', tab.resumeSessionId);
      }
      // Claude のチーム指示は --append-system-prompt で直接渡す。
      if (!isCodex && tab.teamId) {
        const team = teams.find((x) => x.id === tab.teamId) ?? null;
        const sysPrompt = generateTeamSystemPrompt(tab, optsRef.current.terminalTabs, team);
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
    [claudeArgs, codexArgs, teams]
  );

  /**
   * Codex 向けのシステム指示。main 側で一時ファイルに書き出されて
   * `-c model_instructions_file=<path>` として渡される。
   */
  const getCodexInstructions = useCallback(
    (tab: TerminalTab): string | undefined => {
      if (tab.agent !== 'codex' || !tab.teamId) return undefined;
      const team = teams.find((x) => x.id === tab.teamId) ?? null;
      return generateTeamSystemPrompt(tab, optsRef.current.terminalTabs, team);
    },
    [teams]
  );

  const getTerminalEnv = useCallback(
    (tab: TerminalTab): Record<string, string> | undefined => {
      if (!tab.teamId || !tab.role) return undefined;
      if (!teamHubInfo) return undefined;
      return {
        VIBE_TEAM_ID: tab.teamId,
        VIBE_TEAM_ROLE: tab.role,
        VIBE_AGENT_ID: tab.agentId,
        VIBE_TEAM_SOCKET: teamHubInfo.socket,
        VIBE_TEAM_TOKEN: teamHubInfo.token
      };
    },
    [teamHubInfo]
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

  const resetForProjectSwitch = useCallback(() => {
    setTeams([]);
    // refreshTeamHistory effect が projectRoot 変更で自動的に再ロードする
  }, []);

  // 派生値 (将来 Canvas 側でも使えるよう Memo 化しておく — 現状は内部利用のみ)
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const _teamsByIdMap = useMemo(() => {
    const m = new Map<string, Team>();
    for (const x of teams) m.set(x.id, x);
    return m;
  }, [teams]);

  return {
    teams,
    teamHistoryEntries,
    doCloseTeam,
    handleCloseLeaderOnly,
    handleResumeTeam,
    handleDeleteTeamHistory,
    handleTerminalSessionId,
    persistTerminalCustomLabel,
    getTerminalArgs,
    getCodexInstructions,
    getRolePrompt,
    getTerminalEnv,
    resetForProjectSwitch
  };
}
