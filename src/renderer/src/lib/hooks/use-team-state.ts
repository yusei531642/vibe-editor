/**
 * use-team-state — 旧 `use-team-management.ts` (524 行) のうち
 *   - ランタイム `teams` 配列の保持
 *   - チーム作成時のメンバースポーン遅延タイマー (`spawnStaggerTimers`)
 *   - チーム破棄系 handler (`doCloseTeam` / `handleCloseLeaderOnly`)
 *   - TeamHub 接続情報 (`teamHubInfo`) の取得
 *   - プロジェクト切替時の reset
 * を担当する。Issue #487 でファイル分割 (use-team-state / -history-sync /
 * -launch-helpers) の 1 本目。挙動は不変、構造のみ整理。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Team } from '../../../../types/shared';
import type { AddTerminalTabOptions, TerminalTab } from './use-terminal-tabs';

type ToastFn = (
  msg: string,
  opts?: { tone?: 'info' | 'success' | 'warning' | 'error' }
) => void;

export interface TeamHubInfo {
  socket: string;
  token: string;
}

export interface UseTeamStateOptions {
  projectRoot: string;
  showToast: ToastFn;
  // ---- Phase 1-3 hook 戻り値ブリッジ ----
  setTerminalTabs: React.Dispatch<React.SetStateAction<TerminalTab[]>>;
  setActiveTerminalTabId: React.Dispatch<React.SetStateAction<number>>;
  nextTerminalIdRef: React.MutableRefObject<number>;
  addTerminalTab: (opts?: AddTerminalTabOptions) => number | null;
  doCloseTab: (tabId: number) => void;
}

export interface UseTeamStateResult {
  teams: Team[];
  setTeams: React.Dispatch<React.SetStateAction<Team[]>>;
  teamHubInfo: TeamHubInfo | null;
  /** team 作成時に予約した spawn timer をすべて停止する。`use-team-history-sync` の
   *  unmount cleanup から呼ぶことでアンマウント直前に未発火 timer を必ず停止できる。 */
  clearSpawnTimers: () => void;
  doCloseTeam: (teamId: string) => void;
  handleCloseLeaderOnly: (tabId: number, teamId: string) => void;
  /** プロジェクト切替時の reset (teams 空配列に戻す)。team-history は別 hook の
   *  effect が projectRoot 変更を見て自動 reload する。 */
  resetForProjectSwitch: () => void;
}

export function useTeamState(opts: UseTeamStateOptions): UseTeamStateResult {
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const [teams, setTeams] = useState<Team[]>([]);

  /** チーム作成時のメンバースポーン遅延タイマー。破棄時にクリアできるよう保持 */
  const spawnStaggerTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const clearSpawnTimers = useCallback(() => {
    for (const timer of spawnStaggerTimers.current) clearTimeout(timer);
    spawnStaggerTimers.current = [];
  }, []);

  /** TeamHub 接続情報 (アプリ起動時に 1 回だけ解決)。 */
  const [teamHubInfo, setTeamHubInfo] = useState<TeamHubInfo | null>(null);
  useEffect(() => {
    void window.api.app.getTeamHubInfo().then((info) => setTeamHubInfo(info));
  }, []);

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
          .catch((err) =>
            console.warn('[team] cleanup after closeLeaderOnly failed:', err)
          );
      }
    },
    []
  );

  const resetForProjectSwitch = useCallback(() => {
    setTeams([]);
    // team-history は別 hook (use-team-history-sync) が projectRoot 変更で自動再ロード。
  }, []);

  return {
    teams,
    setTeams,
    teamHubInfo,
    clearSpawnTimers,
    doCloseTeam,
    handleCloseLeaderOnly,
    resetForProjectSwitch
  };
}
