/**
 * AgentNodeCard / CardFrame
 *
 * Issue #487: AgentNodeCard 単一ファイルから「カード枠 + role visual + handoff UI」
 * を切り出したもの。pty / xterm の配線は隣接の TerminalOverlay.tsx に分けてある。
 *
 * 責務:
 *   - NodeResizer + 入出力 Handle (xyflow)
 *   - ロール由来の accent / avatar / 表示ラベル (resolveAgentVisual)
 *   - ヘッダー (title / organization / role / StatusBadge / handoff button / close)
 *   - Leader 専用の handoff 作成 → bracketed paste 注入フロー
 *   - 起動引数 (command / args / sysPrompt / codexInstructions) の解決
 *   - TerminalOverlay の mount & 共有 ref / callback の橋渡し
 *
 * 挙動は元 AgentNodeCard.tsx と完全一致。構造のみ整理。
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Handle, NodeResizer, Position, type NodeProps } from '@xyflow/react';
import {
  AlertTriangle,
  ClipboardCheck,
  ClipboardList,
  Clock,
  Heart,
  HeartPulse,
  Inbox,
  RotateCcw,
  Skull
} from 'lucide-react';
import { useT } from '../../../../lib/i18n';
import { useTeamHealth } from '../../../../lib/use-team-health';
import { deriveHealth, type HealthState } from '../../../../lib/agent-health';
import { useTeamInjectFailed } from '../../../../lib/use-team-inject-failed';
import { useTeamInboxRead } from '../../../../lib/use-team-inbox-read';
import { useTeamHandoff } from '../../../../lib/use-team-handoff';
import { applyHandoffArrival, applyInboxRead } from './unread-inbox-count';
import { useSettings } from '../../../../lib/settings-context';
import {
  useCanvasStore,
  NODE_MIN_W,
  NODE_MIN_H
} from '../../../../stores/canvas';
import { useAgentActivityStore } from '../../../../stores/agent-activity';
import { useConfirmRemoveCard } from '../../../../lib/use-confirm-remove-card';
import {
  renderSystemPrompt,
  useRoleProfiles
} from '../../../../lib/role-profiles-context';
import { resolveAgentVisual } from '../../../../lib/agent-visual';
import { parseShellArgs } from '../../../../lib/parse-args';
import { resolveAgentConfig } from '../../../../lib/agent-resolver';
import { useToast } from '../../../../lib/toast-context';
import {
  deriveCardSummary,
  type CardSummary
} from '../../../../lib/agent-summary';
import type { TerminalViewHandle } from '../../../TerminalView';
import type {
  HandoffCheckpoint,
  HandoffReference
} from '../../../../../../types/shared';
import type { AgentPayload, AgentStatus } from './types';
import { TerminalOverlay } from './TerminalOverlay';

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
 * 絶対パスからファイル名だけを返す。Windows (`\`) と POSIX (`/`) の両方に対応するため
 * path モジュールを使わず手元で処理する (renderer 側に node:path は無い)。
 */
function basenameOf(absPath: string): string {
  const normalized = absPath.replace(/\\/g, '/');
  const idx = normalized.lastIndexOf('/');
  return idx >= 0 ? normalized.slice(idx + 1) : normalized;
}

function handoffReferenceOf(
  handoff: HandoffCheckpoint | HandoffReference
): HandoffReference {
  return {
    id: handoff.id,
    kind: handoff.kind,
    status: handoff.status,
    createdAt: handoff.createdAt,
    updatedAt: handoff.updatedAt,
    jsonPath: handoff.jsonPath,
    markdownPath: handoff.markdownPath,
    fromAgentId: handoff.fromAgentId,
    toAgentId: handoff.toAgentId,
    replacementForAgentId: handoff.replacementForAgentId
  };
}

/**
 * Issue #423: Leader 自身に「引き継ぎ手順」を伝える PTY 注入用プロンプトを組み立てる。
 * UI 側で handoff document を保存した直後、保存先パスをこのプロンプトに埋めて Leader の
 * PTY に bracketed paste で注入する。Leader は MCP `team_create_leader` → `team_switch_leader`
 * を呼び、自律的に新 Leader へ交代する。
 */
