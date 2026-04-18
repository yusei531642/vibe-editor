/// <reference types="vite/client" />
import type { Api } from './lib/tauri-api';

declare global {
  interface Window {
    api: Api;
  }
}

export {};
