import { promises as fs } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { bridgeDesired } from './index';

// Claude Code の MCP 設定はユーザースコープ (top-level mcpServers) と
// プロジェクトスコープ (projects[path].mcpServers) の2層があるが、後者は
// キー正規化仕様がバージョン依存で不確実なため、確実に読まれる
// ユーザースコープのみを使う。

/** @returns true if config was actually changed */
export async function setupClaudeMcp(): Promise<boolean> {
  const claudeConfigPath = join(homedir(), '.claude.json');
  let config: Record<string, unknown> = {};
  try {
    const raw = await fs.readFile(claudeConfigPath, 'utf-8');
    config = JSON.parse(raw);
  } catch {
    /* noop */
  }

  if (!config.mcpServers || typeof config.mcpServers !== 'object') {
    config.mcpServers = {};
  }
  const servers = config.mcpServers as Record<string, unknown>;
  const desired = bridgeDesired();

  if (JSON.stringify(servers['vive-team']) === JSON.stringify(desired)) {
    return false;
  }

  servers['vive-team'] = desired;
  await fs.writeFile(claudeConfigPath, JSON.stringify(config, null, 2), 'utf-8');
  return true;
}

export async function cleanupClaudeMcp(): Promise<void> {
  const claudeConfigPath = join(homedir(), '.claude.json');
  try {
    const raw = await fs.readFile(claudeConfigPath, 'utf-8');
    const config = JSON.parse(raw);
    if (config.mcpServers?.['vive-team']) {
      delete config.mcpServers['vive-team'];
      await fs.writeFile(claudeConfigPath, JSON.stringify(config, null, 2), 'utf-8');
    }
  } catch {
    /* noop */
  }
}