function buildLeaderHandoffPrompt(markdownPath: string, handoffId: string): string {
  return [
    '【引き継ぎ手順】',
    '',
    `引き継ぎ書を保存しました: ${markdownPath}`,
    `Handoff id: ${handoffId}`,
    '',
    '次の手順で引き継ぎを完了してください:',
    '1. 上記 handoff markdown を Read tool で読み、現在の作業状況・未完了タスク・次アクションを確認する。',
    '2. 必要なら handoff の Notes / Next Actions を補強する追加メモを書き足す。',
    '3. MCP tool `team_create_leader` を呼び、新しい Leader を採用する:',
    `     team_create_leader({ handoff_id: "${handoffId}" })`,
    '   返り値の `agentId` を控えること。',
    '4. 新 Leader が起動したら、`team_send` で agentId 宛にこの handoff のパスと「お前が新 Leader だ」という旨を伝える:',
    `     team_send({ to: "<上で得た agentId>", handoff_id: "${handoffId}", message: "あなたが新 Leader です。handoff を読んで team_ack_handoff({ handoff_id: '${handoffId}' }) を呼び、ACK を返してください: ${markdownPath}" })`,
    '5. 新 Leader が `team_ack_handoff` と ACK を返したら、MCP tool `team_switch_leader` を呼ぶ:',
    `     team_switch_leader({ new_leader_agent_id: "<上で得た agentId>", handoff_id: "${handoffId}" })`,
    '   呼び出し成功後、約 2 秒で自分のカードが自動的に閉じられる。',
    '',
    '上記を順に実行してください。'
  ].join('\n');
}

/** 文字列を bracketed paste マーカーで包む。Claude/Codex TUI に「1 件のペースト」として渡る。 */
function wrapBracketedPaste(text: string): string {
  return `\x1b[200~${text}\x1b[201~`;
}

/**
 * Issue #521: deriveCardSummary が返す `{ unit, value }` を i18n キーに変換する。
 * unit が 'now' の時は値を埋め込まないキー、それ以外は `{value}` パラメータを渡す。
 * lastOutputAgo が null (= 起動直後で未観測) のときは「観測なし」のキーへフォールバック。
 */
function formatAgoLabel(
  ago: { unit: 'now' | 'sec' | 'min' | 'hour' | 'day'; value: number } | null,
  t: (key: string, params?: Record<string, string | number>) => string
): string {
  if (ago === null) return t('agentCard.summary.ago.unobserved');
  if (ago.unit === 'now') return t('agentCard.summary.ago.now');
  return t(`agentCard.summary.ago.${ago.unit}`, { value: ago.value });
}

/**
 * Issue #510: 「●alive | ◐stale | ○dead」 + 経過秒/分 + 自己申告ステータスを 1 行に整形する。
 * - alive: status があれば status を出す。なければ 'alive' のみ。
 * - stale / dead: 経過時間を強調 ('沈黙 N 分')。
 */
function formatHealthLabel(
  state: HealthState,
  ageMs: number | null,
  currentStatus: string | null,
  t: (key: string, params?: Record<string, string | number>) => string
): string {
  const stateLabel = t(`agentCard.summary.health.state.${state}`);
  if (state === 'alive') {
    if (currentStatus && currentStatus.trim().length > 0) {
      const status = currentStatus.length > 32 ? currentStatus.slice(0, 31) + '…' : currentStatus;
      return `${stateLabel} · ${status}`;
    }
    return stateLabel;
  }
  if (ageMs === null) return stateLabel;
  // 沈黙時間: 1 分未満は秒、それ以上は分単位 (停滞は「N 分」が直感的)。
  const sec = Math.floor(ageMs / 1000);
  if (sec < 60) {
    return t('agentCard.summary.health.silent.sec', {
      state: stateLabel,
      value: sec
    });
  }
  const min = Math.floor(sec / 60);
  return t('agentCard.summary.health.silent.min', {
    state: stateLabel,
    value: min
  });
}

