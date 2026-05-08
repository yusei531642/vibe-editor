/**
 * useRecruitListener — Tauri 側 TeamHub から発行される
 *   - team:recruit-request   (Leader / HR が team_recruit を呼んだ)
 *   - team:dismiss-request   (誰かが team_dismiss を呼んだ)
 *   - team:recruit-cancelled (timeout 等で取消)
 *   - team:recruit-rescued   (timeout 後 grace 中の ack 救済)
 * のイベントを受け、canvas store にカードを追加 / 削除 / 維持を通知する。
 *
 * App.tsx で 1 度だけ mount される想定。
 *
 * Issue #578: Canvas が非表示中 (`document.visibilityState === 'hidden'` または
 * Tauri Window がフォーカス外) に `team:recruit-request` を受けた場合は、件数を
 * ローカル ref に積み、可視化遷移時に Toast Context で 1 回まとめて警告する。
 * hidden 経過時間が 5000ms 以上 (env `VIBE_TEAM_RECRUIT_HIDDEN_THRESHOLD_MS` で調整可能)
 * の場合のみ Hub に観測 IPC `recruit_observed_while_hidden` を投げる。
 */
import { useEffect, useRef } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { useCanvasStore } from '../stores/canvas';
import type { Node } from '@xyflow/react';
import type { CardData } from '../stores/canvas';
import { useRoleProfiles } from './role-profiles-context';
import { ackRecruit } from './recruit-ack';
import { findRecruitPosition } from './canvas-recruit-position';
import type { RecruitRescuedPayload, WaitPolicy } from '../../../types/shared';
import { useToast } from './toast-context';
import { useT } from './i18n';
import {
  getHiddenSinceMs,
  isCanvasVisibleNow,
  subscribeOnVisible
} from './use-canvas-visibility';
import { api } from './tauri-api';

const DEFAULT_HIDDEN_THRESHOLD_MS = 5000;

function resolveHiddenThresholdMs(): number {
  // Vite は VITE_ プレフィックス付き env のみ renderer に注入する。
  // 実運用では `VIBE_TEAM_RECRUIT_HIDDEN_THRESHOLD_MS=10000 npm run dev` で起動するか、
  // Vite の define で `VITE_VIBE_TEAM_RECRUIT_HIDDEN_THRESHOLD_MS` として供給する。
  const raw = (import.meta as unknown as {
    env?: Record<string, string | undefined>;
  }).env?.VITE_VIBE_TEAM_RECRUIT_HIDDEN_THRESHOLD_MS;
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return DEFAULT_HIDDEN_THRESHOLD_MS;
}

interface RecruitRequestPayload {
  teamId: string;
  requesterAgentId: string;
  requesterRole: string;
  newAgentId: string;
  roleProfileId: string;
  engine: 'claude' | 'codex';
  agentLabelHint?: string;
  customInstructions?: string;
  waitPolicy?: WaitPolicy;
  /** Leader が team_recruit(role_definition=...) で 1 ステップ採用した場合に同梱される */
  dynamicRole?: {
    id: string;
    label: string;
    description: string;
    instructions: string;
    instructionsJa?: string;
  } | null;
}

interface DismissRequestPayload {
  teamId: string;
  agentId: string;
}

interface RecruitCancelledPayload {
  newAgentId: string;
  reason: string;
}

function waitPolicyInstructions(policy: WaitPolicy | undefined): string {
  const resolved = policy ?? 'strict';
  const header = `--- Worker wait_policy: ${resolved} ---`;
  if (resolved === 'proactive') {
    return [
      header,
      '- You may execute only lightweight actions explicitly listed in the current task Pre-approval section.',
      '- If the task has no Pre-approval section, behave as standard.',
      '- Do not edit files, run destructive commands, spend money, or contact external services unless that exact action is pre-approved.',
      '- Report what you did with team_send({ to: "leader", kind: "report", message: "..." }).'
    ].join('\n');
  }
  if (resolved === 'standard') {
    return [
      header,
      '- Wait for Leader-assigned tasks before executing work.',
      '- After completion or blocking, you may propose the next obvious action to the Leader.',
      '- Proposals are not permission to execute. Use team_send({ to: "leader", kind: "request", message: "..." }) and wait for assignment or Pre-approval.'
    ].join('\n');
  }
  return [
    header,
    '- Wait for Leader-assigned tasks.',
    '- Do not start follow-up investigation or code changes on your own.',
    '- After reporting completion or blocking, return to idle and wait for the next Leader message.'
  ].join('\n');
}

function mergeCustomInstructions(
  raw: string | undefined,
  waitPolicy: WaitPolicy | undefined
): string {
  return [raw?.trim(), waitPolicyInstructions(waitPolicy)].filter(Boolean).join('\n\n');
}

