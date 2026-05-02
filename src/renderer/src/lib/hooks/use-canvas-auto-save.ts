import { useEffect, useMemo, useRef } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { Node } from '@xyflow/react';
import type { CardData } from '../../stores/canvas';
import type {
  HandoffReference,
  TeamHistoryEntry,
  TeamRole,
  TerminalAgent
} from '../../../../types/shared';
import { mergeCanvasMembers, serializeAutoSavePayload } from '../canvas-layout-helpers';

interface UseCanvasAutoSaveOptions {
  projectRoot: string;
  nodes: Node<CardData>[];
  viewport: { x: number; y: number; zoom: number };
  recent: TeamHistoryEntry[];
  setRecent: Dispatch<SetStateAction<TeamHistoryEntry[]>>;
}

/** Phase 5: Canvas state が変わったら、active な team について team-history へ自動保存。
 *
 *  Issue #124: ドラッグ中は React Flow が onNodesChange で毎フレーム新しい nodes 配列を
 *  commit するため、settled snapshot のみを auto-save 対象とする (caller 側で nodes を
 *  drag-bailout してから渡す前提)。
 *
 *  パフォーマンス対策:
 *    1. 保存対象を JSON stringify で stable key 化し deps に渡す (string 比較で早期 bailout)
 *    2. debounce 1500ms
 *    3. 直前保存値を ref に保持し同一内容なら fs 書き込みをスキップ
 *
 *  Issue #167: recent を deps に含むと setRecent → effect 再走で debounce が flush されない。
 *  ref 経由で参照することで deps から外す。
 *
 *  Issue #132: チームごとに save IPC を撃つと N チーム分 N 回 atomic_write が走るので、
 *  saveBatch で 1 IPC + 1 disk write にまとめる。
 */
export function useCanvasAutoSave(opts: UseCanvasAutoSaveOptions): void {
  const { projectRoot, nodes, viewport, setRecent } = opts;
  // Phase 5: Canvas state が変わったら、active な team について team-history へ自動保存。
  //
  // パフォーマンス注意:
  //   nodes は zustand で position 変化のたび (drag 中毎フレーム) 参照が変わるため、
  //   この useEffect を [nodes, viewport] に依存させると毎フレーム clearTimeout/setTimeout
  //   が走り、800ms 無操作が続かない限り保存されない (drag 中は永遠に保存されない)。
  //
  // 対策:
  //   1. 保存対象のエントリを JSON stringify で stable key 化し、deps に渡す (string 比較で
  //      早期 bailout)。
  //   2. debounce を 1500ms に延長。
  //   3. 直前保存値を ref に保持し、同一内容なら fs 書き込みをスキップ。
  const lastSavedKeyRef = useRef<string>('');
  // Issue #167: recent を deps に含むと setRecent → effect 再走 → clearTimeout で
  // debounce が永遠に flush されない問題があった。ref 経由で参照することで deps から外す。
  const recentRef = useRef(opts.recent);
  recentRef.current = opts.recent;
  const autoSavePayload = useMemo(() => {
    if (nodes.length === 0) return null;
    interface TeamEntryInfo {
      name: string;
      members: { role: TeamRole; agent: TerminalAgent }[];
      canvasNodes: { agentId: string; x: number; y: number; width?: number; height?: number }[];
      latestHandoff?: HandoffReference;
    }
    const byTeam = new Map<string, TeamEntryInfo>();
    for (const n of nodes) {
      const p = (n.data?.payload ?? {}) as {
        teamId?: string;
        agentId?: string;
        role?: string;
        agent?: string;
        latestHandoff?: HandoffReference;
      };
      if (!p.teamId || !p.agentId) continue;
      const title = String(n.data?.title ?? 'Team');
      const entry = byTeam.get(p.teamId) ?? { name: title, members: [], canvasNodes: [] };
      entry.members.push({
        role: (p.role ?? 'leader') as TeamRole,
        agent: (p.agent ?? 'claude') as TerminalAgent
      });
      entry.canvasNodes.push({
        agentId: p.agentId,
        // 位置は整数に丸めて key の微動を抑える (サブピクセル更新で再保存しない)
        x: Math.round(n.position.x),
        y: Math.round(n.position.y),
        width: typeof n.style?.width === 'number' ? Math.round(n.style.width as number) : undefined,
        height: typeof n.style?.height === 'number' ? Math.round(n.style.height as number) : undefined
      });
      if (p.latestHandoff) {
        const prev = entry.latestHandoff;
        const prevTime = prev?.updatedAt ?? prev?.createdAt ?? '';
        const nextTime = p.latestHandoff.updatedAt ?? p.latestHandoff.createdAt ?? '';
        if (!prev || nextTime >= prevTime) {
          entry.latestHandoff = p.latestHandoff;
        }
      }
      byTeam.set(p.teamId, entry);
    }
    return { byTeam, viewport };
  }, [nodes, viewport]);

  useEffect(() => {
    if (!autoSavePayload) return;
    const autoSaveKey = serializeAutoSavePayload(autoSavePayload);
    if (autoSaveKey === lastSavedKeyRef.current) return;
    const handle = window.setTimeout(() => {
      // debounce タイマー発火時点でも最新 key が変わらなければ保存
      lastSavedKeyRef.current = autoSaveKey;
      const nowIso = new Date().toISOString();
      const nextEntries: TeamHistoryEntry[] = [];
      for (const [teamId, info] of autoSavePayload.byTeam) {
        // Issue #167: recent を ref 経由で参照し effect deps から外す
        const existing = recentRef.current.find((entry) => entry.id === teamId);
        const entry: TeamHistoryEntry = {
          id: teamId,
          name: info.members.length > 0 ? `${info.name} (${info.members.length})` : info.name,
          projectRoot: existing?.projectRoot ?? projectRoot,
          createdAt: existing?.createdAt ?? nowIso,
          lastUsedAt: nowIso,
          members: mergeCanvasMembers(info.members, existing),
          canvasState: { nodes: info.canvasNodes, viewport: autoSavePayload.viewport },
          latestHandoff: info.latestHandoff ?? existing?.latestHandoff
        };
        nextEntries.push(entry);
      }
      // Issue #132: チームごとに save IPC を撃つと N チーム分 N 回 atomic_write が走る。
      // saveBatch で 1 IPC + 1 disk write にまとめる。
      if (nextEntries.length > 0) {
        void window.api.teamHistory.saveBatch(nextEntries).catch((err) => {
          console.warn('[recent] saveBatch failed:', err);
        });
      }
      if (nextEntries.length > 0) {
        setRecent((prev) => {
          const merged = new Map(prev.map((entry) => [entry.id, entry]));
          for (const entry of nextEntries) merged.set(entry.id, entry);
          return Array.from(merged.values()).sort((a, b) =>
            b.lastUsedAt.localeCompare(a.lastUsedAt)
          );
        });
      }
    }, 1500);
    return () => window.clearTimeout(handle);
    // Issue #167: recent を deps から除外。recentRef 経由で読むことで debounce flush を保証する。
  }, [autoSavePayload, projectRoot, setRecent]);
}
