import { useEffect, useMemo, useState } from 'react';
import type { AppSettings } from '../../../../types/shared';
import { useT } from '../../lib/i18n';
import type { UpdateSetting } from './types';

interface Props {
  draft: AppSettings;
  update: UpdateSetting;
}

interface HubInfo {
  socket: string;
  token: string;
  bridgePath: string;
}

/**
 * MCP タブ — vibe-team MCP サーバーの導入方法を案内する。
 *
 * 3 セクション構成:
 *   1. 自動セットアップ ON/OFF トグル (既存の setupTeamMcp を無効化できる)
 *   2. AI エージェントに入れさせる: 英語プロンプトを現在の socket/token/bridge で埋めて表示
 *   3. 手動で入れる: ~/.claude.json / ~/.codex/config.toml の編集手順 + サンプル
 */
export function McpSection({ draft, update }: Props): JSX.Element {
  const t = useT();
  const [hub, setHub] = useState<HubInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.api.app
      .getTeamHubInfo()
      .then((info) => {
        if (!cancelled) setHub(info);
      })
      .catch((err) => {
        if (!cancelled) setLoadError(String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const socket = hub?.socket ?? '127.0.0.1:PORT';
  const token = hub?.token ?? 'TOKEN';
  const bridgePath = hub?.bridgePath ?? '/path/to/team-bridge.js';

  const aiPrompt = useMemo(
    () =>
      `You are installing a local MCP server named "vibe-team" for this machine's Claude Code / Codex configurations.

Perform the following steps exactly, then report the result.

STEP 1 — Claude Code (~/.claude.json):
Open the user's Claude Code configuration file at "~/.claude.json" (on Windows: "%USERPROFILE%\\.claude.json"). Under the top-level "mcpServers" object, add or update an entry named "vibe-team" with these fields (preserve all other entries as-is):
{
  "type": "stdio",
  "command": "node",
  "args": ["${bridgePath}"],
  "env": {
    "VIBE_TEAM_SOCKET": "${socket}",
    "VIBE_TEAM_TOKEN": "${token}"
  }
}

STEP 2 — Codex CLI (~/.codex/config.toml):
Open "~/.codex/config.toml". Add an [mcp_servers.vibe-team] section equivalent to the above:
[mcp_servers.vibe-team]
command = "node"
args = ["${bridgePath}"]
env = { VIBE_TEAM_SOCKET = "${socket}", VIBE_TEAM_TOKEN = "${token}" }

STEP 3 — Verify:
Run "claude mcp list" (or the Codex equivalent) and confirm that "vibe-team" appears. Do not modify any other entries.

Notes:
- Replace forward slashes with double backslashes if you are on Windows.
- Do not commit these files; they are per-user local configuration.`,
    [socket, token, bridgePath]
  );

  const manualJson = useMemo(
    () =>
      `{
  "mcpServers": {
    "vibe-team": {
      "type": "stdio",
      "command": "node",
      "args": ["${bridgePath}"],
      "env": {
        "VIBE_TEAM_SOCKET": "${socket}",
        "VIBE_TEAM_TOKEN": "${token}"
      }
    }
  }
}`,
    [socket, token, bridgePath]
  );

  const manualToml = useMemo(
    () =>
      `[mcp_servers.vibe-team]
command = "node"
args = ["${bridgePath}"]

[mcp_servers.vibe-team.env]
VIBE_TEAM_SOCKET = "${socket}"
VIBE_TEAM_TOKEN = "${token}"`,
    [socket, token, bridgePath]
  );

  return (
    <>
      <section className="modal__section">
        <h3>{t('settings.mcp.autoTitle')}</h3>
        <label className="mcp-toggle">
          <input
            type="checkbox"
            checked={draft.mcpAutoSetup !== false}
            onChange={(e) => update('mcpAutoSetup', e.target.checked)}
          />
          <span>{t('settings.mcp.autoLabel')}</span>
        </label>
        <p className="modal__note">{t('settings.mcp.autoHint')}</p>
      </section>

      <section className="modal__section">
        <h3>{t('settings.mcp.aiTitle')}</h3>
        <p className="modal__note">{t('settings.mcp.aiDesc')}</p>
        {loadError && <p className="modal__error">{loadError}</p>}
        <CodeBlock content={aiPrompt} lang="text" />
      </section>

      <section className="modal__section">
        <h3>{t('settings.mcp.manualTitle')}</h3>
        <p className="modal__note">{t('settings.mcp.manualDesc')}</p>
        <ol className="mcp-steps">
          <li>{t('settings.mcp.manualStep1')}</li>
          <li>{t('settings.mcp.manualStep2')}</li>
          <li>{t('settings.mcp.manualStep3')}</li>
        </ol>
        <p className="modal__note">
          {t('settings.mcp.claudeSampleNote')}
        </p>
        <CodeBlock content={manualJson} lang="json" />
        <p className="modal__note">
          {t('settings.mcp.codexSampleNote')}
        </p>
        <CodeBlock content={manualToml} lang="toml" />
        <p className="modal__note">
          <b>{t('settings.mcp.connInfoLabel')}</b> socket = <code>{socket}</code> / token ={' '}
          <code>{token}</code> / bridge = <code>{bridgePath}</code>
        </p>
      </section>
    </>
  );
}

function CodeBlock({
  content,
  lang
}: {
  content: string;
  lang: 'json' | 'toml' | 'text';
}): JSX.Element {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const onCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch (err) {
      console.warn('[mcp] copy failed:', err);
    }
  };
  return (
    <div className="mcp-codeblock" data-lang={lang}>
      <button
        type="button"
        className="mcp-codeblock__copy"
        onClick={onCopy}
        aria-label={t('settings.mcp.copy')}
      >
        {copied ? t('settings.mcp.copied') : t('settings.mcp.copy')}
      </button>
      <pre>
        <code>{content}</code>
      </pre>
    </div>
  );
}
