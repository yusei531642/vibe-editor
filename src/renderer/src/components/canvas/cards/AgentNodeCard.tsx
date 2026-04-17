/**
 * AgentNodeCard — チームメンバー (claude/codex のロール持ち端末) を表すカード。
 *
 * TerminalCard の派生で、視覚要素を強化:
 *   - ヘッダー左にロール色のアバター (1 文字 + 背景円)
 *   - 枠線/接続点の色をロール色に揃える
 *   - ステータスバッジ (idle/thinking/typing) を将来用に右上に配置 (Phase 3+)
 *
 * payload: TerminalPayload + role 必須
 */
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Handle, NodeResizer, Position, type NodeProps } from '@xyflow/react';
import type { TeamRole } from '../../../../../types/shared';
import { TerminalView, type TerminalViewHandle } from '../../TerminalView';
import { useSettings } from '../../../lib/settings-context';
import { useCanvasStore } from '../../../stores/canvas';
import {
  buildTeamSystemPrompt,
  colorOf,
  metaOf,
  type TeamMemberSeed
} from '../../../lib/team-roles';
import { parseShellArgs } from '../../../lib/parse-args';

interface AgentPayload {
  agent?: 'claude' | 'codex';
  role?: string;
  teamId?: string;
  agentId?: string;
  command?: string;
  args?: string[];
  cwd?: string;
}

type AgentStatus = 'idle' | 'thinking' | 'typing';

/**
 * pty 起動時の status 文字列 ("実行中: claude --append-system-prompt ...long text...") を
 * 最初のフラグ/引数まで切り詰める。チームプロンプトなど巨大な文字列がヘッダに溢れるのを防ぐ。
 */
function shortStatus(s: string): string {
  // "実行中: claude --append-system-prompt あなたは..." → "実行中: claude"
  const m = s.match(/^(\S+:\s*)?([^\s]+)/);
  if (m) return `${m[1] ?? ''}${m[2]}`;
  return s.length > 32 ? s.slice(0, 32) + '…' : s;
}

/**
 * デフォルト (auto-summary 上書き対象) のタイトルかを判定。
 * "Claude #1" / "Codex #2" / "Leader" 等は上書き OK、ユーザーが手で付けた名前は守る。
 */
function isAutoTitle(t: string): boolean {
  return /^(Claude|Codex|Agent|Leader|Planner|Programmer|Researcher|Reviewer)( #\d+)?$/i.test(
    t.trim()
  );
}

/** ユーザー入力テキストから「機能追加」のような短いタイトルを抽出 */
function summarizeInput(text: string): string {
  const cleaned = text
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length === 0) return '';
  // 30 文字で切り詰め、句読点で更に切る
  const cut = cleaned.slice(0, 30);
  const punct = cut.search(/[。．、,]/);
  return punct > 4 ? cut.slice(0, punct) : cut;
}

