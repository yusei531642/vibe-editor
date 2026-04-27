// Tauri 環境では window.api をシム実装にバインド (Electron preload の代替)
import { api, isTauri } from './lib/tauri-api';

// ---------- Bundled Fonts (variable, full weight range) ----------
//
// アプリ全体で「こだわった」タイポグラフィを実現するため、以下を webfont として同梱:
//   - Inter Variable             → UI / 本文 (sans)。opsz 軸で大見出しは display 形に自動切替
//   - Geist Variable             → ブランド見出し (heading)。Vercel 由来の幾何学的 sans
//   - Source Serif 4 Variable    → Claude エージェント応答 (serif)。Tiempos に近い書体感
//   - JetBrains Mono Variable    → ターミナル / Monaco エディタ (mono)。ligatures あり
//   - Geist Mono Variable        → mono の代替 (UI 内コード片に使い分け可)
//
// 全て variable font なので 1 ファイルで全 weight (100〜900) が来る。OS にフォントが
// 入っていなくても即座に意図したルックで表示される。
import '@fontsource-variable/inter';
import '@fontsource-variable/geist';
import '@fontsource-variable/source-serif-4';
import '@fontsource-variable/jetbrains-mono';
import '@fontsource-variable/geist-mono';
import React, { Component, Suspense, useEffect, useState, type ErrorInfo, type ReactNode } from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { useT } from './lib/i18n';
import { SettingsProvider } from './lib/settings-context';
import { ToastProvider } from './lib/toast-context';
import { RoleProfilesProvider } from './lib/role-profiles-context';
import { useUiStore } from './stores/ui';
import { webviewZoom } from './lib/webview-zoom';
import './index.css';
import './styles/components/palette.css';
import './styles/components/modal.css';
import './styles/components/welcome.css';
import './styles/components/onboarding.css';
import './styles/components/menu.css';
import './styles/components/toast.css';
import './styles/components/claude-not-found.css';
import './styles/components/canvas.css';
import './styles/components/claude-patterns.css';
import './styles/components/shell.css';
import './styles/components/tweaks.css';

const LazyCanvasLayout = React.lazy(() =>
  import('./layouts/CanvasLayout').then((mod) => ({ default: mod.CanvasLayout }))
);

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root が見つかりません');

function formatLogArg(value: unknown): string {
  if (value instanceof Error) {
    return value.stack || `${value.name}: ${value.message}`;
  }
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function sendRendererLog(level: 'error' | 'warn' | 'info' | 'debug', message: string): void {
  if (!isTauri()) return;
  void api.app.appendRendererLog(level, message).catch(() => undefined);
}

// アプリ版では DevTools を開けない状況でも、画面側の致命的なエラーをログに残す。
if (isTauri()) {
  const originalConsoleError = console.error.bind(console);
  console.error = (...args: unknown[]): void => {
    originalConsoleError(...args);
    sendRendererLog('error', args.map(formatLogArg).join(' '));
  };

  window.addEventListener('error', (event) => {
    const location = event.filename
      ? ` (${event.filename}:${event.lineno}:${event.colno})`
      : '';
    const stack = event.error instanceof Error ? `\n${event.error.stack ?? ''}` : '';
    sendRendererLog('error', `[window.error] ${event.message}${location}${stack}`);
  });

  window.addEventListener('unhandledrejection', (event) => {
    sendRendererLog(
      'error',
      `[unhandledrejection] ${formatLogArg(event.reason)}`
    );
  });
}

// WebView2 / Chromium のデフォルトコンテキストメニュー (戻る・最新の情報に更新・開発者ツール…) を抑止。
// 個別コンポーネント (ChangesPanel, Monaco など) の onContextMenu は通常通り動作する。
window.addEventListener('contextmenu', (e) => {
  e.preventDefault();
});

function Root(): JSX.Element {
  const viewMode = useUiStore((s) => s.viewMode);
  const setViewMode = useUiStore((s) => s.setViewMode);
  const t = useT();
  const [hasMountedCanvas, setHasMountedCanvas] = useState(viewMode === 'canvas');

  // Phase 4: グローバルキーバインド (両モード共通)
  //   Ctrl+Shift+M / Cmd+Shift+M → Canvas / IDE モード切替
  //   Ctrl+= / Ctrl+- / Ctrl+0 → webview ネイティブ zoom (webviewZoom に委譲)
  // Ctrl+wheel は Canvas の React Flow ネイティブ zoom と競合するので奪わない。
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.shiftKey && e.key.toLowerCase() === 'm') {
        e.preventDefault();
        setViewMode(useUiStore.getState().viewMode === 'canvas' ? 'ide' : 'canvas');
        return;
      }
      // zoom in: Ctrl+= / Ctrl++ / Ctrl+;  (US/JIS 両対応)
      if (mod && (e.key === '=' || e.key === '+' || (e.shiftKey && e.key === ';'))) {
        e.preventDefault();
        webviewZoom.in();
        return;
      }
      // zoom out: Ctrl+-
      if (mod && (e.key === '-' || e.key === '_')) {
        e.preventDefault();
        webviewZoom.out();
        return;
      }
      // reset: Ctrl+0
      if (mod && e.key === '0') {
        e.preventDefault();
        webviewZoom.reset();
        return;
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
    };
  }, [setViewMode]);

  // viewMode を html 属性に同期。CSS から canvas/ide の切り替えを検知できるようにする。
  // 特に glass テーマで Canvas の背景が透けるとき、IDE レイヤを visibility:hidden する用途。
  useEffect(() => {
    document.documentElement.dataset.viewMode = viewMode;
  }, [viewMode]);

  // 起動直後の重さ対策:
  // CanvasLayout は保存済み AgentNode を復元すると同時に Claude/Codex PTY を起動する。
  // IDE で起動しただけのときまで裏で Canvas を mount すると、前回の Team が一斉に
  // resume して起動が重くなる。最初に Canvas を開くまでは bundle 読み込みも PTY 起動も遅延し、
  // 一度開いた後は IDE に戻っても mount 維持してセッションを守る。
  useEffect(() => {
    if (viewMode !== 'canvas') return;
    const handle = window.setTimeout(() => {
      setHasMountedCanvas(true);
    }, 120);
    return () => window.clearTimeout(handle);
  }, [viewMode]);

  // bug_027 対策: <App/> を unmount すると全 PTY が kill され、未保存エディタも失われる。
  // そこで <App/> は常時マウントし、Canvas モードではその上に CanvasLayout を
  // position:fixed でオーバーレイするだけに留める。これにより切替で
  // terminalTabs / editorTabs / teams がすべて保持される。
  //
  // 同様の理由で <CanvasLayout/> も常時マウントし、IDE モードでは display:none で
  // 隠す (CanvasLayout 自身が viewMode を読んでルート div を toggle する)。
  // これで Canvas 上の AgentNodeCard も unmount されず、PTY が kill されない。
  const floatingLabel = t('canvas.modeToggleShortcut');
  return (
    <>
      <App />
      {hasMountedCanvas && (
        <Suspense fallback={null}>
          <LazyCanvasLayout />
        </Suspense>
      )}
      {viewMode === 'ide' && (
        <FloatingCanvasToggle
          label={floatingLabel}
          onClick={() => setViewMode('canvas')}
        />
      )}
    </>
  );
}

