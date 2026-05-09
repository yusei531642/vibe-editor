/**
 * Issue #611 / #612: Canvas に「team を spawn する」3 経路 (CanvasLayout の builtin
 * preset 適用 / TeamPresetsPanel のユーザー定義 preset 適用 / CanvasSidebar の
 * Recent Teams resume) で `teamId` 発行 / `setupTeamMcp` / `agentId` 採番 /
 * `placeBatchAwayFromNodes` / `latestHandoff` 同梱 などの責務がドリフトし、
 * AgentNodeCard 起動時に `--append-system-prompt` が外れたり、カードが重なって
 * 配置されたり、resume 後の handoff コンテキストが空になったりする regression が
 * 連発していた。
 *
 * このモジュールはその 4 つの責務を 1 つの helper にまとめる。3 経路はそれぞれの
 * 入力形 (builtin preset / user preset / TeamHistoryEntry) を `SpawnTeamSpec` に
 * 正規化してから `spawnTeam` / `spawnTeams` を呼ぶだけで一致した出力を得られる。
 *
 * 設計メモ:
 *  - `setupTeamMcp` の失敗は warn だけして agent spawn は続行する
 *    (mcp が未設定でも UI を完全に消すよりは「部分的に動く」方を優先)。
 *  - 配置は **すべての team の cards** を 1 つのバッチに連結してから 1 度だけ
 *    `placeBatchAwayFromNodes` を呼ぶ。複数 organization を一括展開する builtin
 *    preset で 1 organization 目に対して 2 organization 目が衝突するのを防ぐ。
 *  - `agentId` は `${role}-${index}-${teamId}` を canonical 形にする。caller が
 *    legacy team-history の `m.agentId` を尊重したい場合は member に明示指定できる。
 */

import type { Node } from '@xyflow/react';
import type {
  HandoffReference,
  TeamOrganizationMeta
} from '../../../types/shared';
import { placeBatchAwayFromNodes } from './canvas-placement';
import type { CardData } from '../stores/canvas';
import type { AgentPayload } from '../components/canvas/cards/AgentNodeCard/types';

export interface SpawnTeamMember {
  /** roleProfileId / role 兼用 (新スキーマ + 旧コード互換)。 */
  role: string;
  agent: 'claude' | 'codex';
  position: { x: number; y: number };
  /** カードヘッダーに表示する label。caller 側で ROLE_META 等から解決して渡す。 */
  title: string;
  /** team_recruit 時に追加する custom_instructions (生テキスト)。 */
  customInstructions?: string;
  /** Claude Code セッション復元用 (`claude --resume <id>`)。 */
  resumeSessionId?: string | null;
  /**
   * Legacy team-history が保存していた特殊な agentId を尊重したい場合のみ指定。
   * 未指定なら canonical 形 `${role}-${index}-${teamId}` を helper 側で生成する。
   */
  agentId?: string;
}

export interface SpawnTeamSpec {
  /** team 識別子。新規 spawn は caller 側で `team-${crypto.randomUUID()}` を発行。 */
  teamId: string;
  /** setupTeamMcp の display 用 name。 */
  teamName: string;
  members: SpawnTeamMember[];
  /** 同時運用する複数組織の 1 単位。user preset 経路では undefined。 */
  organization?: TeamOrganizationMeta;
  /** 履歴復元時に payload へ同梱する直近 handoff 参照 (Issue #612)。 */
  latestHandoff?: HandoffReference;
}

export type SetupTeamMcpFn = (
  cwd: string,
  teamId: string,
  teamName: string,
  members: { agentId: string; role: string; agent: 'claude' | 'codex' }[]
) => Promise<unknown>;

export interface SpawnTeamsInput {
  cwd: string;
  teams: SpawnTeamSpec[];
  /** placeBatchAwayFromNodes の衝突参照に使う、現在 Canvas 上にあるノード群。 */
  existingNodes: readonly Node<CardData>[];
  /** false なら setupTeamMcp を呼ばない (settings.mcpAutoSetup === false 相当)。 */
  mcpAutoSetup: boolean;
  /** test 用注入。本番では window.api.app.setupTeamMcp を渡す。 */
  setupTeamMcp: SetupTeamMcpFn;
}

export interface SpawnedTeamCard {
  type: 'agent';
  title: string;
  position: { x: number; y: number };
  payload: AgentPayload;
}

export interface SpawnTeamsResult {
  cards: SpawnedTeamCard[];
}

function buildAgentId(member: SpawnTeamMember, index: number, teamId: string): string {
  return member.agentId ?? `${member.role}-${index}-${teamId}`;
}

/** 共通実装: 複数 team を一括 spawn する。 */
export async function spawnTeams(input: SpawnTeamsInput): Promise<SpawnTeamsResult> {
  if (input.mcpAutoSetup) {
    for (const team of input.teams) {
      try {
        await input.setupTeamMcp(
          input.cwd,
          team.teamId,
          team.teamName,
          team.members.map((m, i) => ({
            agentId: buildAgentId(m, i, team.teamId),
            role: m.role,
            agent: m.agent
          }))
        );
      } catch (err) {
        // setupTeamMcp が失敗しても agent spawn は続行する。MCP 未設定でも UI を
        // 完全に消すよりは部分的にでも動かす方をユーザーは好む (Issue #72 議論より)。
        console.warn('[spawn-team] setupTeamMcp failed:', err);
      }
    }
  }
  const rawCards: SpawnedTeamCard[] = input.teams.flatMap((team) =>
    team.members.map((m, i) => {
      const agentId = buildAgentId(m, i, team.teamId);
      const payload: AgentPayload = {
        agent: m.agent,
        roleProfileId: m.role,
        role: m.role,
        teamId: team.teamId,
        agentId,
        cwd: input.cwd
      };
      if (team.organization) payload.organization = team.organization;
      if (m.customInstructions !== undefined && m.customInstructions !== '') {
        payload.customInstructions = m.customInstructions;
      }
      if (m.resumeSessionId !== undefined) payload.resumeSessionId = m.resumeSessionId;
      if (team.latestHandoff) payload.latestHandoff = team.latestHandoff;
      return {
        type: 'agent' as const,
        title: m.title,
        position: m.position,
        payload
      };
    })
  );
  return { cards: placeBatchAwayFromNodes(input.existingNodes, rawCards) };
}

/** 単一 team の薄い wrapper。TeamPresetsPanel / CanvasSidebar はこちらを使う。 */
export async function spawnTeam(
  input: Omit<SpawnTeamsInput, 'teams'> & SpawnTeamSpec
): Promise<SpawnTeamsResult> {
  const { cwd, existingNodes, mcpAutoSetup, setupTeamMcp, ...spec } = input;
  return spawnTeams({ cwd, teams: [spec], existingNodes, mcpAutoSetup, setupTeamMcp });
}
