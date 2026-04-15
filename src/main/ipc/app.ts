import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { join } from 'path';
import { homedir, userInfo } from 'os';
import type { AppUserInfo, ClaudeCheckResult } from '../../types/shared';
import { teamHub } from '../team-hub';
import { checkCommandAvailable } from '../lib/check-command';
import { setupClaudeMcp, cleanupClaudeMcp } from '../lib/mcp-config/claude-mcp';
import { setupCodexMcp, cleanupCodexMcp } from '../lib/mcp-config/codex-mcp';

export function registerAppIpc(): void {
  ipcMain.handle('app:getProjectRoot', () => {
    return process.cwd();
  });

  ipcMain.handle('app:restart', () => {
    app.relaunch();
    app.exit(0);
  });

  ipcMain.handle('app:setWindowTitle', (event, title: string) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    win?.setTitle(title);
  });

  ipcMain.handle(
    'app:checkClaude',
    async (_e, command: string): Promise<ClaudeCheckResult> => {
      return checkCommandAvailable(command);
    }
  );

  ipcMain.handle('app:setZoomLevel', (event, level: number) => {
    event.sender.setZoomLevel(level);
  });

  ipcMain.handle('app:getZoomLevel', (event) => {
    return event.sender.getZoomLevel();
  });

  // ---------- ユーザー情報 / アプリ情報 ----------
  ipcMain.handle('app:getUserInfo', (): AppUserInfo => {
    let username = 'user';
    try {
      username = userInfo().username || process.env.USERNAME || process.env.USER || 'user';
    } catch {
      username = process.env.USERNAME || process.env.USER || 'user';
    }
    return {
      username,
      version: app.getVersion(),
      platform: process.platform,
      electronVersion: process.versions.electron,
      nodeVersion: process.versions.node,
      chromeVersion: process.versions.chrome
    };
  });

  ipcMain.handle('app:openExternal', async (_e, url: string) => {
    // 外部リンク(リリースページ等)は shell.openExternal で既定ブラウザへ。
    // セキュリティ的に https:// のみ許可する。
    if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'invalid url' };
    try {
      await shell.openExternal(url);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  // ---------- Team MCP (TeamHub bridge 方式) ----------
  //
  // Claude/Codex に MCP サーバー "vive-team" として TeamHub bridge を登録する。
  // bridge はメインプロセス内 TeamHub へ TCP 接続し、team_send は対象 pty に
  // 直接注入されるため、共有ファイルのポーリングは不要。

  ipcMain.handle(
    'app:setupTeamMcp',
    async (
      _e,
      projectRoot: string,
      teamId: string,
      teamName: string,
      _members: { agentId: string; role: string; agent: string }[]
    ) => {
      try {
        if (!teamHub.isRunning) {
          return { ok: false, error: 'TeamHub is not running' };
        }

        // _init は起動時のウォームアップ呼び出し。activeTeamIds には追加しない。
        teamHub.registerTeam(teamId, teamName);

        const [claudeChanged] = await Promise.all([
          setupClaudeMcp(),
          setupCodexMcp()
        ]);

        // ダイアログは出さずに renderer へ「変更あり」を返すだけ。
        // renderer 側が必要に応じて既存 Claude タブを自動再起動する。
        return {
          ok: true,
          socket: teamHub.socketAddress,
          changed: claudeChanged
        };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    }
  );

  ipcMain.handle('app:cleanupTeamMcp', async (_e, _projectRoot: string, teamId: string) => {
    try {
      if (!teamId || teamId === '_init') {
        return { ok: true, removed: false };
      }
      // 参照カウント: アクティブチームが 0 になったときだけ claude.json / codex から消す。
      // 他のチームがまだ生きている最中にグローバルな vive-team エントリを消すと、
      // そのチームの Claude/Codex が次回再スポーン時に MCP ブリッジを失う。
      const shouldRemoveMcp = teamHub.clearTeam(teamId);
      if (shouldRemoveMcp) {
        await Promise.all([cleanupClaudeMcp(), cleanupCodexMcp()]);
      }
      return { ok: true, removed: shouldRemoveMcp };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  // 後方互換: レンダラーが旧 API を呼んでもエラーにしないためのスタブ
  ipcMain.handle('app:getTeamFilePath', (_e, teamId: string) => {
    return join(homedir(), '.vibe-editor', 'teams', `${teamId}.json`);
  });

  ipcMain.handle('app:getMcpServerPath', () => {
    // 後方互換: 新方式では bridge パスを返す
    return teamHub.bridgePath;
  });

  ipcMain.handle('app:getTeamHubInfo', () => {
    return {
      socket: teamHub.socketAddress,
      token: teamHub.token,
      bridgePath: teamHub.bridgePath
    };
  });
}
