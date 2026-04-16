import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/source-serif-4/400.css';
import '@fontsource/source-serif-4/600.css';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { SettingsProvider } from './lib/settings-context';
import { ToastProvider } from './lib/toast-context';
import './index.css';
import './styles/components/palette.css';
import './styles/components/modal.css';
import './styles/components/welcome.css';
import './styles/components/menu.css';
import './styles/components/toast.css';
import './styles/components/claude-not-found.css';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root が見つかりません');

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <SettingsProvider>
      <ToastProvider>
        <App />
      </ToastProvider>
    </SettingsProvider>
  </React.StrictMode>
);
