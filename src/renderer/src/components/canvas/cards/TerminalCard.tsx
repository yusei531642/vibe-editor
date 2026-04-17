/**
 * TerminalCard — Canvas 上で 1 つの Claude/Codex/シェル端末を表示するカード。
 *
 * Phase 2 MVP: TerminalView をそのまま埋め込む。
 * payload で渡される {agent, role, teamId, command, args, cwd, agentId} を TerminalView に伝える。
 * Phase 3 で AgentNodeCard (ロール色) に派生させる。
 */
import { memo, useRef, useState } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { CardFrame } from '../CardFrame';
import { TerminalView, type TerminalViewHandle } from '../../TerminalView';
import { useSettings } from '../../../lib/settings-context';

interface TerminalPayload {
  agent?: 'claude' | 'codex';
  role?: string;
  teamId?: string;
  agentId?: string;
  command?: string;
  args?: string[];
  cwd?: string;
}

function TerminalCardImpl({ id, data }: NodeProps): JSX.Element {
  const ref = useRef<TerminalViewHandle | null>(null);
  const { settings } = useSettings();
  const payload = (data?.payload ?? {}) as TerminalPayload;
  const title = (data?.title as string) ?? 'Terminal';
  const [, setStatus] = useState<string>('');

  const cwd = settings.claudeCwd || payload.cwd || '';
  const command =
    payload.command ?? (payload.agent === 'codex' ? settings.codexCommand : settings.claudeCommand);

  return (
    <>
      <Handle type="target" position={Position.Left} style={{ background: '#7a7afd' }} />
      <CardFrame id={id} title={title}>
        <TerminalView
          ref={ref}
          cwd={cwd}
          fallbackCwd={cwd}
          command={command}
          args={payload.args}
          visible={true}
          teamId={payload.teamId}
          agentId={payload.agentId}
          role={payload.role}
          onStatus={setStatus}
        />
      </CardFrame>
      <Handle type="source" position={Position.Right} style={{ background: '#7a7afd' }} />
    </>
  );
}

export default memo(TerminalCardImpl);
