// Tauri 環境では window.api をシム実装にバインド (Electron preload の代替)
import './lib/tauri-api';

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
// Issue #346: Nerd Font 同梱 (Powerline / Devicons / Material Icons の glyph を保証)
import './styles/fonts.css';
import React, { useEffect } from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { CanvasLayout } from './layouts/CanvasLayout';
import { AppErrorBoundary } from './components/AppErrorBoundary';
import { SettingsProvider } from './lib/settings-context';
import { ToastProvider } from './lib/toast-context';
import { RoleProfilesProvider } from './lib/role-profiles-context';
import { FileTreeStateProvider } from './lib/filetree-state-context';
import { useUiStore } from './stores/ui';
import { webviewZoom } from './lib/webview-zoom';
import { resolveBootstrapLanguage, translate } from './lib/i18n';
import './index.css';
import './styles/components/palette.css';
import './styles/components/modal.css';
import './styles/components/welcome.css';
import './styles/components/onboarding.css';
import './styles/components/agent-wizard.css';
import './styles/components/menu.css';
import './styles/components/toast.css';
import './styles/components/claude-not-found.css';
import './styles/components/canvas.css';
import './styles/components/canvas-agent-card.css';
import './styles/components/team-dashboard.css';
import './styles/components/claude-patterns.css';
import './styles/components/shell.css';
import './styles/components/glass.css';
import './styles/components/drag-region.css';
import './styles/components/image-preview.css';
import './styles/components/voice.css';

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error(translate(resolveBootstrapLanguage(), 'bootstrap.rootMissing'));
}

// WebView2 / Chromium のデフォルトコンテキストメニュー (戻る・最新の情報に更新・開発者ツール…) を抑止。
// 個別コンポーネント (ChangesPanel, Monaco など) の onContextMenu は通常通り動作する。
window.addEventListener('contextmenu', (e) => {
  e.preventDefault();
});

function Root(): JSX.Element {
  const viewMode = useUiStore((s) => s.viewMode);
  const setViewMode = useUiStore((s) => s.setViewMode);

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

  // bug_027 対策: <App/> を unmount すると全 PTY が kill され、未保存エディタも失われる。
  // そこで <App/> は常時マウントし、Canvas モードではその上に CanvasLayout を
  // position:fixed でオーバーレイするだけに留める。これにより切替で
  // terminalTabs / editorTabs / teams がすべて保持される。
  //
  // 同様の理由で <CanvasLayout/> も常時マウントし、IDE モードでは display:none で
  // 隠す (CanvasLayout 自身が viewMode を読んでルート div を toggle する)。
  // これで Canvas 上の AgentNodeCard も unmount されず、PTY が kill されない。
  return (
    <>
      <App />
      <CanvasLayout />
    </>
  );
}

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <SettingsProvider>
        <ToastProvider>
          <RoleProfilesProvider>
            <FileTreeStateProvider>
              <Root />
            </FileTreeStateProvider>
          </RoleProfilesProvider>
        </ToastProvider>
      </SettingsProvider>
    </AppErrorBoundary>
  </React.StrictMode>
);
