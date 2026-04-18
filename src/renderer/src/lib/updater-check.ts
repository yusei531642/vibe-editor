/**
 * Tauri updater 起動時チェック。
 *
 * - prod ビルドのみ動作 (dev では skip)
 * - 新版があれば confirm ダイアログ → ダウンロード → 再起動
 * - 失敗は console.debug に流すだけ (鍵未設定/オフライン等で落ちないように)
 *
 * Issue #59: UI 言語に合わせてダイアログ文言を切り替える。
 * (Tauri native dialog への差し替えは #68 の扱いなのでここでは window.confirm のまま。)
 */
import type { Language } from '../../../types/shared';
import { translate } from './i18n';

let didCheck = false;

export async function checkForUpdatesOnce(language: Language = 'en'): Promise<void> {
  if (didCheck) return;
  didCheck = true;
  if (!import.meta.env.PROD) return;

  try {
    const { check } = await import('@tauri-apps/plugin-updater');
    const update = await check();
    if (!update) return;

    const body = update.body ? `\n\n${update.body}` : '';
    const ok = window.confirm(
      translate(language, 'updater.confirm', { version: update.version }) + body
    );
    if (!ok) return;

    await update.downloadAndInstall();
    const { relaunch } = await import('@tauri-apps/plugin-process');
    await relaunch();
  } catch (err) {
    console.debug('[updater] check skipped:', err);
  }
}
