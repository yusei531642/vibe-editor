/**
 * TerminalCard — Canvas 上で 1 つの Claude/Codex/シェル端末を表示するカード。
 *
 * Phase 2 MVP: TerminalView をそのまま埋め込む。
 * payload で渡される {agent, role, teamId, command, args, cwd, agentId, resumeSessionId} を
 * TerminalView に伝える。Phase 3 で AgentNodeCard (ロール色) に派生させる。
 */
import { memo, useCallback, useMemo, useRef, useState } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { CardFrame } from '../CardFrame';
import { TerminalView, type TerminalViewHandle } from '../../TerminalView';
import { useSettings } from '../../../lib/settings-context';
import { useCanvasStore, NODE_MIN_W, NODE_MIN_H } from '../../../stores/canvas';
import type { CardDataOf } from '../../../stores/canvas';
import { useUiStore } from '../../../stores/ui';
import { useCanvasTerminalFit } from '../../../lib/use-canvas-terminal-fit';
import { useXtermScrollToBottomOnResize } from '../../../lib/use-xterm-scroll-on-resize';

// Issue #732: payload 型 (旧ローカル `TerminalPayload`) は canvas store の判別可能 union
// 側 `TerminalCardPayload` に集約。`NodeProps` を `Node<CardDataOf<'terminal'>>` で具体化し、
// `data.payload` の inline cast を撤廃する。
function TerminalCardImpl({ id, data }: NodeProps<Node<CardDataOf<'terminal'>>>): JSX.Element {
  const ref = useRef<TerminalViewHandle | null>(null);
  // Issue #272: NodeResizer でカードをリサイズしたとき、内部 `.xterm-viewport`
  // の scrollTop が古い値で残り最終行が下端で見切れるのを防ぐため、
  // wrapper div の ref を ResizeObserver に渡して末尾追従させる。
  const termContainerRef = useRef<HTMLDivElement | null>(null);
  const { settings } = useSettings();
  const payload = data?.payload ?? {};
  const title = (data?.title as string) ?? 'Terminal';
  const [, setStatus] = useState<string>('');
  const setCardPayload = useCanvasStore((s) => s.setCardPayload);
  const isCanvasActive = useUiStore((s) => s.viewMode === 'canvas');
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

  // Issue #272 / #272 v3: AgentNodeCard と同じ「リサイズ後に末尾までスクロール」補正を適用。
  // xterm v6 の SmoothScrollableElement は内部 scroll model で scrollback を管理するため、
  // DOM の scrollTop ではなく `Terminal.scrollToBottom()` を public API 経由で叩く。
  const scrollToBottom = useCallback(() => {
    ref.current?.scrollToBottom();
  }, []);
  useXtermScrollToBottomOnResize(termContainerRef, scrollToBottom);

  return (
    <>
      <Handle type="target" position={Position.Left} style={{ background: '#7a7afd' }} />
      <CardFrame id={id} title={title} minWidth={NODE_MIN_W} minHeight={NODE_MIN_H}>
        {/* Issue #327: AgentNodeCard と同じく `nodrag nowheel` を付与する。
            これが無いと React Flow がノード全体で pointerdown を奪い、xterm v6 の
            custom scrollbar thumb をマウスでドラッグできない (= ホイールは効くが
            scrollbar が掴めない) 状態になる。Claude 側は Spawn Team 経由で
            AgentNodeCard に乗るため既に nodrag があったが、Codex 等を「Terminal」
            カードとして直接立ち上げると TerminalCard 経由で出るためここで揃える。
            nowheel は AgentNodeCard と対称にし、wheel イベントを React Flow の
            zoom/pan に奪わせない。xterm.js への wheel 配送は内部処理で完結する。 */}
        <div className="nodrag nowheel canvas-terminal-card__term" ref={termContainerRef}>
          <TerminalView
            ref={ref}
            // Issue #271: HMR remount で同じ PTY へ再 bind するための論理キー。
            // Canvas のノード id は永続化された安定識別子なので、HMR 復帰経路の鍵に使える。
            sessionKey={`canvas-term:${id}`}
            cwd={cwd}
            fallbackCwd={cwd}
            command={command}
            args={args}
            // Issue #564: IDE モードでは CanvasLayout が非表示のまま mount される。
            // その状態で PTY を起動しないよう、Canvas 表示中だけ TerminalView を起動可能にする。
            visible={isCanvasActive}
            teamId={payload.teamId}
            agentId={payload.agentId}
            role={payload.role}
            // Issue #63: payload.codexInstructions を TerminalView に伝播
            codexInstructions={payload.codexInstructions}
            onStatus={setStatus}
            onSessionId={handleSessionId}
            // Canvas zoom で滲まないよう WebGL を切る (DOM renderer 固定)
            disableWebgl
            // Issue #272 v4: Canvas モードではホイールを scrollback スクロールへ強制ルーティング
            // (xterm mouse protocol が wheel を消費して scrollback が動かない問題の対策)
            forceWheelScrollback
            // Issue #253: 論理 px ベース fit + zoom 購読 + 可観測性
            unscaledFit={fit.unscaledFit}
            getCellSize={fit.getCellSize}
            zoomSubscribe={fit.zoomSubscribe}
            getZoom={fit.getZoom}
          />
        </div>
      </CardFrame>
      <Handle type="source" position={Position.Right} style={{ background: '#7a7afd' }} />
    </>
  );
}

export default memo(TerminalCardImpl);