function AgentNodeCardImpl({ id, data }: NodeProps): JSX.Element {
  const termRef = useRef<TerminalViewHandle | null>(null);
  const { settings } = useSettings();
  const t = useT();
  const confirmRemoveCard = useConfirmRemoveCard();
  const setCardPayload = useCanvasStore((s) => s.setCardPayload);
  const { showToast } = useToast();
  const payload = (data?.payload ?? {}) as AgentPayload;
  // 新スキーマ roleProfileId を優先、無ければ legacy role を読む
  const roleProfiles = useRoleProfiles();
  const profilesById = roleProfiles.byId;
  const globalPreamble = roleProfiles.file.globalPreamble;
  const visual = resolveAgentVisual(payload, profilesById, settings.language);
  const roleProfileId = visual.roleProfileId;
  const profile = visual.profile;
  const accent = visual.agentAccent;
  const organizationAccent = visual.organizationAccent;
  const title = (data?.title as string) ?? visual.label;
  const [handoffBusy, setHandoffBusy] = useState(false);
  const [status, setStatus] = useState<string>('');
  const [activity, setActivityState] = useState<AgentStatus>('idle');

  // Issue #521: agent-activity store に書き出して StageHud 側からも観測できるようにする。
  // CardFrame が unmount されても store にレコードを残さないよう effect で掃除する。
  const publishActivity = useAgentActivityStore((s) => s.setActivity);
  const clearActivity = useAgentActivityStore((s) => s.clearCard);
  // setActivity wrapper: useState 更新 + store 通知を 1 関数にまとめる。
  // TerminalOverlay は React.Dispatch<SetStateAction<AgentStatus>> を期待するので、
  // 関数形 updater を素通しできる shape を保つ。
  const setActivity: React.Dispatch<React.SetStateAction<AgentStatus>> = useCallback(
    (next) => {
      setActivityState((prev) => {
        const resolved =
          typeof next === 'function'
            ? (next as (p: AgentStatus) => AgentStatus)(prev)
            : next;
        publishActivity(id, resolved, Date.now());
        return resolved;
      });
    },
    [id, publishActivity]
  );
  useEffect(() => {
    return () => clearActivity(id);
  }, [id, clearActivity]);

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
    if (teamMembersSig === '')
      return [] as { agentId: string; roleProfileId: string; agent: 'claude' | 'codex' }[];
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

  // Issue #375 / #423: createHandoff は副作用 (handoff の保存 + payload.latestHandoff 更新) のみ
  // 行い、success toast は呼び出し側 (handleCreateHandoffClick) に任せる。
  // 呼び出し側で「保存先のパス」を PTY 注入用に取り出すため、戻り値の HandoffCheckpoint は必須。
  const createHandoff = useCallback(async (): Promise<HandoffCheckpoint | null> => {
    const projectRoot = cwd || payload.cwd || '';
    if (!projectRoot) {
      showToast(t('handoff.error.noProject'), { tone: 'error', duration: 8000 });
      return null;
    }
    const snapshot = termRef.current?.getBufferText(120) ?? '';
    const kind = roleProfileId === 'leader' ? 'leader' : 'worker';
    const result = await window.api.handoffs.create({
      projectRoot,
      teamId: payload.teamId ?? null,
      kind,
      fromAgentId: payload.agentId ?? null,
      fromRole: roleProfileId,
      fromAgent: payload.agent ?? 'claude',
      fromTitle: title,
      sourceSessionId: payload.resumeSessionId ?? null,
      replacementForAgentId: payload.agentId ?? null,
      retireAfterAck: true,
      trigger: 'manual',
      content: {
        summary: `${title} (${visual.label}) の Canvas handoff。保存時点の terminal snapshot と次アクションを含みます。`,
        decisions: ['この handoff は既存セッションを --resume せず、新しいセッションへ注入するための継続メモとして保存されました。'],
        filesTouched: [],
        openTasks: ['handoff markdown を読み、現在の作業目的・未完了タスク・次アクションを確認する。'],
        risks: ['terminal snapshot は直近の表示内容ベースのため、完全な会話履歴ではありません。必要なら旧 agent / team history を確認してください。'],
        nextActions: ['handoff を読んだら ack を返し、Next Actions に沿って作業を継続する。'],
        verification: ['handoff 作成時点では自動検証は未実行です。'],
        notes: [`Canvas card: ${id}`, payload.teamId ? `Team: ${payload.teamId}` : 'Standalone agent'],
        terminalSnapshot: snapshot.slice(-16_000) || null
      }
    });
    if (!result.ok || !result.handoff) {
      throw new Error(result.error ?? 'handoff create failed');
    }
    setCardPayload(id, { latestHandoff: handoffReferenceOf(result.handoff) });
    return result.handoff;
  }, [
    cwd,
    id,
    visual.label,
    payload.agent,
    payload.agentId,
    payload.cwd,
    payload.resumeSessionId,
    payload.teamId,
    roleProfileId,
    setCardPayload,
    showToast,
    t,
    title
  ]);

  // Issue #423: 旧 `startFreshFromHandoff` (UI が直接新カードを生やす) は廃止し、
  // 「Leader 自身が MCP 経由で交代する」フローへ移行。ボタンは下記 1 本に統合。

  // Issue #423: ボタン押下時のフロー
  //   1. Rust 側 `handoffs.create` で handoff JSON / Markdown を確実に保存
  //   2. 保存先パス + MCP 手順を Leader 自身の PTY に bracketed paste で注入
  //   3. Leader (Claude/Codex) が `team_create_leader` → `team_send` → `team_switch_leader`
  //      を順に叩き、自律的に新 Leader へ交代する
  // Leader 以外のカードでは押せない (worker の引き継ぎは将来の別 issue で対応)。
  const handleCreateHandoffClick = useCallback(() => {
    if (handoffBusy) return;
    if (roleProfileId !== 'leader') {
      showToast(t('handoff.error.notLeader'), { tone: 'error', duration: 6000 });
      return;
    }
    setHandoffBusy(true);
    void createHandoff()
      .then((handoff) => {
        if (!handoff) return; // noProject 等は createHandoff 側で error toast を出している
        const fileName = basenameOf(handoff.markdownPath);
        const markdownPath = handoff.markdownPath;
        // Leader の PTY に「引き継ぎ手順」プロンプトを bracketed paste で注入。
        // sendCommand(text, submit=true) は末尾に \r を付けて送信するため、
        // 全文が 1 つの paste として確定 → Claude/Codex が読み取って MCP を叩き始める。
        try {
          const prompt = buildLeaderHandoffPrompt(markdownPath, handoff.id);
          termRef.current?.sendCommand(wrapBracketedPaste(prompt), true);
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          showToast(t('handoff.error.injectFailed', { detail }), {
            tone: 'error',
            duration: 8000
          });
          return;
        }
        showToast(t('handoff.created', { file: fileName }), {
          tone: 'success',
          duration: 8000,
          action: {
            label: t('handoff.action.reveal'),
            onClick: () => {
              void window.api.app.revealInFileManager(markdownPath).catch((err) => {
                console.warn('[handoff] reveal failed:', err);
              });
            }
          }
        });
      })
      .catch((err) => {
        console.warn('[handoff] create failed:', err);
        const detail = err instanceof Error ? err.message : String(err);
        showToast(t('handoff.error.createFailed', { detail }), {
          tone: 'error',
          duration: 8000
        });
      })
      .finally(() => setHandoffBusy(false));
  }, [createHandoff, handoffBusy, roleProfileId, showToast, t]);

  // Issue #423: 旧 `startFreshFromHandoff` 経路で使っていた `handoff_ack:` 監視は撤去。
  // 新フローでは `team_switch_leader` MCP tool が active leader 切替 + 旧カード retire を
  // 行うため、renderer 側で ack を listen する必要は無い。

  // ---------- Issue #511: inject 失敗の警告表示 + 手動リトライ ----------
  //
  // `team_send` (またはリトライ後の `team_send_retry_inject`) が PTY inject に失敗した
  // 瞬間、Hub から `team:inject_failed` event が emit される。Canvas 側はそれを受けて
  // 該当 agent の payload.lastInjectFailure に reason を書き込む → CardFrame が warning
  // row を render する。retry button で `window.api.team.retryInject` を呼び、成功すれば
  // payload.lastInjectFailure を undefined クリアして warning を消す。
  const [retryBusy, setRetryBusy] = useState(false);
  useTeamInjectFailed(
    useCallback(
      (evt) => {
        if (!payload.agentId || evt.toAgentId !== payload.agentId) return;
        setCardPayload(id, {
          lastInjectFailure: {
            messageId: evt.messageId,
            reason: { code: evt.reasonCode, message: evt.reasonMessage },
            failedAt: evt.failedAt,
            fromRole: evt.fromRole
          }
        });
      },
      [id, payload.agentId, setCardPayload]
    )
  );
  const handleRetryInject = useCallback(() => {
    if (retryBusy) return;
    const failure = payload.lastInjectFailure;
    if (!failure || !payload.teamId || !payload.agentId) return;
    setRetryBusy(true);
    void window.api.team
      .retryInject({
        teamId: payload.teamId,
        messageId: failure.messageId,
        agentId: payload.agentId
      })
      .then((result) => {
        if (result.ok) {
          // 成功時は warning row を消す。Hub からは team:handoff event が来るので
          // 配信成功は Canvas 側 ActivityFeed / HandoffEdge が拾う。
          setCardPayload(id, { lastInjectFailure: undefined });
          showToast(t('injectFailure.retrySuccess'), {
            tone: 'success',
            duration: 5000
          });
        } else {
          // 再失敗。Hub が `team:inject_failed` を再 emit するので useTeamInjectFailed が
          // 新しい reason を payload に書き込む (= warning row はそのまま、内容だけ更新)。
          const reason = result.reasonCode ?? result.error ?? 'unknown';
          showToast(t('injectFailure.retryFailed', { reason }), {
            tone: 'error',
            duration: 8000
          });
        }
      })
      .catch((err) => {
        // unknown_team / unknown_message / invalid_recipient の構造化エラーはここに来る。
        const detail = err instanceof Error ? err.message : String(err);
        showToast(t('injectFailure.retryError', { detail }), {
          tone: 'error',
          duration: 8000
        });
      })
      .finally(() => setRetryBusy(false));
  }, [
    retryBusy,
    payload.lastInjectFailure,
    payload.teamId,
    payload.agentId,
    id,
    setCardPayload,
    showToast,
    t
  ]);
  const handleDismissInjectWarning = useCallback(() => {
    setCardPayload(id, { lastInjectFailure: undefined });
  }, [id, setCardPayload]);

  // ---------- Issue #509: 未読 inbox 数の event-driven 集計 ----------
  //
  // `team:handoff` (= delivered = inject 成功) を受けると、自分宛のメッセージは「配信済み
  // 未読」状態になる → unreadInboxCount +1。`team:inbox_read` を受けると、recipient が
  // `team_read` を呼んだことが確定するので、自分宛の発火なら count を減らす。
  // 一番古い未読が 60s 以上残っている場合は警告色に切り替えて Leader に督促を促す
  // (`team_diagnostics.stalledInbound: true` と意味的に揃えてある)。
  // Issue #596: closure-captured payload を読んでから書く形では 1 frame 内 2 件以上の
  //  handoff/inbox_read が来ると undercount する race があった。
  //  applyHandoffArrival / applyInboxRead は zustand store から最新値を直読みする
  //  helper。React tree から切り離して unit test 可能。詳細は
  //  `./unread-inbox-count.ts` の docstring 参照。
  useTeamHandoff(
    useCallback(
      (evt) => {
        applyHandoffArrival(useCanvasStore, id, evt, payload.agentId);
      },
      [id, payload.agentId]
    )
  );
  useTeamInboxRead(
    useCallback(
      (evt) => {
        applyInboxRead(useCanvasStore, id, evt, payload.agentId);
      },
      [id, payload.agentId]
    )
  );

  // accent は CSS 変数 --agent-accent として子孫で参照する
  const cardStyle = useMemo(
    () =>
      ({
        ['--agent-accent' as string]: accent,
        ['--organization-accent' as string]: organizationAccent ?? accent
      }) as React.CSSProperties,
    [accent, organizationAccent]
  );

  // Issue #521: 3 行サマリ算出 + Canvas 全体集計用に store へ書き戻す。
  // 経過時間表示を生かすために 15 秒間隔で now を更新する (long-poll は不要)。
  const lastActivityAt = useAgentActivityStore(
    (s) => s.byCard[id]?.lastActivityAt ?? null
  );
  const publishSummary = useAgentActivityStore((s) => s.setSummary);
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNowTick(Date.now()), 15_000);
    return () => window.clearInterval(t);
  }, []);
  const summary = useMemo<CardSummary>(
    () =>
      deriveCardSummary({
        payload,
        roleProfileId,
        title,
        activity,
        lastActivityAt,
        now: nowTick
      }),
    [payload, roleProfileId, title, activity, lastActivityAt, nowTick]
  );
  useEffect(() => {
    publishSummary(id, summary);
  }, [id, summary, publishSummary]);
  const summaryAgoLabel = formatAgoLabel(summary.lastOutputAgo, t);

  // Issue #510: TeamHub diagnostics を 5s poll し、自カードの per-agent 行から
  // health (alive / stale / dead) と現在 status / pendingInbox を抽出する。
  // teamId / agentId が両方揃っているカードのみ意味がある (standalone agent は null)。
  const healthSnapshot = useTeamHealth(payload.teamId ?? null);
  const healthRow = payload.agentId
    ? healthSnapshot.byAgentId[payload.agentId] ?? null
    : null;
  const health = useMemo(() => deriveHealth(healthRow), [healthRow]);

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
            {payload.organization && (
              <span className="canvas-agent-card__organization">
                {payload.organization.name}
              </span>
            )}
            <span className="canvas-agent-card__role">{visual.label}</span>
          </span>
          <span className="canvas-agent-card__actions">
            <StatusBadge state={activity} label={t(`agentStatus.${activity}`)} />
            {status && (
              <span className="canvas-agent-card__status" title={status}>
                {shortStatus(status)}
              </span>
            )}
            {roleProfileId === 'leader' && (
              <button
                type="button"
                className="nodrag canvas-agent-card__tool"
                onClick={handleCreateHandoffClick}
                disabled={handoffBusy}
                title={t('handoff.createTooltip')}
                aria-label={t('handoff.create')}
              >
                <ClipboardCheck size={13} strokeWidth={1.9} />
              </button>
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
          className={
            'canvas-agent-card__summary' +
            (summary.needsLeaderInput
              ? ' canvas-agent-card__summary--alert'
              : '')
          }
          aria-label={t('agentCard.summary.region')}
        >
          <div
            className="canvas-agent-card__summary-row canvas-agent-card__summary-row--task"
            title={summary.taskTitle || t('agentCard.summary.noTask')}
          >
            <ClipboardList size={11} strokeWidth={2} aria-hidden="true" />
            <span className="canvas-agent-card__summary-text">
              {summary.taskTitle || t('agentCard.summary.noTask')}
            </span>
          </div>
          <div className="canvas-agent-card__summary-row canvas-agent-card__summary-row--clock">
            <Clock size={11} strokeWidth={2} aria-hidden="true" />
            <span className="canvas-agent-card__summary-text">
              {summaryAgoLabel}
            </span>
          </div>
          {summary.needsLeaderInput ? (
            <div
              className="canvas-agent-card__summary-row canvas-agent-card__summary-row--leader"
              role="status"
            >
              <AlertTriangle size={11} strokeWidth={2} aria-hidden="true" />
              <span className="canvas-agent-card__summary-text">
                {t('agentCard.summary.needsLeader')}
              </span>
            </div>
          ) : null}
          {/* Issue #510: 自カードに対応する TeamHub diagnostics 行から health badge を表示する。 */}
          {/* teamId / agentId が無いスタンドアロンカードでは何も出さない (= state==='unknown' は描画しない)。 */}
          {payload.agentId && payload.teamId && health.state !== 'unknown' ? (
            <div
              className={
                'canvas-agent-card__summary-row canvas-agent-card__summary-row--health' +
                ' canvas-agent-card__summary-row--health-' + health.state
              }
              role="status"
              title={
                t('agentCard.summary.health.tooltip', {
                  state: t(`agentCard.summary.health.state.${health.state}`),
                  status: health.currentStatus ?? t('agentCard.summary.health.noStatus')
                })
              }
            >
              {health.state === 'alive' ? (
                <Heart size={11} strokeWidth={2.2} aria-hidden="true" />
              ) : health.state === 'stale' ? (
                <HeartPulse size={11} strokeWidth={2.2} aria-hidden="true" />
              ) : (
                <Skull size={11} strokeWidth={2.2} aria-hidden="true" />
              )}
              <span className="canvas-agent-card__summary-text">
                {formatHealthLabel(health.state, health.ageMs, health.currentStatus, t)}
              </span>
            </div>
          ) : null}
          {/* Issue #509: 配送済みだが team_read で確認していない message の数。 */}
          {/* 60s 超過で stalled クラスを追加して警告色に切り替える。 */}
          {(payload.unreadInboxCount ?? 0) > 0 ? (() => {
            const ageMs = payload.oldestUnreadDeliveredAt
              ? Math.max(0, nowTick - new Date(payload.oldestUnreadDeliveredAt).getTime())
              : 0;
            const stalled = ageMs >= 60_000;
            const ageSec = Math.floor(ageMs / 1000);
            return (
              <div
                className={
                  'canvas-agent-card__summary-row canvas-agent-card__summary-row--unread' +
                  (stalled
                    ? ' canvas-agent-card__summary-row--unread-stalled'
                    : '')
                }
                role="status"
                title={t('inboxUnread.tooltip', {
                  count: payload.unreadInboxCount ?? 0,
                  ageSec
                })}
              >
                <Inbox size={11} strokeWidth={2} aria-hidden="true" />
                <span className="canvas-agent-card__summary-text">
                  {t('inboxUnread.label', {
                    count: payload.unreadInboxCount ?? 0,
                    ageSec
                  })}
                </span>
              </div>
            );
          })() : null}
        </div>
        {/* Issue #511: PTY inject 失敗 warning row。 */}
        {/* 通常時は何も rendering されず、`team:inject_failed` が来た瞬間に出現する。 */}
        {/* `__summary` block の sibling として置き、既存 header の flex レイアウトを破壊しない。 */}
        {payload.lastInjectFailure ? (
          <div
            className="canvas-agent-card__inject-warning"
            role="alert"
            aria-live="polite"
          >
            <AlertTriangle
              size={12}
              strokeWidth={2}
              className="canvas-agent-card__inject-warning__icon"
              aria-hidden="true"
            />
            <span
              className="canvas-agent-card__inject-warning__text"
              title={payload.lastInjectFailure.reason.message}
            >
              {t('injectFailure.title', {
                code: payload.lastInjectFailure.reason.code,
                message: payload.lastInjectFailure.reason.message
              })}
            </span>
            <button
              type="button"
              className="nodrag canvas-agent-card__inject-warning__retry"
              onClick={handleRetryInject}
              disabled={retryBusy}
              title={t('injectFailure.retry')}
              aria-label={t('injectFailure.retry')}
            >
              <RotateCcw size={11} strokeWidth={2} aria-hidden="true" />
              <span>
                {retryBusy
                  ? t('injectFailure.retryBusy')
                  : t('injectFailure.retry')}
              </span>
            </button>
            <button
              type="button"
              className="nodrag canvas-agent-card__inject-warning__dismiss"
              onClick={handleDismissInjectWarning}
              title={t('injectFailure.dismiss')}
              aria-label={t('injectFailure.dismiss')}
            >
              ×
            </button>
          </div>
        ) : null}
        <TerminalOverlay
          cardId={id}
          termRef={termRef}
          payload={payload}
          title={title}
          roleProfileId={roleProfileId}
          cwd={cwd}
          command={command}
          args={args}
          codexInstructions={codexInstructions}
          initialMessage={payload.initialMessage}
          onStatus={setStatus}
          onActivity={setActivity}
        />
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
