/**
 * Windows では PATH 経由の .cmd ラッパー（例: C:\...\npm\claude.cmd）を
 * そのまま spawn するとConPTY 側でうまく引数解釈されない場合があるため、
 * cmd.exe /c <command> にフォールバックするユーティリティ。
 */
export function resolveCommand(
  command: string | undefined,
  args: string[] | undefined
): { command: string; args: string[] } {
  if (!command) {
    if (process.platform === 'win32') {
      return { command: 'powershell.exe', args: ['-NoLogo'] };
    }
    return { command: process.env.SHELL || '/bin/bash', args: [] };
  }

  if (process.platform === 'win32') {
    const lower = command.toLowerCase();
    if (lower.endsWith('.cmd') || lower.endsWith('.bat')) {
      return {
        command: process.env.COMSPEC || 'cmd.exe',
        args: ['/c', command, ...(args ?? [])]
      };
    }
    if (!/[\\/]/.test(command) && !/\.[a-z]{2,4}$/i.test(command)) {
      return {
        command: process.env.COMSPEC || 'cmd.exe',
        args: ['/c', command, ...(args ?? [])]
      };
    }
  }

  return { command, args: args ?? [] };
}
