import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { SettingsProvider } from './lib/settings-context';
import { ToastProvider } from './lib/toast-context';
import './index.css';

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
