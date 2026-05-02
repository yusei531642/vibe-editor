import { useEffect, useRef } from 'react';
import type { Node } from '@xyflow/react';
import type { CardData } from '../../stores/canvas';

interface UseCanvasTeamRestoreOptions {
  projectRoot: string;
  nodes: Node<CardData>[];
  mcpAutoSetup: boolean;
}

/** Issue #159: 起動時の Canvas チーム復元 setupTeamMcp 効果。
 *  各 nodes が持つ teamId をユニーク化して setupTeamMcp を 1 度だけ呼び直し、
 *  TeamHub に再登録する。これがないと team_send 等の MCP ツールが
 *  「unregistered team_id」で弾かれる。
 *
 *  in_flight / failed (backoff 中) / done の 3 状態で無限再試行ループを防ぐ。
 *  failed バックオフは 30 秒。Clear (nodes.length === 0) で ref をリセット。
 */
export function useCanvasTeamRestore(opts: UseCanvasTeamRestoreOptions): void {
  const { projectRoot, nodes, mcpAutoSetup } = opts;
  // 起動時のチーム復元 — canvas store は zustand persist で localStorage から
  // nodes/viewport が復元されるが、Rust 側 TeamHub は再起動でリセットされるため
  // active_teams が空のまま。各 nodes が持つ teamId をユニーク化して setupTeamMcp を
  // 1 度だけ呼び直し、TeamHub に再登録する。これがないと team_send 等の MCP ツールが
  // 「unregistered team_id」で弾かれ「resume されず新しい状態に見える」原因になる。
  // Issue #159: 旧実装は「成功 / 未試行」の 2 状態しか持たず、失敗 → ref から削除 →
  //   次レンダーで再試行 → 失敗、を毎フレーム繰り返して .claude.json が連射書込される
  //   無限再試行ループに入っていた。in_flight / failed (backoff 中) / done の 3 状態に拡張する。
  type RestoreState = 'in_flight' | 'failed' | 'done';
  const restoredTeamsRef = useRef<Map<string, { state: RestoreState; nextRetryAt?: number }>>(
    new Map()
  );
  useEffect(() => {
    if (nodes.length === 0) {
      // Clear 後は次のチームでまた setup したいので ref をリセット
      restoredTeamsRef.current.clear();
    }
  }, [nodes.length]);
  useEffect(() => {
    if (!projectRoot) return;
    if (mcpAutoSetup === false) return;
    interface TeamRestoreInfo {
      name: string;
      members: { agentId: string; role: string; agent: string }[];
    }
    const byTeam = new Map<string, TeamRestoreInfo>();
    for (const n of nodes) {
      const p = (n.data?.payload ?? {}) as {
        teamId?: string;
        agentId?: string;
        role?: string;
        agent?: string;
      };
      if (!p.teamId || !p.agentId || !p.role || !p.agent) continue;
      const title = String(n.data?.title ?? 'Team');
      const tm = byTeam.get(p.teamId) ?? { name: title, members: [] };
      tm.members.push({ agentId: p.agentId, role: p.role, agent: p.agent });
      byTeam.set(p.teamId, tm);
    }
    const now = Date.now();
    for (const [teamId, info] of byTeam) {
      const cur = restoredTeamsRef.current.get(teamId);
      if (cur?.state === 'in_flight' || cur?.state === 'done') continue;
      // failed バックオフ中なら待機
      if (cur?.state === 'failed' && cur.nextRetryAt && now < cur.nextRetryAt) continue;
      // 進行中状態に登録してから IPC 発射 (重複発火防止)
      restoredTeamsRef.current.set(teamId, { state: 'in_flight' });
      void window.api.app
        .setupTeamMcp(projectRoot, teamId, info.name, info.members)
        .then(() => {
          restoredTeamsRef.current.set(teamId, { state: 'done' });
        })
        .catch((err) => {
          // 30 秒バックオフ。連続失敗時に毎レンダー再投入されるのを防ぐ。
          restoredTeamsRef.current.set(teamId, {
            state: 'failed',
            nextRetryAt: Date.now() + 30_000
          });
          console.warn('[restore] setupTeamMcp failed:', err);
        });
    }
  }, [projectRoot, nodes, mcpAutoSetup]);
}
