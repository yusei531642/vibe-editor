import { teamHub } from '../../team-hub';

export interface BridgeDesired {
  type: 'stdio';
  command: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * Claude / Codex の MCP 設定で共有する bridge エントリ（command/args/env）を返す。
 * 片側だけ更新して齟齬が出るのを避けるため 1 箇所に集約している。
 */
export function bridgeDesired(): BridgeDesired {
  return {
    // Claude Code の mcpServers エントリには type 必須（既存 codex エントリ参照）
    type: 'stdio',
    command: 'node',
    args: [teamHub.bridgePath.replace(/\\/g, '/')],
    env: {
      VIVE_TEAM_SOCKET: teamHub.socketAddress,
      VIVE_TEAM_TOKEN: teamHub.token
    }
  };
}
