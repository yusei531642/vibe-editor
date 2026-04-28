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
//
// `RECRUIT_RADIUS` は requester (Leader) を中心とする同心円配置の半径 (要素中心 → 要素中心)。
// 厳密には NODE_W=640 に対して 544 < 640 なので、0° (真水平) の単独メンバー配置では
// 約 96 px の重なりが理論上発生する。これを許容する根拠:
//   - `findRecruitPosition` は既存メンバーが居る方角を避けて 12 スロットの中で最も空いた
//     角度をピックする。Leader+1 で 0° を選ばざるを得ないケースは少数派。
//   - Leader+1 は実運用では HR や planner で稀。多くは Leader 単独 / Leader+2 名以上。
//   - NODE_W + 80 = 720 まで広げると 6 名同心円配置で論理幅 2080 px 超を要求し、
//     1080p (1920x1080) で端メンバーが初期 viewport から外れる方が UX 退行として大きい。
// → 角度分散ロジック (`findRecruitPosition`) との組合せで実質的に重なりを回避する近似値
//   として 544 を採用する。0° 水平配置で重なりが観測されたら別 Issue で fitView 連動を検討。
const RECRUIT_RADIUS = Math.max(540, Math.round(NODE_W * 0.85));

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
