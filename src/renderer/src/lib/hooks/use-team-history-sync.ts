/**
 * use-team-history-sync — 旧 `use-team-management.ts` (524 行) のうち
 *   - `teamHistoryEntries` state とプロジェクト変更時の reload
 *   - debounce save (500ms ごとに pending を flush) と unmount 即 flush
 *   - `handleResumeTeam` (履歴からチーム再構成 → MCP 再登録 → タブ spawn)
 *   - `handleDeleteTeamHistory`
 *   - `handleTerminalSessionId` (sessionId 検出時の history 更新)
 *   - `persistTerminalCustomLabel` (タブ手動リネーム時の history 反映)
 * を担当する。Issue #487 でファイル分割した 2 本目。挙動は不変、構造のみ整理。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Team, TeamHistoryEntry } from '../../../../types/shared';
import { useT } from '../i18n';
import { useSettingsValue } from '../settings-context';
import {
  MAX_TERMINALS,
  type AddTerminalTabOptions,
  type TerminalTab
} from './use-terminal-tabs';

type ToastFn = (
  msg: string,
  opts?: { tone?: 'info' | 'success' | 'warning' | 'error' }
) => void;

export interface UseTeamHistorySyncOptions {
  projectRoot: string;
  showToast: ToastFn;
  // ---- use-terminal-tabs ブリッジ ----
  terminalTabs: TerminalTab[];
  setTerminalTabs: React.Dispatch<React.SetStateAction<TerminalTab[]>>;
  addTerminalTab: (opts?: AddTerminalTabOptions) => number | null;
  // ---- use-team-state ブリッジ ----
  teams: Team[];
  setTeams: React.Dispatch<React.SetStateAction<Team[]>>;
  /** unmount 時に未発火 spawn timer を停止するため、use-team-state の clear を受け取る */
  clearSpawnTimers: () => void;
}

export interface UseTeamHistorySyncResult {
  teamHistoryEntries: TeamHistoryEntry[];
  handleResumeTeam: (entry: TeamHistoryEntry) => Promise<void>;
  handleDeleteTeamHistory: (entryId: string) => Promise<void>;
  handleTerminalSessionId: (tab: TerminalTab, sessionId: string) => void;
  persistTerminalCustomLabel: (tab: TerminalTab, trimmed: string) => void;
}

export function useTeamHistorySync(
  opts: UseTeamHistorySyncOptions
): UseTeamHistorySyncResult {
  const t = useT();
  const mcpAutoSetup = useSettingsValue('mcpAutoSetup');

  const optsRef = useRef(opts);
  optsRef.current = opts;

  const [teamHistoryEntries, setTeamHistoryEntries] = useState<TeamHistoryEntry[]>(
    []
  );

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
      optsRef.current.clearSpawnTimers();
    };
  }, [flushTeamHistoryNow]);

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

  const handleResumeTeam = useCallback(
    async (entry: TeamHistoryEntry) => {
      const {
        projectRoot,
        showToast,
        terminalTabs,
        setTerminalTabs,
        addTerminalTab,
        setTeams
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
        agentId: m.agentId ?? `${entry.id}-${m.role}-${i}`,
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

  return {
    teamHistoryEntries,
    handleResumeTeam,
    handleDeleteTeamHistory,
    handleTerminalSessionId,
    persistTerminalCustomLabel
  };
}
