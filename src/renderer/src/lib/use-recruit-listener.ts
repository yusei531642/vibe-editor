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
import { safeUnlisten } from './tauri-api';

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
// チーム配置の標準セル寸法。findRecruitPosition と arrangeTeam (右クリック自動整理) で
// 同じ計算式を使うため、stores/canvas.ts の autoArrangeTeam とも揃えること。
const TEAM_COLS = 3;
const TEAM_GAP_X = 32;
const TEAM_GAP_Y = 60;

/** requester (Leader) の真下に 3 列グリッドで配置する。
 *  旧実装は "最も空いている角度" を radius 540 で探していたが、結果として
 *  メンバーが requester の周囲にバラバラに出て収拾がつかなかった。
 *  新方式: 既存メンバー数を index として、leader 直下の 3 列グリッドへ順に詰める。
 *  既存メンバーの位置を "再配置" しないので、この関数を呼ぶたびに位置が動く事故も無い。 */
function findRecruitPosition(
  requester: Node<CardData>,
  team: Node<CardData>[]
): { x: number; y: number } {
  const existing = team.filter((n) => n.id !== requester.id).length;
  const col = existing % TEAM_COLS;
  const row = Math.floor(existing / TEAM_COLS);
  // requester の中心を基準に 3 列を中央揃え。col 0 が左端、col 2 が右端になる。
  const cellW = NODE_W + TEAM_GAP_X;
  const startX = requester.position.x + NODE_W / 2 - (cellW * TEAM_COLS) / 2 + TEAM_GAP_X / 2;
  const startY = requester.position.y + NODE_H + TEAM_GAP_Y;
  return {
    x: startX + col * cellW,
    y: startY + row * (NODE_H + TEAM_GAP_Y)
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
    })
      .then((u) => {
        if (cancelled) {
          safeUnlisten(u);
        } else {
          unlistens.push(u);
        }
      })
      .catch(() => undefined);

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
    })
      .then((u) => {
        if (cancelled) {
          safeUnlisten(u);
        } else {
          unlistens.push(u);
        }
      })
      .catch(() => undefined);

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
    })
      .then((u) => {
        if (cancelled) {
          safeUnlisten(u);
        } else {
          unlistens.push(u);
        }
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
      // unlisten 由来の race 例外 (handlerId undefined) を吸収する。
      for (const u of unlistens) safeUnlisten(u);
    };
    // registerDynamicRole は useCallback 経由で stable なので再 listen は発生しない
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
