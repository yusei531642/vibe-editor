import { useCallback, useEffect, useRef, useState } from 'react';
import type { GitStatus, SessionInfo } from '../../../../types/shared';
import { useT } from '../i18n';
import {
  useSettingsActions,
  useSettingsLoading,
  useSettingsValue
} from '../settings-context';
import { dedupPrepend } from '../path-norm';

export interface UseProjectLoaderOptions {
  /** 既存タブの discard 確認。返り値が false ならプロジェクト切替を中止する。
   *  Phase 1-2 (use-file-tabs) 抽出までの一時的注入。 */
  confirmDiscardEditorTabs: () => boolean;
  /** loadProject によりプロジェクトが切り替わった直後に呼ばれる。
   *  App.tsx 側で editor tabs / sessions / teams / terminal tabs を初期化するために使う。
   *  Phase 1-2 〜 1-4 で各 hook に分散したら順次 opts から削る。 */
  onProjectSwitched: (root: string) => void;
  /** loadProject / 初回ロード effect で取得した snapshot を上に流す。
   *  hook が責務外として保持しない state (sessions など) を親に伝える橋渡し。 */
  onLoaded: (snapshot: { gitStatus: GitStatus; sessions: SessionInfo[] }) => void;
  /** ステータスバー文字列を更新する callback (App.tsx の setStatus を渡す)。 */
  setStatus: (msg: string) => void;
}

export interface UseProjectLoaderResult {
  projectRoot: string;
  loadProject: (
    root: string,
    options?: { addToRecent?: boolean }
  ) => Promise<boolean>;
  refreshGit: () => Promise<void>;
  gitStatus: GitStatus | null;
  gitLoading: boolean;
}

