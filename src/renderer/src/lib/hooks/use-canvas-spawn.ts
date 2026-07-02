import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type {
  AgentConfig,
  TeamHistoryEntry,
  TeamOrganizationMeta,
  TeamPreset
} from '../../../../types/shared';
import type { CardType } from '../../stores/canvas';
import { NODE_H, NODE_W, useCanvasStore } from '../../stores/canvas';
import { engineForAgentConfig } from '../agent-registry';
import {
  BUILTIN_PRESETS,
  expandPresetOrganizations,
  presetPosition,
  type WorkspacePreset
} from '../workspace-presets';
import { ROLE_META } from '../team-roles';
import { useSettings } from '../settings-context';
import { useToast } from '../toast-context';
import { useT } from '../i18n';
import {
  spawnTeam,
  spawnTeams,
  type SpawnTeamMember,
  type SpawnTeamSpec
} from '../canvas-team-spawn';
import { findExistingTeamNode } from '../canvas-existing-team';
import { parseCustomAgentArgs } from '../parse-args';

interface UseCanvasSpawnOptions {
  projectRoot: string;
  /** 単体カードの staggered 配置 (use-canvas-add-card が所有する座標規則を借りる) */
  stagger: (kind: CardType) => { x: number; y: number };
}

export interface CanvasSpawnApi {
  /** team-history 由来の最近使ったチーム (auto-save 側と共有する) */
  recent: TeamHistoryEntry[];
  setRecent: Dispatch<SetStateAction<TeamHistoryEntry[]>>;
  /** canvasState 付きの直近 6 件 (spawn ポップオーバー [最近] タブ用) */
  closeRecent: TeamHistoryEntry[];
  applyPreset: (preset: WorkspacePreset) => Promise<void>;
  applySavedPreset: (preset: TeamPreset) => Promise<void>;
  applyCustomAgentLeaderPreset: (agent: AgentConfig) => Promise<void>;
  restoreRecent: (entry: TeamHistoryEntry) => Promise<void>;
  spawnTeamPresetById: (presetId: string) => Promise<{ ok: boolean; message?: string }>;
}

/**
 * チーム起動 (builtin preset / 保存済み preset / custom agent leader / recent 復元) を
 * 所有する hook。Issue #1032: CanvasLayout の god-file 分割で切り出し。
 * Issue #611: 3 経路とも spawnTeam(s) helper を経由し、teamId 発行 / setupTeamMcp /
 * agentId 採番 / 配置整理のドリフトを防ぐ、という不変条件はこのモジュールに閉じる。
 * ポップオーバーの開閉は UI 側 (CanvasSpawnFab) の責務で、この hook は関与しない。
 */
