// Tauri 環境では window.api をシム実装にバインド (Electron preload の代替)
import './lib/tauri-api';

import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/source-serif-4/400.css';
import '@fontsource/source-serif-4/600.css';
import React, { useEffect } from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { CanvasLayout } from './layouts/CanvasLayout';
import { useT } from './lib/i18n';
import { SettingsProvider } from './lib/settings-context';
import { ToastProvider } from './lib/toast-context';
import { useUiStore } from './stores/ui';
import './index.css';
import './styles/components/palette.css';
import './styles/components/modal.css';
import './styles/components/welcome.css';
import './styles/components/menu.css';
import './styles/components/toast.css';
import './styles/components/claude-not-found.css';
import './styles/components/canvas.css';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root が見つかりません');

// WebView2 / Chromium のデフォルトコンテキストメニュー (戻る・最新の情報に更新・開発者ツール…) を抑止。
// 個別コンポーネント (ChangesPanel, Monaco など) の onContextMenu は通常通り動作する。
window.addEventListener('contextmenu', (e) => {
  e.preventDefault();
});

function Root(): JSX.Element {
  const viewMode = useUiStore((s) => s.viewMode);
  const setViewMode = useUiStore((s) => s.setViewMode);
  const t = useT();

  // Phase 4: グローバルキーバインド (両モード共通)
  //   Ctrl+Shift+M / Cmd+Shift+M → Canvas / IDE モード切替
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.shiftKey && e.key.toLowerCase() === 'm') {
        e.preventDefault();
        setViewMode(useUiStore.getState().viewMode === 'canvas' ? 'ide' : 'canvas');
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [setViewMode]);

  // bug_027 対策: <App/> を unmount すると全 PTY が kill され、未保存エディタも失われる。
  // そこで <App/> は常時マウントし、Canvas モードではその上に CanvasLayout を
  // position:fixed でオーバーレイするだけに留める。これにより切替で
  // terminalTabs / editorTabs / teams がすべて保持される。
  const floatingLabel = t('canvas.modeToggleShortcut');
  return (
    <>
      <App />
      {viewMode === 'canvas' && <CanvasLayout />}
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

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <SettingsProvider>
      <ToastProvider>
        <Root />
      </ToastProvider>
    </SettingsProvider>
  </React.StrictMode>
);