function AgentNodeCardImpl({ id, data }: NodeProps): JSX.Element {
  const ref = useRef<TerminalViewHandle | null>(null);
  const { settings } = useSettings();
  const removeCard = useCanvasStore((s) => s.removeCard);
  const setCardTitle = useCanvasStore((s) => s.setCardTitle);
  const payload = (data?.payload ?? {}) as AgentPayload;
  const meta = metaOf(payload.role);
  const accent = colorOf(payload.role);
  const title = (data?.title as string) ?? meta?.label ?? 'Agent';
  const [status, setStatus] = useState<string>('');
  // Phase 4: ステータスバッジ。出力を最近受け取ったら typing、暫く来なければ idle。
  const [activity, setActivity] = useState<AgentStatus>('idle');
  const lastActivityRef = useRef(0);
  const handleActivity = (): void => {
    lastActivityRef.current = performance.now();
    setActivity('typing');
  };
  // 600ms 何も無ければ idle に戻す
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (performance.now() - lastActivityRef.current > 600) {
        setActivity((prev) => (prev !== 'idle' ? 'idle' : prev));
      }
    }, 200);
    return () => window.clearInterval(timer);
  }, []);

  // ----- ユーザー入力から auto-summary タイトル -----
  // 入力をバッファし、Enter (\r) を押した瞬間にバッファ内容をタイトル化する。
  // 既にユーザーが手で名付けた (auto title 形式でない) 場合は上書きしない。
  const inputBufferRef = useRef('');
  const handleUserInput = (raw: string): void => {
    if (!raw) return;
    // 制御コードのうち BS, ESC, 矢印キー等は無視。Enter (\r/\n) は確定トリガ。
    for (const ch of raw) {
      const code = ch.charCodeAt(0);
      if (ch === '\r' || ch === '\n') {
        const text = inputBufferRef.current;
        inputBufferRef.current = '';
        const summary = summarizeInput(text);
        if (summary && isAutoTitle(title)) {
          setCardTitle(id, summary);
        }
      } else if (code === 0x7f || code === 0x08) {
        // Backspace
        inputBufferRef.current = inputBufferRef.current.slice(0, -1);
      } else if (code === 0x1b) {
        // ESC シーケンス開始 → 同チャンク内の残りも捨てる近似
        return;
      } else if (code >= 0x20) {
        inputBufferRef.current += ch;
        // 暴走防止: 200 文字超えたらリセット
        if (inputBufferRef.current.length > 200) {
          inputBufferRef.current = inputBufferRef.current.slice(-200);
        }
      }
    }
  };

  // workspace を settings.claudeCwd に統一: 変更時は usePtySession (deps=[cwd, command]) が
  // PTY を kill → 新しい cwd で re-spawn する。payload.cwd は legacy fallback。
  const cwd = settings.claudeCwd || payload.cwd || '';
  const command =
    payload.command ?? (payload.agent === 'codex' ? settings.codexCommand : settings.claudeCommand);

  // ----- チームのシステムプロンプトを構築 -----
  // 同 teamId の AgentNode カード群から roster を作成。
  // 注意: useCanvasStore のセレクタで .filter().map() を返すと毎回新しい配列参照
  // になり Object.is 比較で再レンダー無限ループになる。なので生 nodes を購読し、
  // useMemo 内で派生する。
  const allNodes = useCanvasStore((s) => s.nodes);
  const teamMembers = useMemo<TeamMemberSeed[] | null>(() => {
    if (!payload.teamId) return null;
    return allNodes
      .filter((n) => n.type === 'agent')
      .map((n) => n.data?.payload as AgentPayload | undefined)
      .filter((p): p is AgentPayload => !!p && p.teamId === payload.teamId && !!p.agentId && !!p.role)
      .map<TeamMemberSeed>((p) => ({
        agentId: p.agentId!,
        role: p.role as TeamRole,
        agent: (p.agent ?? 'claude') as 'claude' | 'codex'
      }));
  }, [allNodes, payload.teamId]);

  const sysPrompt = useMemo(() => {
    if (!teamMembers || !payload.teamId || !payload.agentId || !payload.role) return undefined;
    if (teamMembers.length < 2) return undefined; // 1 人だけならチームではない
    return buildTeamSystemPrompt(
      payload.agentId,
      payload.role as TeamRole,
      title,
      teamMembers
    );
  }, [teamMembers, payload.teamId, payload.agentId, payload.role, title]);

  // Claude: --append-system-prompt でシステム指示を渡す
  // Codex: codexInstructions (一時ファイル化されて model_instructions_file へ)
  const isCodex = payload.agent === 'codex';
  const args = useMemo<string[] | undefined>(() => {
    const base = parseShellArgs(
      isCodex ? settings.codexArgs || '' : settings.claudeArgs || ''
    );
    if (!isCodex && sysPrompt) {
      base.push('--append-system-prompt', sysPrompt);
    }
    if (isCodex && payload.teamId) {
      const userCodex = settings.codexArgs || '';
      if (!userCodex.includes('disable_paste_burst')) {
        base.push('-c', 'disable_paste_burst=true');
      }
    }
    return base.length > 0 ? base : undefined;
  }, [isCodex, sysPrompt, payload.teamId, settings.claudeArgs, settings.codexArgs]);

  const codexInstructions = isCodex ? sysPrompt : undefined;

  return (
    <>
      <NodeResizer
        minWidth={280}
        minHeight={180}
        color={accent}
        handleStyle={{ width: 8, height: 8, borderRadius: 2 }}
        lineStyle={{ borderWidth: 1 }}
      />
      <Handle
        type="target"
        position={Position.Left}
        style={{ background: accent, width: 10, height: 10 }}
      />
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--bg-elevated, #16161c)',
          border: `1px solid ${accent}`,
          borderRadius: 8,
          overflow: 'hidden',
          boxShadow: `0 8px 24px ${accent}33, 0 4px 12px rgba(0,0,0,0.4)`
        }}
      >
        <header
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '6px 10px',
            background: `linear-gradient(90deg, ${accent}22 0%, transparent 70%)`,
            borderBottom: `1px solid ${accent}55`,
            fontSize: 12,
            color: 'var(--fg, #e6e6e6)',
            userSelect: 'none',
            cursor: 'grab'
          }}
        >
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span
              aria-hidden="true"
              style={{
                width: 22,
                height: 22,
                borderRadius: '50%',
                background: accent,
                color: '#0a0a0d',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 12,
                fontWeight: 700
              }}
            >
              {meta?.glyph ?? 'A'}
            </span>
            <span style={{ fontWeight: 600 }}>{title}</span>
            {meta && (
              <span style={{ fontSize: 10, color: `${accent}cc`, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                {meta.label}
              </span>
            )}
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <StatusBadge state={activity} accent={accent} />
            {status && (
              <span
                title={status}
                style={{
                  fontSize: 10,
                  color: 'var(--fg-muted, #8a8aa3)',
                  maxWidth: 140,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis'
                }}
              >
                {shortStatus(status)}
              </span>
            )}
            <button
              type="button"
              className="nodrag"
              onClick={() => removeCard(id)}
              style={{
                background: 'transparent',
                border: 0,
                color: 'var(--fg-muted, #a8a8b8)',
                cursor: 'pointer',
                padding: '2px 6px',
                fontSize: 14,
                lineHeight: 1
              }}
              title="Close"
            >
              ×
            </button>
          </span>
        </header>
        <div
          className="nodrag nowheel"
          style={{
            flex: 1,
            minHeight: 0,
            minWidth: 0,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            position: 'relative'
          }}
        >
          <TerminalView
            ref={ref}
            cwd={cwd}
            fallbackCwd={cwd}
            command={command}
            args={payload.args ?? args}
            codexInstructions={codexInstructions}
            visible={true}
            teamId={payload.teamId}
            agentId={payload.agentId}
            role={payload.role}
            onStatus={setStatus}
            onActivity={handleActivity}
            onUserInput={handleUserInput}
          />
        </div>
      </div>
      <Handle
        type="source"
        position={Position.Right}
        style={{ background: accent, width: 10, height: 10 }}
      />
    </>
  );
}

/** ヘッダー右の小さなステータスドット (idle=灰, thinking=黄, typing=accent パルス) */
function StatusBadge({
  state,
  accent
}: {
  state: AgentStatus;
  accent: string;
}): JSX.Element {
  const color = state === 'typing' ? accent : state === 'thinking' ? '#f5b048' : '#5a5a6a';
  return (
    <span
      title={state}
      aria-label={`agent ${state}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        fontSize: 9,
        color: 'var(--fg-muted, #8a8aa3)',
        textTransform: 'uppercase',
        letterSpacing: 0.5
      }}
    >
      <span
        style={{
          width: 7,
          height: 7,
          borderRadius: '50%',
          background: color,
          boxShadow: state === 'typing' ? `0 0 8px ${accent}` : 'none',
          animation: state === 'typing' ? 'agent-pulse 0.8s ease-in-out infinite' : undefined
        }}
      />
      <span>{state}</span>
      <style>{`@keyframes agent-pulse { 0%,100% { opacity: 1 } 50% { opacity: 0.4 } }`}</style>
    </span>
  );
}

export default memo(AgentNodeCardImpl);
