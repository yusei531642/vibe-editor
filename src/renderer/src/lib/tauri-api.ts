/**
 * tauri-api.ts — renderer 向け IPC 互換層
 *
 * 役割:
 * - `import { api } from './tauri-api'` で namespaced な API を提供
 * - 内部では `@tauri-apps/api/core` の `invoke()` と `listen()` を呼ぶ
 * - `window.api` にも同じインスタンスを割り当てている (旧コードパスとの互換のため)
 *
 * Phase 5 (Issue #373): 各領域の実装を `./tauri-api/<area>.ts` に分割し、本ファイルは
 * thin facade として 11 領域を集約 + `ping` + `isTauri` + 自動 bootstrap だけを担う。
 * 外部 API (`api` / `Api` / `isTauri` / `RoleProfileSummary`) は 1 文字も変えない。
 */

import { invoke } from '@tauri-apps/api/core';

import { app } from './tauri-api/app';
import { dialog } from './tauri-api/dialog';
import { files } from './tauri-api/files';
import { git } from './tauri-api/git';
import { handoffs } from './tauri-api/handoffs';
import { logs } from './tauri-api/logs';
import { roleProfiles } from './tauri-api/role-profiles';
import { sessions } from './tauri-api/sessions';
import { settings } from './tauri-api/settings';
import { team } from './tauri-api/team';
import { teamHistory } from './tauri-api/team-history';
import { terminal } from './tauri-api/terminal';

// 既存 import { RoleProfileSummary } from '../lib/tauri-api' との互換維持。
// Tauri 側 TeamHub に同期する role profile の要約形。
export type { RoleProfileSummary } from './tauri-api/app';

// Issue #294: `subscribeEvent` / `subscribeEventReady` は `./subscribe-event.ts` に
// 切り出し、`subscribeEvent` は `subscribeEventReady` の sync ラッパとして再実装。
// terminal.* event ハンドラ (onData / onExit / ...) からのみ参照される。

export const api = {
  ping: (): Promise<string> => invoke('ping'),

  app,
  git,
  files,
  sessions,
  team,
  teamHistory,
  handoffs,
  dialog,
  settings,
  roleProfiles,
  logs,
  terminal
};

export type Api = typeof api;

/**
 * Tauri 環境かどうかを判定。renderer 側で Electron / Tauri の自動切り替え用。
 */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

// ---------- 自動 bootstrap ----------
// 環境を問わず window.api が未注入なら Tauri 版シムを設定する。
// 動作保証:
//   - Electron: preload が module 評価前に window.api を注入 → if 文を skip
//   - Tauri:    preload なし → ここで window.api = api を設定
//   - 通常ブラウザ (vite dev 直接アクセス): window.api が存在しないので shim 設定。
//     Tauri 内部 invoke 呼び出しは失敗するが、最低限 React の mount は通る。
if (typeof window !== 'undefined') {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any;
  if (!w.api) {
    w.api = api;
    console.info(
      '[tauri-api] window.api を Tauri shim にバインド (isTauri=' + isTauri() + ')'
    );
  }
}
