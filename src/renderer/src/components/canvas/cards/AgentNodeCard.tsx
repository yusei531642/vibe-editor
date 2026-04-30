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
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Handle, NodeResizer, Position, type NodeProps } from '@xyflow/react';
import { TerminalView, type TerminalViewHandle } from '../../TerminalView';
import { useT } from '../../../lib/i18n';
import { useSettings } from '../../../lib/settings-context';
import { useCanvasStore, NODE_MIN_W, NODE_MIN_H } from '../../../stores/canvas';
import { useCanvasTerminalFit } from '../../../lib/use-canvas-terminal-fit';
import { useConfirmRemoveCard } from '../../../lib/use-confirm-remove-card';
import { useXtermScrollToBottomOnResize } from '../../../lib/use-xterm-scroll-on-resize';
import { fallbackProfile, profileText, renderSystemPrompt, useRoleProfiles } from '../../../lib/role-profiles-context';
import { parseShellArgs } from '../../../lib/parse-args';
import { resolveAgentConfig } from '../../../lib/agent-resolver';

interface AgentPayload {
  agent?: 'claude' | 'codex';
  /** 新スキーマ: ロール識別子。未設定時は legacy `role` をフォールバックとして読む。 */
  roleProfileId?: string;
  /** @deprecated 旧フィールド。canvas store v2 マイグレーションで roleProfileId に移行済み */
  role?: string;
  teamId?: string;
  agentId?: string;
  command?: string;
  args?: string[];
  cwd?: string;
  /** Claude Code のセッション id。検出時に payload に書き戻し、次回 spawn で
   *  `--resume <id>` を付与して前回会話を復元する。 */
  resumeSessionId?: string | null;
  /**
   * Issue #117: team_recruit の custom_instructions が新規エージェントに渡るように、
   * use-recruit-listener.ts が payload に積んでくる「役職追加指示の生テキスト」。
   *   - Claude  : sysPrompt の末尾に追記して --append-system-prompt に流す。
   *   - Codex   : codex_instructions として一時ファイル化し、起動時に PTY 注入される。
   *   - 動的ロール (instructions ベース) と併用された場合は両方をブレンドする。
   * undefined / 空文字なら「指定なし」と同じ扱い。
   */
  customInstructions?: string;
  /** @deprecated `customInstructions` の旧名。互換のため受理だけする (後方互換)。 */
  codexInstructions?: string;
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
  // Issue #261: NodeResizer でカードを縮めたあと再度広げたとき、内部 `.xterm-viewport`
  // の scrollTop が中途半端な位置で残って「末尾が見えない」状態になることがある。
  // `.canvas-agent-card__term` 自体のサイズ変化を ResizeObserver で監視し、
  // 子の `.xterm-viewport` を末尾までスクロールし直す。`.xterm-viewport` 自体は
  // xterm.js が動的に生成するので querySelector で都度引く (mount/remount に追従)。
  const termContainerRef = useRef<HTMLDivElement | null>(null);
  const { settings } = useSettings();
  const t = useT();
  const confirmRemoveCard = useConfirmRemoveCard();
  const setCardTitle = useCanvasStore((s) => s.setCardTitle);
  const setCardPayload = useCanvasStore((s) => s.setCardPayload);
  // Issue #253: Canvas zoom 下でも論理 px ベースで cols/rows を確定させる
  const fit = useCanvasTerminalFit(settings);
  const payload = (data?.payload ?? {}) as AgentPayload;
  // 新スキーマ roleProfileId を優先、無ければ legacy role を読む
  const roleProfileId = payload.roleProfileId ?? payload.role ?? 'leader';
  const profilesById = useRoleProfiles().byId;
  const globalPreamble = useRoleProfiles().file.globalPreamble;
  const profile = profilesById[roleProfileId] ?? fallbackProfile(roleProfileId);
  const accent = profile.visual.color;
  const meta = profileText(profile, settings.language);
  const title = (data?.title as string) ?? meta.label;
  const [status, setStatus] = useState<string>('');
  // Phase 4: ステータスバッジ。出力を最近受け取ったら typing、暫く来なければ idle。
  const [activity, setActivity] = useState<AgentStatus>('idle');
  // Issue #125: 旧実装は 200ms 周期の setInterval を全 AgentNodeCard が常時動かしており
  // 30 カード並ぶと idle 中も毎秒 150 回 timer が起きていた (省電力モード/裏画面でも)。
  // → 出力イベント (handleActivity) の都度 setTimeout を立て直し、idle 復帰でクリアする。
  //   typing 状態の間しかタイマーが動かないので idle 時はゼロコスト。
  const idleTimerRef = useRef<number | null>(null);
  const handleActivity = (): void => {
    setActivity('typing');
    if (idleTimerRef.current !== null) {
      window.clearTimeout(idleTimerRef.current);
    }
    idleTimerRef.current = window.setTimeout(() => {
      idleTimerRef.current = null;
      setActivity((prev) => (prev !== 'idle' ? 'idle' : prev));
    }, 600);
  };
  useEffect(() => {
    return () => {
      if (idleTimerRef.current !== null) {
        window.clearTimeout(idleTimerRef.current);
        idleTimerRef.current = null;
      }
    };
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

  // Issue #23 + カスタムエージェント対応:
  // agent-resolver 経由で built-in (claude/codex) + customAgents のコマンド/引数/cwd を解決する。
  // lastOpenedRoot を最優先とし、エージェント固有 cwd があればそれを fallback として使う。
  // payload.command / payload.cwd が先に指定されていればそちらを優先 (legacy 互換)。
  const resolved = resolveAgentConfig(payload.agent ?? 'claude', settings);
  const cwd = settings.lastOpenedRoot || resolved.cwd || payload.cwd || '';
  const command = payload.command ?? resolved.command;

  // ----- チームのシステムプロンプトを構築 -----
  // 同 teamId の AgentNode カード群から roster を作成。
  //
  // パフォーマンス: 旧実装は `useCanvasStore((s) => s.nodes)` で全 nodes を購読していたため、
  // ノードを 1 ピクセル動かすだけで全 AgentNodeCard が再レンダーし Canvas が重かった。
  // 対策として primitive な signature 文字列 (agentId|role|agent を ; で連結) を購読し、
  // 文字列 equality で React がデフォルトで bailout できるようにする。drag/resize では
  // signature が変わらないので再レンダーが発生しない。
  const teamMembersSig = useCanvasStore((s) => {
    if (!payload.teamId) return '';
    const sigs: string[] = [];
    for (const n of s.nodes) {
      if (n.type !== 'agent') continue;
      const p = n.data?.payload as AgentPayload | undefined;
      const rp = p?.roleProfileId ?? p?.role;
      if (!p || p.teamId !== payload.teamId || !p.agentId || !rp) continue;
      sigs.push(`${p.agentId}:${rp}:${p.agent ?? 'claude'}`);
    }
    return sigs.join(';');
  });
  const teamMembers = useMemo(() => {
    if (!payload.teamId) return null;
    if (teamMembersSig === '') return [] as { agentId: string; roleProfileId: string; agent: 'claude' | 'codex' }[];
    return teamMembersSig.split(';').map((s) => {
      const [agentId, roleProfileId, agent] = s.split(':');
      return {
        agentId,
        roleProfileId,
        agent: agent as 'claude' | 'codex'
      };
    });
  }, [teamMembersSig, payload.teamId]);

  // Issue #117: team_recruit の custom_instructions を payload から拾う。
  // 新フィールド `customInstructions` を優先し、旧 `codexInstructions` も後方互換で受理する。
  const customInstructionsRaw =
    (payload.customInstructions ?? payload.codexInstructions ?? '').trim();

  const sysPrompt = useMemo(() => {
    // 旧仕様 (teamMembers >= 2 必須) を撤廃: Leader 単独でも recruit 用にプロンプトを与える
    if (!payload.teamId || !payload.agentId || !teamMembers) return undefined;
    const base = renderSystemPrompt({
      profile,
      profilesById,
      teamName: title,
      selfAgentId: payload.agentId,
      members: teamMembers,
      globalPreamble,
      language: settings.language
    });
    // Issue #117: ロールプロファイル由来のプロンプトに、Leader が team_recruit で渡した
    // custom_instructions を末尾追記する。動的ロール instructions は既に worker テンプレに
    // 流し込まれているので、これは「採用時のその場限りの追加メモ」相当 (タスク背景, 引き継ぎなど)。
    if (customInstructionsRaw) {
      const lang = settings.language;
      const header =
        lang === 'ja'
          ? '\n\n--- Leader からの追加指示 (team_recruit.custom_instructions) ---\n'
          : '\n\n--- Additional instructions from the Leader (team_recruit.custom_instructions) ---\n';
      return base + header + customInstructionsRaw;
    }
    return base;
  }, [
    profile,
    profilesById,
    payload.teamId,
    payload.agentId,
    teamMembers,
    title,
    globalPreamble,
    settings.language,
    customInstructionsRaw
  ]);

  // Claude: --append-system-prompt でシステム指示を渡す
  // Codex: codexInstructions (一時ファイル化されて model_instructions_file へ)
  // Custom: resolved.args をそのまま使い、system prompt 連携は行わない (カスタム CLI は
  //          プロンプト注入方法が不明のため、チーム役割分担の注入はスキップ)
  const isClaude = payload.agent === 'claude' || !payload.agent;
  const isCodex = payload.agent === 'codex';
  const args = useMemo<string[] | undefined>(() => {
    const rawArgs = isClaude
      ? settings.claudeArgs || ''
      : isCodex
        ? settings.codexArgs || ''
        : resolved.args;
    const base = parseShellArgs(rawArgs);
    if (isClaude && sysPrompt) {
      base.push('--append-system-prompt', sysPrompt);
    }
    if (isCodex && payload.teamId) {
      const userCodex = settings.codexArgs || '';
      if (!userCodex.includes('disable_paste_burst')) {
        base.push('-c', 'disable_paste_burst=true');
      }
    }
    // Claude のみ `--resume <id>` で前回会話を復元 (Codex は --resume 非対応)。
    // payload.resumeSessionId は onSessionId で書き戻されるため、
    // アプリ再起動時もそのまま `--resume` 付き spawn になる。
    if (isClaude && payload.resumeSessionId) {
      base.push('--resume', payload.resumeSessionId);
    }
    return base.length > 0 ? base : undefined;
  }, [
    isClaude,
    isCodex,
    resolved.args,
    sysPrompt,
    payload.teamId,
    payload.resumeSessionId,
    settings.claudeArgs,
    settings.codexArgs
  ]);

  const codexInstructions = isCodex ? sysPrompt : undefined;

  // accent は CSS 変数 --agent-accent として子孫で参照する
  const cardStyle = useMemo(
    () => ({ ['--agent-accent' as string]: accent } as React.CSSProperties),
    [accent]
  );

  // Issue #261 / #272 / #272 v3: termContainer のサイズ変化時に xterm 自前の
  // scroll model 経由で末尾までスクロールし直す。NodeResizer の縮小→拡大で
  // scrollback 末尾が見切れるのを防ぐ。callback は xterm v6 の SmoothScrollableElement
  // に正しく届くよう `Terminal.scrollToBottom()` を public API 経由で叩く
  // (DOM の scrollTop 書換えは内部 scroll model と同期しないため使えない)。
  const scrollToBottom = useCallback(() => {
    ref.current?.scrollToBottom();
  }, []);
  useXtermScrollToBottomOnResize(termContainerRef, scrollToBottom);

  return (
    <>
      <NodeResizer
        minWidth={NODE_MIN_W}
        minHeight={NODE_MIN_H}
        color={accent}
        handleStyle={{ width: 8, height: 8, borderRadius: 2 }}
        lineStyle={{ borderWidth: 1 }}
      />
      <Handle
        type="target"
        position={Position.Left}
        style={{ background: accent, width: 10, height: 10 }}
      />
      <div className="canvas-agent-card" style={cardStyle}>
        <header className="canvas-agent-card__header">
          <span className="canvas-agent-card__title-row">
            <span aria-hidden="true" className="canvas-agent-card__avatar">
              {profile.visual.glyph}
            </span>
            <span className="canvas-agent-card__title">{title}</span>
            <span className="canvas-agent-card__role">{meta.label}</span>
          </span>
          <span className="canvas-agent-card__actions">
            <StatusBadge state={activity} label={t(`agentStatus.${activity}`)} />
            {status && (
              <span className="canvas-agent-card__status" title={status}>
                {shortStatus(status)}
              </span>
            )}
            <button
              type="button"
              className="nodrag canvas-agent-card__close"
              onClick={() => confirmRemoveCard(id)}
              title={t('agentCard.close')}
              aria-label={t('agentCard.close')}
            >
              ×
            </button>
          </span>
        </header>
        <div
          className="nodrag nowheel canvas-agent-card__term"
          ref={termContainerRef}
        >
          <TerminalView
            ref={ref}
            // Issue #271: HMR remount で同じ PTY へ再 bind するための論理キー。
            // ノード id は @xyflow/react canvas store で永続化されているので、
            // HMR を跨いでも同一カードを一意に識別できる。
            sessionKey={`canvas-agent:${id}`}
            cwd={cwd}
            fallbackCwd={cwd}
            command={command}
            // Issue #341: payload.args が空配列で永続化された場合に settings 由来の args が
            // 潰れないようガード (`?? args` だと `[]` でも truthy 扱いで args が無視される)。
            args={payload.args && payload.args.length > 0 ? payload.args : args}
            codexInstructions={codexInstructions}
            visible={true}
            teamId={payload.teamId}
            agentId={payload.agentId}
            role={roleProfileId}
            onStatus={setStatus}
            onActivity={handleActivity}
            onUserInput={handleUserInput}
            onSessionId={(sid) => {
              if (sid) setCardPayload(id, { resumeSessionId: sid });
            }}
            // Canvas zoom で xterm canvas が滲むのを避けるため WebGL を切る (DOM renderer 固定)。
            // text は実 DOM になるので Chromium が親 transform に応じて再ラスタライズしシャープに描く。
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
  label
}: {
  state: AgentStatus;
  label: string;
}): JSX.Element {
  return (
    <span
      title={label}
      aria-label={label}
      className={`canvas-agent-status canvas-agent-status--${state}`}
    >
      <span className="canvas-agent-status__dot" />
      <span>{label}</span>
    </span>
  );
}

export default memo(AgentNodeCardImpl);