function FloatingCanvasToggle({
  onClick,
  label
}: {
  onClick: () => void;
  label: string;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="canvas-floating-toggle"
    >
      <span aria-hidden="true" className="canvas-floating-toggle__grid">
        <span />
        <span />
        <span />
        <span />
      </span>
    </button>
  );
}

/**
 * 致命的なレンダリングエラーを捕捉する最上位の error boundary。
 *
 * これがないと、React 内部の DOM 操作 (HMR タイミングの不整合 / removeChild の race
 * 等) が一度起きるたびに app 全体が white-screen で固まってしまう。
 * boundary 経由でフォールバック UI に逃がし、リロードで復帰できるようにする。
 */
class TopLevelErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    sendRendererLog(
      'error',
      `[error-boundary] ${error.name}: ${error.message}\n${error.stack ?? ''}\n${info.componentStack ?? ''}`
    );
  }

  reset = (): void => {
    this.setState({ error: null });
  };

  reload = (): void => {
    window.location.reload();
  };

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div className="vibe-error-fallback" role="alert">
        <div className="vibe-error-fallback__card">
          <h2>vibe-editor で問題が発生しました</h2>
          <pre>{this.state.error.message}</pre>
          <div className="vibe-error-fallback__actions">
            <button type="button" onClick={this.reset}>続ける</button>
            <button type="button" onClick={this.reload} className="vibe-error-fallback__primary">
              再読み込み
            </button>
          </div>
        </div>
      </div>
    );
  }
}

/**
 * HMR 対策: Vite が main.tsx を再評価するたびに `createRoot` が走ると、
 * 同一の DOM ノードに対して 2 回目の root が作られ、React が
 *   - Warning: ReactDOMClient.createRoot() on a container that has already been passed...
 *   - removeChild / insertBefore Failed (NotFoundError)
 * を連発して app が white-screen になる。
 *
 * `globalThis` に root を保持し、HMR 時は新しい React tree を既存 root に
 * `render()` し直すだけにすることで、DOM 不整合を防ぐ。
 */
const rootContainer = globalThis as unknown as { __viveEditorReactRoot?: ReactDOM.Root };
const reactRoot =
  rootContainer.__viveEditorReactRoot ??
  (rootContainer.__viveEditorReactRoot = ReactDOM.createRoot(rootEl));

reactRoot.render(
  <React.StrictMode>
    <TopLevelErrorBoundary>
      <SettingsProvider>
        <ToastProvider>
          <RoleProfilesProvider>
            <Root />
          </RoleProfilesProvider>
        </ToastProvider>
      </SettingsProvider>
    </TopLevelErrorBoundary>
  </React.StrictMode>
);
