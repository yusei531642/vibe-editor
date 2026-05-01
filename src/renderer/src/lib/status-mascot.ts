import type { ViewMode } from '../stores/ui';

export type StatusMascotState =
  | 'idle'
  | 'editing'
  | 'dirty'
  | 'running'
  | 'reviewing'
  | 'blocked';

export interface StatusMascotTerminalSnapshot {
  status: string;
  exited: boolean;
  hasActivity: boolean;
}

export interface StatusMascotSnapshot {
  viewMode: ViewMode;
  activeFilePath: string | null;
  activeEditorDirty: boolean;
  hasActiveDiff: boolean;
  gitChangeCount: number;
  terminals: StatusMascotTerminalSnapshot[];
}

export function getStatusMascotState(snapshot: StatusMascotSnapshot): StatusMascotState {
  const hasBlockedTerminal = snapshot.terminals.some(
    (terminal) => terminal.exited || isBlockedStatus(terminal.status)
  );
  if (hasBlockedTerminal) return 'blocked';

  const hasRunningActivity = snapshot.terminals.some(
    (terminal) => terminal.hasActivity || isStartingStatus(terminal.status)
  );
  if (hasRunningActivity) return 'running';

  if (snapshot.activeEditorDirty || snapshot.gitChangeCount > 0) return 'dirty';

  if (snapshot.hasActiveDiff || snapshot.viewMode === 'canvas') return 'reviewing';

  if (snapshot.activeFilePath) return 'editing';

  return 'idle';
}

function isStartingStatus(status: string): boolean {
  const normalized = status.toLowerCase();
  return (
    status.includes('起動中') ||
    status.includes('再接続') ||
    normalized.includes('starting') ||
    normalized.includes('reconnect')
  );
}

function isBlockedStatus(status: string): boolean {
  const normalized = status.toLowerCase();
  return (
    status.includes('起動失敗') ||
    status.includes('例外') ||
    status.includes('終了') ||
    normalized.includes('failed') ||
    normalized.includes('exception') ||
    normalized.includes('exit')
  );
}
