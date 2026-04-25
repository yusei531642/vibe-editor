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
import { useCanvasStore } from '../stores/canvas';
import type { Node } from '@xyflow/react';
import type { CardData } from '../stores/canvas';
import { useRoleProfiles } from './role-profiles-context';

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

const NODE_W = 480;
const NODE_H = 320;
const RECRUIT_RADIUS = 540; // requester からの距離

/** requester の周囲で空いている角度を見つけて配置位置を返す。
 *  既存メンバーの方角をスキャンし、最も空いている角度をピック。 */
function findRecruitPosition(
  requester: Node<CardData>,
  team: Node<CardData>[]
): { x: number; y: number } {
  const cx = requester.position.x + NODE_W / 2;
  const cy = requester.position.y + NODE_H / 2;
  const others = team.filter((n) => n.id !== requester.id);
  if (others.length === 0) {
    // 真右に出す
    return { x: requester.position.x + RECRUIT_RADIUS, y: requester.position.y };
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
    x: cx + Math.cos(bestAngle) * RECRUIT_RADIUS - NODE_W / 2,
    y: cy + Math.sin(bestAngle) * RECRUIT_RADIUS - NODE_H / 2
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
      const store = useCanvasStore.getState();
      const requester = store.nodes.find((n) => {
        const data = n.data?.payload as { agentId?: string } | undefined;
        return data?.agentId === p.requesterAgentId;
      });
      if (!requester) {
        console.warn('[recruit] requester card not found', p.requesterAgentId);
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
        store.removeCard(target.id);
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
        store.removeCard(target.id);
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