export function useCanvasSpawn({ projectRoot, stagger }: UseCanvasSpawnOptions): CanvasSpawnApi {
  const addCards = useCanvasStore((s) => s.addCards);
  const notifyRecruit = useCanvasStore((s) => s.notifyRecruit);
  const { settings } = useSettings();
  const { showToast } = useToast();
  const t = useT();
  const [recent, setRecent] = useState<TeamHistoryEntry[]>([]);

  const loadRecent = useCallback(async (): Promise<void> => {
    if (!projectRoot) return;
    try {
      const list = await window.api.teamHistory.list(projectRoot);
      setRecent(list);
    } catch (err) {
      console.warn('[recent] load failed:', err);
    }
  }, [projectRoot]);

  useEffect(() => {
    void loadRecent();
  }, [loadRecent]);

  const closeRecent = useMemo(
    () => recent.filter((r) => r.canvasState && r.canvasState.nodes.length > 0).slice(0, 6),
    [recent]
  );

  const applyPreset = async (preset: WorkspacePreset): Promise<void> => {
    const cwd = projectRoot;
    const presetName = t(preset.i18nKey);
    const organizations = expandPresetOrganizations(preset, t, presetName);
    // Issue #611: builtin / user / history の 3 経路で共通の spawnTeams helper を経由する。
    //   teamId 発行 / setupTeamMcp / agentId 採番 / 配置整理を helper に集約してドリフトを防ぐ。
    const teams: SpawnTeamSpec[] = organizations.map((org) => {
      const teamId = `team-${crypto.randomUUID()}`;
      const organization: TeamOrganizationMeta = { id: teamId, ...org.meta };
      const members: SpawnTeamMember[] = org.members.map((m) => ({
        role: m.role,
        agent: m.agent === 'codex' ? 'codex' : 'claude',
        position: presetPosition(m.col, m.row),
        // Issue #69: 未知 role でもクラッシュしないよう fallback
        title: ROLE_META[m.role]?.label ?? m.role ?? 'Agent'
      }));
      return { teamId, teamName: organization.name, organization, members };
    });
    const { cards } = await spawnTeams({
      cwd,
      teams,
      existingNodes: useCanvasStore.getState().nodes,
      mcpAutoSetup: settings.mcpAutoSetup !== false,
      setupTeamMcp: window.api.app.setupTeamMcp
    });
    const ids = addCards(cards);
    if (ids[0]) notifyRecruit(ids[0]);
    void loadRecent();
  };

  // Issue #1023: 保存済みプリセット (TeamPreset) を applyPreset と同じ spawnTeam 経路で展開する。
  //   TeamPresetsPanel.handleApply と等価: teamId 発行 / setupTeamMcp / cwd payload を共通化し、
  //   apply 後の agent が standalone 化しないようにする。layout が無い role は cascading 配置。
  const applySavedPreset = async (preset: TeamPreset): Promise<void> => {
    const teamId = `team-${crypto.randomUUID()}`;
    const baseX = 60;
    const baseY = 60;
    const stride = NODE_W + 40;
    const stepY = NODE_H + 40;
    const members: SpawnTeamMember[] = preset.roles.map((role, idx) => {
      const layoutEntry = preset.layout?.byRole[role.roleProfileId];
      const position = layoutEntry
        ? { x: layoutEntry.x, y: layoutEntry.y }
        : { x: baseX + (idx % 4) * stride, y: baseY + Math.floor(idx / 4) * stepY };
      return {
        role: role.roleProfileId,
        agent: role.agent === 'codex' ? 'codex' : 'claude',
        position,
        title: role.label ?? role.roleProfileId,
        customInstructions: role.customInstructions ?? undefined
      };
    });
    const { cards } = await spawnTeam({
      teamId,
      teamName: preset.name,
      cwd: projectRoot,
      members,
      existingNodes: useCanvasStore.getState().nodes,
      mcpAutoSetup: settings.mcpAutoSetup !== false,
      setupTeamMcp: window.api.app.setupTeamMcp
    });
    const ids = addCards(cards);
    if (ids[0]) notifyRecruit(ids[0]);
    void loadRecent();
  };

  // Issue #1025: custom agent を「Leader として起動」する。新規 teamId を発行し、
  //   custom agent を leader ロール (recruit 可能) の単体メンバーとして起動する。
  //   起動経路は use-recruit-listener の API/CLI 分岐に倣う:
  //     - API: apiAgent カードが teamId + teamRole で Hub に self-register (#1004/#1005)。
  //            setupTeamMcp は CLI 用なので呼ばない。
  //     - CLI: agent カードを custom command override で起動 + setupTeamMcp 配線
  //            (組み込み leader と同経路)。CLI は claude 互換を前提に team tool を有効化。
  const applyCustomAgentLeaderPreset = async (agent: AgentConfig): Promise<void> => {
    const cwd = projectRoot;
    const teamId = `team-${crypto.randomUUID()}`;
    const agentId = `leader-0-${teamId}`;
    const teamName = agent.name || agent.id;
    const position = stagger('agent');
    if (agent.runtime === 'api') {
      addCards([
        {
          type: 'apiAgent',
          title: teamName,
          position,
          payload: {
            agentId,
            agentConfigId: agent.id,
            providerId: agent.providerId,
            model: agent.model,
            toolMode: agent.toolMode ?? 'auto',
            configured: true,
            teamId,
            teamName,
            // teamRole が teamId と揃うと team tool が有効化される (#1004/#1005)。
            teamRole: 'leader'
          }
        }
      ]);
    } else {
      // CLI custom agent: 組み込み leader と同様に MCP team tool を配線する。
      // Issue #1113: engine は custom 定義の engine (default 'claude') を尊重する (registry に集約)。
      const engine = engineForAgentConfig(agent);
      if (settings.mcpAutoSetup !== false) {
        try {
          await window.api.app.setupTeamMcp(cwd, teamId, teamName, [
            { agentId, role: 'leader', agent: engine }
          ]);
        } catch (err) {
          console.warn('[custom-agent-preset] setupTeamMcp failed:', err);
        }
      }
      // Issue #1097: 起動前ガードレール — args の解析警告 (G1) / 明示モデル指定 (G2) を toast 可視化。
      const customArgs = parseCustomAgentArgs(agent.args);
      customArgs.warnings.forEach((w) => showToast(t(w.messageKey, w.params), { tone: 'warning' }));
      addCards([
        {
          type: 'agent',
          title: teamName,
          position,
          payload: {
            // CardFrame は payload.command を優先して custom CLI を起動する。
            agent: engine,
            // Issue #1113: custom agent の identity をカードへ伝える (名前/アイコン/色/skill 解決用)。
            agentConfigId: agent.id,
            command: agent.command || undefined,
            args: agent.args ? customArgs.args : undefined,
            cwd: agent.cwd || cwd,
            roleProfileId: 'leader',
            role: 'leader',
            teamId,
            teamName,
            agentId
          }
        }
      ]);
    }
    void loadRecent();
  };

  const restoreRecent = async (entry: TeamHistoryEntry): Promise<void> => {
    const existing = findExistingTeamNode(useCanvasStore.getState().nodes, entry.id);
    if (existing) {
      notifyRecruit(existing.id);
      showToast(t('teamHistory.alreadyOpen', { name: entry.name || entry.id }), {
        tone: 'info'
      });
      return;
    }

    const cwd = projectRoot || entry.projectRoot;
    // Issue #611 / #612: history-based 復元も spawnTeam 経由に統一。
    //   entry.latestHandoff / entry.organization の payload 同梱と placeBatchAwayFromNodes
    //   による衝突回避を applyPreset と同じ 1 関数で扱うことでドリフトを防ぐ。
    const members: SpawnTeamMember[] = entry.members.map((m, i) => {
      const fallbackAgentId = m.agentId ?? `${m.role}-${i}-${entry.id}`;
      const saved = entry.canvasState?.nodes.find((s) => s.agentId === fallbackAgentId);
      // Issue #385: 旧 team-history.json に NaN / Infinity / undefined な座標が残っていると、
      // 復元直後に React Flow が render 例外を出して Canvas 全体が黒画面になる。
      // 数値として有効でない場合は preset 配置にフォールバックする。
      const savedX = typeof saved?.x === 'number' && Number.isFinite(saved.x) ? saved.x : null;
      const savedY = typeof saved?.y === 'number' && Number.isFinite(saved.y) ? saved.y : null;
      const position =
        savedX !== null && savedY !== null
          ? { x: savedX, y: savedY }
          : presetPosition(i % 3, Math.floor(i / 3));
      return {
        role: m.role,
        agent: m.agent === 'codex' ? 'codex' : 'claude',
        position,
        // Issue #69: 未知 role でも落ちないよう optional chain
        title: ROLE_META[m.role]?.label ?? m.role ?? 'Agent',
        resumeSessionId: m.sessionId ?? null,
        // legacy team-history が保持していた特殊 agentId を尊重 (helper 側に明示渡し)
        agentId: m.agentId ?? undefined
      };
    });
    const { cards } = await spawnTeam({
      teamId: entry.id,
      teamName: entry.name,
      cwd,
      members,
      organization: entry.organization,
      latestHandoff: entry.latestHandoff,
      existingNodes: useCanvasStore.getState().nodes,
      mcpAutoSetup: settings.mcpAutoSetup !== false,
      setupTeamMcp: window.api.app.setupTeamMcp
    });
    const ids = addCards(cards);
    if (ids[0]) notifyRecruit(ids[0]);
    const updatedEntry: TeamHistoryEntry = {
      ...entry,
      lastUsedAt: new Date().toISOString()
    };
    setRecent((prev) =>
      [updatedEntry, ...prev.filter((item) => item.id !== updatedEntry.id)].sort((a, b) =>
        b.lastUsedAt.localeCompare(a.lastUsedAt)
      )
    );
    // Issue #642: save が外部変更を検知して merge した場合は team-history list を再取得して
    // setRecent を最新 disk 状態に同期する (= setRecent で push した updatedEntry は保持しつつ、
    // 他 entry の手編集を UI 上にも反映)。renderer の他の auto-save 経路 (saveBatch 等) を
    // 持つ caller も同様に `externalChangeMerged === true` を観測したら list 再取得すべき。
    void window.api.teamHistory
      .save(updatedEntry)
      .then((res) => {
        if (res?.externalChangeMerged === true) {
          console.info(
            '[team-history] external change merged on save; refreshing recent list'
          );
          window.api.teamHistory
            .list(projectRoot)
            .then(setRecent)
            .catch((err) => {
              console.warn('[team-history] refresh after external merge failed:', err);
            });
        }
      })
      .catch((err) => {
        console.warn('[restore] team_history_save failed:', err);
      });
  };

  /**
   * Issue #825: 音声指揮の `spawn_team_preset` から呼ばれる薄ラッパ。
   * BUILTIN_PRESETS を id で lookup して applyPreset へ転送する。
   * AI から渡される id を信頼せず、見つからなければ `ok: false` を返して AI に feedback する。
   *
   * applyPreset は closure で projectRoot / settings を参照しているため、
   * 直接 deps に入れると毎 render で identity が変わる。一方で
   * useVoiceRealtime 側は ioRef.current 経由で callback を読むため identity 安定は
   * 不要 (use-voice-realtime.ts の `ioRef.current = io` 参照)。
   * stale closure を避けつつ session の lifecycle を乱さないため、
   * ref で最新の applyPreset をブリッジする。
   */
  const applyPresetRef = useRef(applyPreset);
  useEffect(() => {
    applyPresetRef.current = applyPreset;
  });
  const spawnTeamPresetById = useCallback(
    async (presetId: string): Promise<{ ok: boolean; message?: string }> => {
      const preset = BUILTIN_PRESETS.find((p) => p.id === presetId);
      if (!preset) {
        return {
          ok: false,
          message: `Unknown preset id: ${presetId}`
        };
      }
      try {
        await applyPresetRef.current(preset);
        return {
          ok: true,
          message: `Team preset '${presetId}' spawned on the Canvas.`
        };
      } catch (err) {
        return {
          ok: false,
          message: err instanceof Error ? err.message : String(err)
        };
      }
    },
    []
  );

  return {
    recent,
    setRecent,
    closeRecent,
    applyPreset,
    applySavedPreset,
    applyCustomAgentLeaderPreset,
    restoreRecent,
    spawnTeamPresetById
  };
}