export function useRecruitListener(): void {
  // 動的ロールを RoleProfilesContext に投入するためのフック関数
  const { registerDynamicRole } = useRoleProfiles();
  const { showToast } = useToast();
  const t = useT();

  // Issue #578: hidden 中に積んだ recruit を可視化遷移で flush するため、
  // showToast / t は ref 経由で listen() callback から最新参照する。listen 登録は
  // mount 時 1 回だけで再登録しない (recruit handler の他処理と整合)。
  const showToastRef = useRef(showToast);
  showToastRef.current = showToast;
  const tRef = useRef(t);
  tRef.current = t;

  // hidden 中に観測した recruit の件数 + 最古の hidden 起点。可視化時に flush。
  const pendingHiddenRef = useRef<{ count: number; firstObservedAt: number | null }>({
    count: 0,
    firstObservedAt: null
  });
  // Issue #577: Hub 側の ack_done でも重複は防ぐが、renderer 側でも同じ agent の toast は 1 回に抑える。
  const rescuedRecruitToastRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    return subscribeOnVisible(() => {
      const pending = pendingHiddenRef.current;
      if (pending.count === 0) return;
      const count = pending.count;
      pendingHiddenRef.current = { count: 0, firstObservedAt: null };
      showToastRef.current(tRef.current('toast.recruitWhileHidden', { count }), {
        tone: 'warning',
        duration: 8000
      });
    });
  }, []);

  useEffect(() => {
    const unlistens: UnlistenFn[] = [];
    let cancelled = false;

    void listen<RecruitRequestPayload>('team:recruit-request', (e) => {
      if (cancelled) return;
      const p = e.payload;
      // Issue #578: Canvas が非表示中の recruit は件数を積み、可視化時にまとめて警告する。
      // hidden 経過時間が threshold 以上なら Hub にも観測 IPC を投げる (短時間 hidden で
      // info ログを汚染しない)。可視カード追加処理 (下の async ブロック) はそのまま続行する。
      if (!isCanvasVisibleNow()) {
        const pending = pendingHiddenRef.current;
        pending.count += 1;
        if (pending.firstObservedAt === null) pending.firstObservedAt = Date.now();
        const hiddenSince = getHiddenSinceMs();
        const hiddenForMs = hiddenSince === null ? 0 : Date.now() - hiddenSince;
        if (hiddenForMs >= resolveHiddenThresholdMs()) {
          void api.teamState
            .recruitObservedWhileHidden({
              teamId: p.teamId,
              agentId: p.newAgentId,
              hiddenForMs
            })
            .catch((err) => {
              console.warn('[recruit] recruit_observed_while_hidden IPC failed', err);
            });
        }
      }
      void (async () => {
        // Issue #342 Phase 1: requester 探索は 2 段階で行う。
        //   1. agentId 完全一致で 1 回走査 (旧挙動)。
        //   2. 見つからなければ 200ms grace を 1 回挟んで再走査
        //      (Canvas mode 起動直後・HMR 直後等、recruit emit が canvas store の
        //       hydration を追い越すレースを緩和する)。
        //   3. それでも無ければ「同 teamId の leader / hr」を fallback として採用
        //      (識別子分離で agentId が古いままになっても、同チームの権限ある
        //       カードに対して配置できれば UX 上は復帰できる)。
        // すべて失敗したら Hub に `phase=requester_not_found` で ack(false) を返す。
        // 自カードは消さず、Hub が emit する `team:recruit-cancelled` event の
        // ハンドラ側で一元的に removeCard する (チャネル方向の一意化)。
        const findRequester = (): Node<CardData> | undefined => {
          const nodes = useCanvasStore.getState().nodes;
          const exact = nodes.find((n) => {
            const data = n.data?.payload as { agentId?: string } | undefined;
            return data?.agentId === p.requesterAgentId;
          });
          if (exact) return exact;
          // 同 teamId 内の leader / hr に fallback
          return nodes.find((n) => {
            const data = n.data?.payload as
              | { agentId?: string; teamId?: string; roleProfileId?: string; role?: string }
              | undefined;
            if (!data || data.teamId !== p.teamId) return false;
            const r = data.roleProfileId ?? data.role ?? '';
            return r === 'leader' || r === 'hr';
          });
        };

        let requester = findRequester();
        if (!requester) {
          await new Promise((resolve) => setTimeout(resolve, 200));
          if (cancelled) return;
          requester = findRequester();
        }
        if (!requester) {
          console.warn('[recruit] requester card not found', p.requesterAgentId);
          try {
            await ackRecruit(p.newAgentId, p.teamId, {
              ok: false,
              reason: 'requester card not found',
              phase: 'requester_not_found'
            });
          } catch (err) {
            console.warn('[recruit] ack(requester_not_found) failed', err);
          }
          return;
        }
        // 動的ロール定義が同梱されていれば、AgentNodeCard が system prompt を組み立てる前に
        // RoleProfilesContext に登録する。team:role-created event でも同じことが起きるが、
        // 到達順に依存しないようここでも投入する。
        if (p.dynamicRole) {
          registerDynamicRole({
            id: p.dynamicRole.id,
            label: p.dynamicRole.label,
            description: p.dynamicRole.description,
            instructions: p.dynamicRole.instructions,
            instructionsJa: p.dynamicRole.instructionsJa,
            teamId: p.teamId
          });
        }
        const store = useCanvasStore.getState();
        const requesterPayload = (requester.data?.payload ?? {}) as {
          organization?: unknown;
        };
        const teamNodes = store.nodes.filter((n) => {
          const data = n.data?.payload as { teamId?: string } | undefined;
          return data?.teamId === p.teamId;
        });
        const pos = findRecruitPosition(requester, teamNodes);
        const titleHint = p.agentLabelHint?.trim() || p.roleProfileId;
        const newNodeId = store.addCard({
          type: 'agent',
          title: titleHint,
          position: pos,
          payload: {
            agent: p.engine,
            roleProfileId: p.roleProfileId,
            // 旧コード互換: role 旧フィールドにも書く (一時的)
            role: p.roleProfileId,
            teamId: p.teamId,
            agentId: p.newAgentId,
            organization: requesterPayload.organization,
            // Issue #117: AgentNodeCard が拾って Claude(--append-system-prompt) /
            // Codex(model_instructions_file) 両方の経路に注入する正本フィールド。
            customInstructions: mergeCustomInstructions(p.customInstructions, p.waitPolicy),
            waitPolicy: p.waitPolicy ?? 'strict'
          }
        });
        // Issue #253 / #372: 新メンバー配置後、Canvas 側で「新しい worker」を中心に
        // viewport を寄せる。HR が worker を増やすケースでも Leader ではなく
        // 追加されたばかりの worker が viewport の中央に来る。
        store.notifyRecruit(newNodeId);
        // Issue #342 Phase 1: addCard 完了 (= spawn 開始) 時点で Hub に受領通知を返す。
        // handshake 完了は待たない (それは Hub 側 RECRUIT_TIMEOUT=30s 経路の責務)。
        // ack(true) だけでは MCP success にはならず、真の成功判定は handshake のみ。
        try {
          await ackRecruit(p.newAgentId, p.teamId, { ok: true });
        } catch (err) {
          console.warn('[recruit] ack(ok) failed', err);
        }
      })();
    }).then((u) => {
      if (cancelled) {
        u();
      } else {
        unlistens.push(u);
      }
    });

    void listen<DismissRequestPayload>('team:dismiss-request', (e) => {
      if (cancelled) return;
      const p = e.payload;
      const store = useCanvasStore.getState();
      const target = store.nodes.find((n) => {
        const data = n.data?.payload as { agentId?: string; teamId?: string } | undefined;
        return data?.agentId === p.agentId && data?.teamId === p.teamId;
      });
      if (target) {
        // team_dismiss は 1 名だけ解雇する MCP 経路。チーム単位カスケードを無効化して、
        // Leader や他メンバーが連鎖的に閉じないようにする。
        store.removeCard(target.id, { cascadeTeam: false });
      }
    }).then((u) => {
      if (cancelled) {
        u();
      } else {
        unlistens.push(u);
      }
    });

    void listen<RecruitCancelledPayload>('team:recruit-cancelled', (e) => {
      if (cancelled) return;
      const p = e.payload;
      const store = useCanvasStore.getState();
      const target = store.nodes.find((n) => {
        const data = n.data?.payload as { agentId?: string } | undefined;
        return data?.agentId === p.newAgentId;
      });
      if (target) {
        console.warn(`[recruit] cancelled: ${p.reason}`);
        // recruit timeout / cancel で出る暫定カードだけを撤収する。
        // 既に立っている Leader / 他メンバーを巻き込まないようカスケード無効化。
        store.removeCard(target.id, { cascadeTeam: false });
      }
    }).then((u) => {
      if (cancelled) {
        u();
      } else {
        unlistens.push(u);
      }
    });

    void listen<RecruitRescuedPayload>('team:recruit-rescued', (e) => {
      if (cancelled) return;
      const p = e.payload;
      if (rescuedRecruitToastRef.current.has(p.newAgentId)) return;
      rescuedRecruitToastRef.current.add(p.newAgentId);
      console.info(`[recruit] rescued late ack: ${p.newAgentId} (${p.lateByMs}ms)`);
      // timeout cancel 後に ack が grace 内で届いた場合、カードは撤収せず維持する。
      showToastRef.current(tRef.current('toast.recruitRescued', { ms: p.lateByMs }), {
        tone: 'success',
        duration: 6000
      });
    }).then((u) => {
      if (cancelled) {
        u();
      } else {
        unlistens.push(u);
      }
    });

    return () => {
      cancelled = true;
      for (const u of unlistens) u();
    };
    // registerDynamicRole は useCallback 経由で stable なので再 listen は発生しない
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
