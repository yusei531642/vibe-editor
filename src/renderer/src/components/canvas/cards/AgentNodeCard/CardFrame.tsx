/**
 * AgentNodeCard / CardFrame (root)
 *
 * Issue #487: AgentNodeCard 単一ファイルから「カード枠 + role visual + handoff UI」
 * を切り出したもの。pty / xterm の配線は隣接の TerminalOverlay.tsx に分けてある。
 *
 * Issue #735: ~900 行の god card だった本ファイルを以下の子コンポーネントへ分割した。
 *   - `CardFrame.tsx`        — root: state/派生の解決 + layout (NodeResizer / Handle /
 *                              .canvas-agent-card) + 子コンポーネントの合成
 *   - `CardPresentation.tsx` — ヘッダーの視覚表現 (avatar / title / role / status pill)
 *   - `CardHandoff.tsx`      — Leader 専用 handoff 作成ボタン + 注入フロー
 *   - `CardInject.tsx`       — PTY inject 失敗の警告 row + リトライ UI
 *   - `CardSummary.tsx`      — current task / 経過 / health / 未読 inbox サマリ
 * さらに、zustand selector callback 内で ref を mutate していた pure 違反を
 * `useTeamMembersSig` (useSyncExternalStore ベース) へ移して解消した。
 *
 * 責務 (この root):
 *   - NodeResizer + 入出力 Handle (xyflow)
 *   - ロール由来の accent / avatar / 表示ラベル (resolveAgentVisual)
 *   - 起動引数 (command / args / sysPrompt / codexInstructions) の解決
 *   - agent-activity store への activity / summary の publish
 *   - 子コンポーネント (Presentation / Handoff / Inject / Summary) と TerminalOverlay の合成
 *
 * 挙動は元 AgentNodeCard.tsx と完全一致。構造のみ整理。
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Handle,
  NodeResizer,
  Position,
  type Node,
  type NodeProps
} from '@xyflow/react';
import { useT } from '../../../../lib/i18n';
import { useTeamHealth } from '../../../../lib/use-team-health';
import { deriveHealth } from '../../../../lib/agent-health';
import { useTeamHandoff } from '../../../../lib/use-team-handoff';
import { useTeamInboxRead } from '../../../../lib/use-team-inbox-read';
import { applyHandoffArrival, applyInboxRead } from './unread-inbox-count';
import { useSettings } from '../../../../lib/settings-context';
import {
  useCanvasStore,
  NODE_MIN_W,
  NODE_MIN_H,
  type CardDataOf
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
  type CardSummary as CardSummaryData
} from '../../../../lib/agent-summary';
import type { TerminalViewHandle } from '../../../TerminalView';
import type { AgentPayload, AgentStatus } from './types';
import { TerminalOverlay } from './TerminalOverlay';
import { useTeamMembersSig } from './use-team-members-sig';
import { CardPresentation } from './CardPresentation';
import { CardHandoff } from './CardHandoff';
import { CardInject } from './CardInject';
import { CardSummary, type CardSummaryHealth } from './CardSummary';

// Issue #732: `NodeProps` を `Node<CardDataOf<'agent'>>` で具体化することで
// `data.payload` が `AgentPayload` として読め、`unknown` からの inline cast が不要になる。
function AgentNodeCardImpl({
  id,
  data
}: NodeProps<Node<CardDataOf<'agent'>>>): JSX.Element {
  const termRef = useRef<TerminalViewHandle | null>(null);
  const { settings } = useSettings();
  const t = useT();
  const confirmRemoveCard = useConfirmRemoveCard();
  const setCardPayload = useCanvasStore((s) => s.setCardPayload);
  const { showToast } = useToast();
  // payload 未設定でも落ちないよう空オブジェクトでフォールバック (AgentPayload は全 field optional)。
  const payload: AgentPayload = data?.payload ?? {};
  // 新スキーマ roleProfileId を優先、無ければ legacy role を読む
  const roleProfiles = useRoleProfiles();
  const profilesById = roleProfiles.byId;
  const globalPreamble = roleProfiles.file.globalPreamble;
  const visual = resolveAgentVisual(payload, profilesById, settings.language);
  const roleProfileId = visual.roleProfileId;
  const profile = visual.profile;
  const accent = visual.agentAccent;
  const organizationAccent = visual.organizationAccent;
  const title = data?.title ?? visual.label;
  const [status, setStatus] = useState<string>('');
  const [activity, setActivityState] = useState<AgentStatus>('idle');

  // Issue #521: agent-activity store に書き出して StageHud 側からも観測できるようにする。
  // CardFrame が unmount されても store にレコードを残さないよう effect で掃除する。
  const publishActivity = useAgentActivityStore((s) => s.setActivity);
  const clearActivity = useAgentActivityStore((s) => s.clearCard);
  // TerminalOverlay は React.Dispatch<SetStateAction<AgentStatus>> を期待するので、
  // 関数形 updater を素通しできる shape を保つ。agent-activity store への publish は
  // 下の effect に集約し、子コンポーネントの render 中に呼ばれても StageHud を同期更新しない。
  const setActivity: React.Dispatch<React.SetStateAction<AgentStatus>> = useCallback(
    (next) => {
      setActivityState(next);
    },
    []
  );
  useEffect(() => {
    publishActivity(id, activity, Date.now());
  }, [id, activity, publishActivity]);
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
  // 文字列 equality で React がデフォルトで bailout できるようにする。
  //
  // Issue #735: 旧実装は signature 計算を zustand selector callback 内で行いつつ
  // `lastTeamMembersSigRef.current = sig` と ref を mutate していた (selector pure 違反)。
  // signature 計算は useSyncExternalStore ベースの `useTeamMembersSig` へ移し、
  // selector からの ref mutate を撤廃した。
  const teamMembersSig = useTeamMembersSig(payload.teamId);
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

  // Issue #660 / #752 / #753: client-side UUID 事前注入。
  // payload.resumeSessionId が無い (= 新規 mount) なら UUID v4 を採番して
  // `--session-id <uuid>` で起動する。ここで Canvas store へ先に書き戻すと、
  // TerminalView の初回 spawn が走る前の再描画で `--resume <まだ存在しないuuid>` に
  // 切り替わり、Claude CLI が "No conversation found with session ID" で終了する。
  // そのため永続化は TerminalOverlay の onSessionId (jsonl 検出後) にだけ任せる。
  const ensuredSessionId = useMemo<string | null>(() => {
    if (!isClaude) return null;
    return payload.resumeSessionId ?? crypto.randomUUID();
  }, [isClaude, payload.resumeSessionId]);

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
    // Issue #660 / #752 / #753: Claude のみ session 制御フラグを付与 (Codex は両方とも非対応)。
    //   - payload.resumeSessionId 既存 → 永続化済みなので `--resume` で前回会話を継続
    //   - payload.resumeSessionId 空 → 採番した UUID を `--session-id` で強制注入
    // 新規 UUID は jsonl 検出後にだけ payload へ保存する。初回 spawn 前に保存すると
    // まだ存在しない会話を resume してしまうため。
    if (isClaude && ensuredSessionId) {
      if (payload.resumeSessionId) {
        base.push('--resume', ensuredSessionId);
      } else {
        base.push('--session-id', ensuredSessionId);
      }
    }
    return base.length > 0 ? base : undefined;
  }, [
    isClaude,
    isCodex,
    resolved.args,
    sysPrompt,
    payload.teamId,
    ensuredSessionId,
    payload.resumeSessionId,
    settings.claudeArgs,
    settings.codexArgs
  ]);

  const codexInstructions = isCodex ? sysPrompt : undefined;

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
    const timer = window.setInterval(() => setNowTick(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);
  const summary = useMemo<CardSummaryData>(
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

  // Issue #510: TeamHub diagnostics を 5s poll し、自カードの per-agent 行から
  // health (alive / stale / dead) と現在 status / pendingInbox を抽出する。
  // teamId / agentId が両方揃っているカードのみ意味がある (standalone agent は null)。
  const healthSnapshot = useTeamHealth(payload.teamId ?? null);
  const healthRow = payload.agentId
    ? healthSnapshot.byAgentId[payload.agentId] ?? null
    : null;
  const health = useMemo(() => deriveHealth(healthRow), [healthRow]);
  const hasHealthRow = healthRow !== null;
  const unreadInboxCount = hasHealthRow
    ? health.pendingInboxCount
    : payload.unreadInboxCount ?? 0;
  // CardSummary に渡す health 派生値。health 行を出すのは teamId / agentId が両方あり
  // state が 'unknown' でないとき (= standalone カードでは出さない)。
  const showHealthRow = Boolean(payload.agentId) && Boolean(payload.teamId) && health.state !== 'unknown';
  const summaryHealth = useMemo<CardSummaryHealth>(
    () => ({
      state: health.state,
      ageMs: health.ageMs,
      currentStatus: health.currentStatus,
      stalledInbound: health.stalledInbound,
      oldestPendingInboxAgeMs: health.oldestPendingInboxAgeMs
    }),
    [health]
  );

  const handleClose = useCallback(() => confirmRemoveCard(id), [confirmRemoveCard, id]);

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
        <CardPresentation
          cardId={id}
          title={title}
          roleLabel={visual.label}
          glyph={profile.visual.glyph}
          organizationName={payload.organization?.name}
          activity={activity}
          status={status}
          handoff={
            <CardHandoff
              cardId={id}
              payload={payload}
              roleProfileId={roleProfileId}
              title={title}
              visualLabel={visual.label}
              cwd={cwd}
              termRef={termRef}
              setCardPayload={setCardPayload}
              showToast={showToast}
              t={t}
            />
          }
          onClose={handleClose}
          t={t}
        />
        <CardSummary
          summary={summary}
          health={summaryHealth}
          showHealthRow={showHealthRow}
          hasHealthRow={hasHealthRow}
          unreadInboxCount={unreadInboxCount}
          oldestUnreadDeliveredAt={payload.oldestUnreadDeliveredAt}
          nowTick={nowTick}
          t={t}
        />
        <CardInject
          cardId={id}
          payload={payload}
          setCardPayload={setCardPayload}
          showToast={showToast}
          t={t}
        />
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

export default memo(AgentNodeCardImpl);
