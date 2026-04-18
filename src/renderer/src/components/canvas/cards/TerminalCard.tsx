/**
 * TerminalCard — Canvas 上で 1 つの Claude/Codex/シェル端末を表示するカード。
 *
 * Phase 2 MVP: TerminalView をそのまま埋め込む。
 * payload で渡される {agent, role, teamId, command, args, cwd, agentId, resumeSessionId} を
 * TerminalView に伝える。Phase 3 で AgentNodeCard (ロール色) に派生させる。
 */
import { memo, useMemo, useRef, useState } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { CardFrame } from '../CardFrame';
import { TerminalView, type TerminalViewHandle } from '../../TerminalView';
import { useSettings } from '../../../lib/settings-context';
import { buildTeamSystemPrompt, type TeamMemberSeed } from '../../../lib/team-roles';
import type { TeamRole } from '../../../../../types/shared';

interface TerminalPayload {
  agent?: 'claude' | 'codex';
  role?: string;
  teamId?: string;
  teamName?: string;
  agentId?: string;
  command?: string;
  args?: string[];
  cwd?: string;
  /** Issue #22: Canvas から Resume 起動したときの Claude セッション id。
   *  Claude の場合は args に `--resume <id>` を追加して既存会話を再開する。 */
  resumeSessionId?: string | null;
  /** Issue #63: team member 全員 (buildTeamSystemPrompt 用)。Canvas から Resume 経路で渡される。 */
  teamMembers?: TeamMemberSeed[];
}

function TerminalCardImpl({ id, data }: NodeProps): JSX.Element {
  const ref = useRef<TerminalViewHandle | null>(null);
  const { settings } = useSettings();
  const payload = (data?.payload ?? {}) as TerminalPayload;
  const title = (data?.title as string) ?? 'Terminal';
  const [, setStatus] = useState<string>('');

  // Issue #23: 現在開いているプロジェクト (lastOpenedRoot) を最優先。
  // claudeCwd / payload.cwd は fallback として残す。
  const cwd = settings.lastOpenedRoot || settings.claudeCwd || payload.cwd || '';
  const isCodex = payload.agent === 'codex';
  const command = payload.command ?? (isCodex ? settings.codexCommand : settings.claudeCommand);

  // Issue #22: resumeSessionId があり Claude 側なら --resume <id> を付与して起動。
  // Codex は `--resume` 非対応なので付けない (IDE 側 App.tsx:1396 と同じ条件)。
  // Issue #63: Codex では role/team の system prompt を --config で渡す必要がある。
  // Claude は Rust 側 terminal_create で VIBE_TEAM_* env が注入されるが、Codex はさらに
  // `codexInstructions` (system prompt) が必要なので buildTeamSystemPrompt から組み立てる。
  const codexInstructions = useMemo<string | undefined>(() => {
    if (!isCodex || !payload.teamId || !payload.role || !payload.agentId || !payload.teamMembers) {
      return undefined;
    }
    return buildTeamSystemPrompt(
      payload.agentId,
      payload.role as TeamRole,
      payload.teamName ?? 'Team',
      payload.teamMembers
    );
  }, [isCodex, payload.teamId, payload.role, payload.agentId, payload.teamMembers, payload.teamName]);

  const args = useMemo<string[] | undefined>(() => {
    const base = payload.args ? [...payload.args] : [];
    if (payload.resumeSessionId && !isCodex) {
      base.push('--resume', payload.resumeSessionId);
    }
    return base.length > 0 ? base : undefined;
  }, [payload.args, payload.resumeSessionId, isCodex]);

  return (
    <>
      <Handle type="target" position={Position.Left} style={{ background: '#7a7afd' }} />
      <CardFrame id={id} title={title}>
        <TerminalView
          ref={ref}
          cwd={cwd}
          fallbackCwd={cwd}
          command={command}
          args={args}
          visible={true}
          teamId={payload.teamId}
          agentId={payload.agentId}
          role={payload.role}
          codexInstructions={codexInstructions}
          onStatus={setStatus}
        />
      </CardFrame>
      <Handle type="source" position={Position.Right} style={{ background: '#7a7afd' }} />
    </>
  );
}

export default memo(TerminalCardImpl);
