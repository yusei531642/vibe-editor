import type { AppSettings, TeamMember, TerminalAgent } from '../../../types/shared';
import { allAgentOptions, type AgentOption } from './agent-resolver';

/**
 * 選択可能なエージェント一覧。built-in (claude/codex) + settings.customAgents を結合。
 * 旧 AGENTS 定数は customAgents 対応で削除し、settings を受ける関数化した。
 */
export function getAgents(settings: AppSettings): AgentOption[] {
  return allAgentOptions(settings);
}

/**
 * UI 上で「Leader 以外のロール」として選べる候補。
 *
 * v3 (architecture rework) で固定ワーカーロールは廃止された。Leader が
 * `team_recruit(role_definition=...)` で動的に作る前提なので、UI 上の選択候補も
 * ここでは空にする。`hr` だけは大量採用のヘルパとして残るが、起動時は Leader が
 * 必要に応じて recruit するので preset には入れない。
 */
export const MEMBER_ROLES: { value: string; label: string }[] = [];

/** ビルトインプリセット。`members` はリーダーを含まない */
export interface BuiltinPreset {
  name: string;
  leaderAgent: TerminalAgent;
  members: TeamMember[];
}

/**
 * 旧 builtin プリセット (Dev Duo / Full Team / Code Squad) は固定ロール撤廃に伴い廃止。
 * 「チーム起動」ボタンは Leader 単体だけを起動する Dynamic Team プリセット
 * (workspace-presets.ts) を直接呼び出し、Leader が動的にチームを編成する。
 */
export const BUILTIN_PRESETS: BuiltinPreset[] = [];

/**
 * Leader を `role: 'leader'` の TeamMember に変換し、非リーダーメンバーと連結した配列を返す。
 * TeamPreset.members と同じ「leader 込み」形式にそろえるユーティリティ。
 */
export function presetFromMembers(
  leaderAgent: TerminalAgent,
  members: TeamMember[]
): TeamMember[] {
  return [{ agent: leaderAgent, role: 'leader' }, ...members];
}

/**
 * 必要な pty 数が残席数に収まるかを判定する。
 * 呼び出し側は builtin (1 + members.length) / saved (members.length) を計算して渡す。
 */
export function canSpawnPreset(totalNeeded: number, remaining: number): boolean {
  return totalNeeded <= remaining;
}
