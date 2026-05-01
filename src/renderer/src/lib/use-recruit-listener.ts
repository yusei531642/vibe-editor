/**
 * useRecruitListener — Tauri 側 TeamHub から発行される
 *   - team:recruit-request   (Leader / HR が team_recruit を呼んだ)
 *   - team:dismiss-request   (誰かが team_dismiss を呼んだ)
 *   - team:recruit-cancelled (timeout 等で取消)
 * の 3 イベントを受け、canvas store にカードを追加 / 削除する。
 *
 * App.tsx で 1 度だけ mount される想定。
 */
import { useEffect } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { useCanvasStore, NODE_W, NODE_H } from '../stores/canvas';
import type { Node } from '@xyflow/react';
import type { CardData } from '../stores/canvas';
import { useRoleProfiles } from './role-profiles-context';
import { ackRecruit } from './recruit-ack';

interface RecruitRequestPayload {
  teamId: string;
  requesterAgentId: string;
  requesterRole: string;
  newAgentId: string;
  roleProfileId: string;
  engine: 'claude' | 'codex';
  agentLabelHint?: string;
  customInstructions?: string;
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

// NODE_W / NODE_H は stores/canvas.ts の共有定数を import (Issue #253 で 640x400 に拡張)

/**
 * Issue #259: 同心円配置の半径を「メンバー数 + 画面サイズ」両方に応じた可変値にする。
 *  - 0-3 名: NODE_W + 60 (狭めに、1080p でも fitView せず収まる)
 *  - 4-5 名: NODE_W + 80 (PR #257 と同じ既存挙動を維持)
 *  - 6+ 名: 同心円ではなくグリッド配置に切替えるため radius は使われない
 *  - clamp: 画面サイズの 45% を上限として極端な小画面で半径が画面外を超えないようにする
 *           (NODE_W 未満には絶対しない)
 */
function computeRecruitRadius(memberCount: number): number {
  const base = memberCount <= 3 ? NODE_W + 60 : NODE_W + 80;
  const screenSize = Math.max(
    typeof window !== 'undefined' ? window.innerWidth : 1920,
    typeof window !== 'undefined' ? window.innerHeight : 1080
  );
  const cap = Math.max(NODE_W, screenSize * 0.45);
  return Math.min(base, cap);
}

/**
 * Issue #259: 6 名以上 (Leader 含む newMemberCount >= 6) は同心円配置を諦め、
 * requester の右側 2 列グリッドに展開する。論理幅が小画面 viewport を超えても
 * Canvas 側 fitView の zoom 下限ガードと組み合わせて UX を保つ。
 */
const GRID_PLACEMENT_THRESHOLD = 6;
const GRID_COLS = 2;
const GRID_COL_GAP = 32;
const GRID_ROW_GAP = 32;

/** requester の周囲で空いている角度を見つけて配置位置を返す。
 *  既存メンバーの方角をスキャンし、最も空いている角度をピック。 */
function findRecruitPosition(
  requester: Node<CardData>,
  team: Node<CardData>[]
): { x: number; y: number } {
  const others = team.filter((n) => n.id !== requester.id);
  const newMemberCount = others.length + 1;

  // Issue #259: 6 名以上は requester の右側 2 列グリッドに展開
  if (newMemberCount >= GRID_PLACEMENT_THRESHOLD) {
    const newIdx = others.length; // 0-based new index = 既存 others 数
    const col = newIdx % GRID_COLS;
    const row = Math.floor(newIdx / GRID_COLS);
    return {
      x: requester.position.x + (NODE_W + GRID_COL_GAP) * (col + 1),
      y: requester.position.y + (NODE_H + GRID_ROW_GAP) * row
    };
  }

  // 通常: 同心円配置 (可変半径)
  const radius = computeRecruitRadius(newMemberCount);
  const cx = requester.position.x + NODE_W / 2;
  const cy = requester.position.y + NODE_H / 2;
  if (others.length === 0) {
    return { x: requester.position.x + radius, y: requester.position.y };
  }
  // 既存メンバーの角度を集計
  const usedAngles = others.map((n) => {
    const ox = n.position.x + NODE_W / 2;
    const oy = n.position.y + NODE_H / 2;
    return Math.atan2(oy - cy, ox - cx);
  });
  // 12 等分のスロットを試して、最も近い既存メンバーから角度的に最も離れた slot を選ぶ
  const SLOTS = 12;
  let bestAngle = 0;
  let bestDist = -1;
  for (let i = 0; i < SLOTS; i++) {
    const a = (i / SLOTS) * Math.PI * 2 - Math.PI / 2; // 上から時計回り
    const minDistToUsed = usedAngles.reduce((min, u) => {
      const d = Math.min(
        Math.abs(a - u),
        Math.abs(a - u + Math.PI * 2),
        Math.abs(a - u - Math.PI * 2)
      );
      return Math.min(min, d);
    }, Number.POSITIVE_INFINITY);
    if (minDistToUsed > bestDist) {
      bestDist = minDistToUsed;
      bestAngle = a;
    }
  }
  return {
    x: cx + Math.cos(bestAngle) * radius - NODE_W / 2,
    y: cy + Math.sin(bestAngle) * radius - NODE_H / 2
  };
}

export function useRecruitListener(): void {
  // 動的ロールを RoleProfilesContext に投入するためのフック関数
  const { registerDynamicRole } = useRoleProfiles();

  useEffect(() => {
    const unlistens: UnlistenFn[] = [];
    let cancelled = false;

    void listen<RecruitRequestPayload>('team:recruit-request', (e) => {
      if (cancelled) return;
      const p = e.payload;
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
        const teamNodes = store.nodes.filter((n) => {
          const data = n.data?.payload as { teamId?: string } | undefined;
          return data?.teamId === p.teamId;
        });
        const pos = findRecruitPosition(requester, teamNodes);
        const titleHint = p.agentLabelHint?.trim() || p.roleProfileId;
        store.addCard({
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
            // Issue #117: AgentNodeCard が拾って Claude(--append-system-prompt) /
            // Codex(model_instructions_file) 両方の経路に注入する正本フィールド。
            customInstructions: p.customInstructions || undefined
          }
        });
        // Issue #253: 新メンバー配置後に Canvas 側で fitView を発火させる。
        // RECRUIT_RADIUS=NODE_W+80 で 6 名同心円配置時に端が viewport 外になる UX 退行を吸収。
        store.notifyRecruit();
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

    return () => {
      cancelled = true;
      for (const u of unlistens) u();
    };
    // registerDynamicRole は useCallback 経由で stable なので再 listen は発生しない
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
