/**
 * TerminalCard — Canvas 上で 1 つの Claude/Codex/シェル端末を表示するカード。
 *
 * Phase 2 MVP: TerminalView をそのまま埋め込む。
 * payload で渡される {agent, role, teamId, command, args, cwd, agentId, resumeSessionId} を
 * TerminalView に伝える。Phase 3 で AgentNodeCard (ロール色) に派生させる。
 */
import { memo, useCallback, useMemo, useRef, useState } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { CardFrame } from '../CardFrame';
import { TerminalView, type TerminalViewHandle } from '../../TerminalView';
import { useSettings } from '../../../lib/settings-context';
import { useCanvasStore } from '../../../stores/canvas';
import { useCanvasTerminalFit } from '../../../lib/use-canvas-terminal-fit';

interface TerminalPayload {
  agent?: 'claude' | 'codex';
  role?: string;
  teamId?: string;
  agentId?: string;
  command?: string;
  args?: string[];
  cwd?: string;
  /** Issue #22: Canvas から Resume 起動したときの Claude セッション id。
   *  Claude の場合は args に `--resume <id>` を追加して既存会話を再開する。 */
  resumeSessionId?: string | null;
  /** Issue #63: Codex の role system prompt (一時ファイル化されて model_instructions_file へ)。
   *  Canvas から team 外の Codex を起動するケースでも使えるよう payload 経由で渡せるようにする。 */
  codexInstructions?: string;
}

function TerminalCardImpl({ id, data }: NodeProps): JSX.Element {
  const ref = useRef<TerminalViewHandle | null>(null);
  const { settings } = useSettings();
  const payload = (data?.payload ?? {}) as TerminalPayload;
  const title = (data?.title as string) ?? 'Terminal';
  const [, setStatus] = useState<string>('');
  const setCardPayload = useCanvasStore((s) => s.setCardPayload);
  // Issue #253: Canvas zoom 下でも論理 px ベースで cols/rows を確定させる
  const fit = useCanvasTerminalFit(settings);

  // Claude Code が新規セッションを作ったら、その session id を payload に書き戻す。
  // localStorage 永続化された payload に乗るので、アプリ再起動 / カード再マウント時に
  // 自動的に `--resume <id>` で前回会話を復元できる。
  const handleSessionId = useCallback(
    (sessionId: string) => {
      if (!sessionId) return;
      setCardPayload(id, { resumeSessionId: sessionId });
    },
    [id, setCardPayload]
  );

  // Issue #23: 現在開いているプロジェクト (lastOpenedRoot) を最優先。
  // claudeCwd / payload.cwd は fallback として残す。
  const cwd = settings.lastOpenedRoot || settings.claudeCwd || payload.cwd || '';
  const isCodex = payload.agent === 'codex';
  const command = payload.command ?? (isCodex ? settings.codexCommand : settings.claudeCommand);

  // Issue #22: resumeSessionId があり Claude 側なら --resume <id> を付与して起動。
  // Codex は `--resume` 非対応なので付けない (IDE 側 App.tsx:1396 と同じ条件)。
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
          // Issue #63: payload.codexInstructions を TerminalView に伝播
          codexInstructions={payload.codexInstructions}
          onStatus={setStatus}
          onSessionId={handleSessionId}
          // Canvas zoom で滲まないよう WebGL を切る (DOM renderer 固定)
          disableWebgl
          // Issue #253: 論理 px ベース fit + zoom 購読 + 可観測性
          unscaledFit={fit.unscaledFit}
          getCellSize={fit.getCellSize}
          zoomSubscribe={fit.zoomSubscribe}
          getZoom={fit.getZoom}
        />
      </CardFrame>
      <Handle type="source" position={Position.Right} style={{ background: '#7a7afd' }} />
    </>
  );
}

export default memo(TerminalCardImpl);