export function useProjectLoader(
  opts: UseProjectLoaderOptions
): UseProjectLoaderResult {
  const settingsLoading = useSettingsLoading();
  const { update: updateSettings } = useSettingsActions();
  const claudeCwd = useSettingsValue('claudeCwd');
  const lastOpenedRoot = useSettingsValue('lastOpenedRoot');
  const recentProjects = useSettingsValue('recentProjects');
  const hasCompletedOnboarding = useSettingsValue('hasCompletedOnboarding');
  const mcpAutoSetup = useSettingsValue('mcpAutoSetup');
  const t = useT();

  const [projectRoot, setProjectRoot] = useState<string>('');
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);
  const [gitLoading, setGitLoading] = useState<boolean>(true);

  // opts は ref に詰めて useCallback の deps から外す (use-pty-session.ts と同じ流儀)。
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const loadProject = useCallback(
    async (
      root: string,
      options: { addToRecent?: boolean } = { addToRecent: true }
    ): Promise<boolean> => {
      if (projectRoot && projectRoot !== root && !optsRef.current.confirmDiscardEditorTabs()) {
        return false;
      }
      setProjectRoot(root);
      optsRef.current.setStatus('プロジェクト読み込み中…');
      setGitLoading(true);

      try {
        const [gs, sess] = await Promise.all([
          window.api.git.status(root),
          window.api.sessions.list(root)
        ]);
        // MCP 初期化は await する（新規タブ spawn より前に claude.json を確定）
        // settings.mcpAutoSetup === false の場合は MCP 自動書換を全てスキップする
        if (mcpAutoSetup !== false) {
          try {
            await window.api.app.setupTeamMcp(root, '_init', '', []);
          } catch (err) {
            console.warn('[loadProject] setupTeamMcp failed:', err);
          }
        }

        setGitStatus(gs);
        optsRef.current.onLoaded({ gitStatus: gs, sessions: sess });
        // タブ・セッション・チーム・ターミナル等の reset は親に外注。
        optsRef.current.onProjectSwitched(root);
        optsRef.current.setStatus(`${root.split(/[\\/]/).pop()}`);
        // ここでは runtime の「最後に開いたルート」のみ永続化する。
        // `claudeCwd` は SettingsModal で設定されるユーザー設定のため上書き厳禁。
        if (options.addToRecent !== false) {
          const rp = recentProjects ?? [];
          // Issue #67: path を raw 比較すると表記揺れで重複エントリが増える。
          // normalize 後キーで dedup。
          const next = dedupPrepend(rp, root, 10);
          void updateSettings({ recentProjects: next, lastOpenedRoot: root });
        } else {
          void updateSettings({ lastOpenedRoot: root });
        }
        return true;
      } catch (err) {
        optsRef.current.setStatus(`読み込みエラー: ${String(err)}`);
        return false;
      } finally {
        setGitLoading(false);
      }
    },
    [projectRoot, mcpAutoSetup, recentProjects, updateSettings]
  );

  // 初回ロード — lastOpenedRoot (前回開いたルート) があれば復元、なければフォルダ選択ダイアログ。
  // 以前は process.cwd() に fallback していたが、インストール版だと vibe-editor 自身の
  // インストールディレクトリが選ばれてしまう。明示的にユーザーに選んでもらう。
  // Onboarding 未完了時は Onboarding 側でルートを選ばせるため、ここでは何もしない。
  const didInitRef = useRef(false);
  useEffect(() => {
    if (settingsLoading) return;
    if (didInitRef.current) return;
    if (!hasCompletedOnboarding) return;
    didInitRef.current = true;
    let cancelled = false;
    (async () => {
      try {
        // 既存ユーザーの移行: lastOpenedRoot が空で claudeCwd が設定されている場合は
        // かつての挙動 (claudeCwd = 最後に開いたルート) を尊重して再利用する。
        const remembered = lastOpenedRoot || claudeCwd;
        let root = remembered;
        if (!root) {
          const picked = await window.api.dialog.openFolder(t('appMenu.openFolderDialogTitle'));
          if (cancelled) return;
          if (!picked) {
            // ユーザーがキャンセルした場合は projectRoot 未設定のまま空状態を維持。
            // 上部の AppMenu / コマンドパレットから後で開けるようにしておく。
            optsRef.current.setStatus(t('status.noProject'));
            setGitLoading(false);
            return;
          }
          root = picked;
        }
        if (cancelled) return;
        setProjectRoot(root);
        if (root !== lastOpenedRoot) {
          void updateSettings({ lastOpenedRoot: root });
        }
        const [gs, sess] = await Promise.all([
          window.api.git.status(root),
          window.api.sessions.list(root)
        ]);
        // MCP 初期化は await する（新規タブ spawn より前に claude.json を確定）
        if (mcpAutoSetup !== false) {
          try {
            await window.api.app.setupTeamMcp(root, '_init', '', []);
          } catch (err) {
            console.warn('[init] setupTeamMcp failed:', err);
          }
        }
        if (cancelled) return;
        setGitStatus(gs);
        setGitLoading(false);
        optsRef.current.onLoaded({ gitStatus: gs, sessions: sess });
        optsRef.current.setStatus(root.split(/[\\/]/).pop() ?? root);
      } catch (err) {
        optsRef.current.setStatus(`初期化エラー: ${String(err)}`);
        setGitLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsLoading, hasCompletedOnboarding]);

  // タイトルバー
  useEffect(() => {
    const name = projectRoot.split(/[\\/]/).pop() || 'vibe-editor';
    window.api.app.setWindowTitle(`vibe-editor — ${name}`).catch(() => undefined);
  }, [projectRoot]);

  const refreshGit = useCallback(async () => {
    if (!projectRoot) return;
    setGitLoading(true);
    try {
      const gs = await window.api.git.status(projectRoot);
      setGitStatus(gs);
    } finally {
      setGitLoading(false);
    }
  }, [projectRoot]);

  return {
    projectRoot,
    loadProject,
    refreshGit,
    gitStatus,
    gitLoading
  };
}
