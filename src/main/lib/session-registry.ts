import type { IPty } from 'node-pty';

export interface Session {
  pty: IPty;
  webContentsId: number;
  teamId?: string;
  agentId?: string;
  role?: string;
}

/** 全アクティブ pty セッション。TeamHub からも参照する */
export const sessions = new Map<string, Session>();

/** agentId → pty セッションの逆引き。TeamHub が team_send 時に使う */
export const agentSessions = new Map<string, Session>();

/** pty を登録する。agentId があれば逆引きテーブルにも入れる */
export function registerSession(id: string, session: Session): void {
  sessions.set(id, session);
  if (session.agentId) {
    agentSessions.set(session.agentId, session);
  }
}

/**
 * pty を登録解除する。sessions から削除し、agentId があれば
 * agentSessions からも取り除く。見つかった Session を返す。
 */
export function removeSession(id: string): Session | undefined {
  const s = sessions.get(id);
  if (!s) return undefined;
  sessions.delete(id);
  if (s.agentId) {
    agentSessions.delete(s.agentId);
  }
  return s;
}

/** 全 pty を kill してテーブルを空にする。アプリ終了時に呼ぶ */
export function killAllSessions(): void {
  for (const s of sessions.values()) {
    try {
      s.pty.kill();
    } catch {
      /* noop */
    }
  }
  sessions.clear();
  agentSessions.clear();
}
