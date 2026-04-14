import { promises as fs } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { teamHub } from '../../team-hub';

const CODEX_SECTION = 'mcp_servers.vive-team';

/**
 * TOML から指定セクション（およびサブセクション）を取り除く。
 * `[foo.bar]` と `[foo.bar.baz]` を両方消したいケースを想定しているため、
 * `section` および `section.*` にマッチするヘッダをスキップ対象にする。
 */
export function removeTomlSection(content: string, section: string): string {
  const lines = content.split('\n');
  const result: string[] = [];
  let skip = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^\[.+\]$/.test(trimmed)) {
      const name = trimmed.slice(1, -1).trim();
      skip = name === section || name.startsWith(section + '.');
    }
    if (!skip) result.push(line);
  }
  while (result.length > 0 && result[result.length - 1].trim() === '') result.pop();
  return result.join('\n');
}

export async function setupCodexMcp(): Promise<void> {
  const codexDir = join(homedir(), '.codex');
  const codexConfigPath = join(codexDir, 'config.toml');
  await fs.mkdir(codexDir, { recursive: true });

  let content = '';
  try {
    content = await fs.readFile(codexConfigPath, 'utf-8');
  } catch {
    /* noop */
  }

  content = removeTomlSection(content, CODEX_SECTION);

  const escaped = teamHub.bridgePath.replace(/\\/g, '/');
  const section = [
    '',
    `[${CODEX_SECTION}]`,
    `command = "node"`,
    `args = ["${escaped}"]`,
    `env_vars = ["VIVE_TEAM_ID", "VIVE_TEAM_ROLE", "VIVE_AGENT_ID", "VIVE_TEAM_SOCKET", "VIVE_TEAM_TOKEN"]`,
    ''
  ].join('\n');

  await fs.writeFile(codexConfigPath, content + section, 'utf-8');
}

export async function cleanupCodexMcp(): Promise<void> {
  const codexConfigPath = join(homedir(), '.codex', 'config.toml');
  try {
    let content = await fs.readFile(codexConfigPath, 'utf-8');
    content = removeTomlSection(content, CODEX_SECTION);
    await fs.writeFile(codexConfigPath, content.trim() + '\n', 'utf-8');
  } catch {
    /* noop */
  }
}
