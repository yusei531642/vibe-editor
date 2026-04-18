/**
 * Tauri updater 起動時チェック。
 *
 * - prod ビルドのみ動作 (dev では skip)
 * - 新版があれば OS ネイティブ ask ダイアログ → ダウンロード → 再起動
 * - 失敗は console.debug に流すだけ (鍵未設定/オフライン等で落ちないように)
 */
import type { Language } from '../../../types/shared';

let didCheck = false;

const MESSAGES: Record<Language, (version: string) => { title: string; confirmLabel: string; cancelLabel: string; message: (body: string) => string }> = {
  ja: (version) => ({
    title: 'アップデートがあります',
    confirmLabel: '更新する',
    cancelLabel: 'あとで',
    message: (body) => `vibe-editor v${version} が利用可能です。今すぐ更新しますか?${body}`
  }),
  en: (version) => ({
    title: 'Update available',
    confirmLabel: 'Install',
    cancelLabel: 'Later',
    message: (body) => `vibe-editor v${version} is available. Install now?${body}`
  })
};

/** Issue #59: window.confirm を Tauri ネイティブの ask() に置き換える + i18n 化する。 */
export async function checkForUpdatesOnce(language: Language = 'ja'): Promise<void> {
  if (didCheck) return;
  didCheck = true;
  if (!import.meta.env.PROD) return;

  try {
    const { check } = await import('@tauri-apps/plugin-updater');
    const update = await check();
    if (!update) return;

    const body = update.body ? `\n\n${update.body}` : '';
    const strings = (MESSAGES[language] ?? MESSAGES.ja)(update.version);
    const { ask } = await import('@tauri-apps/plugin-dialog');
    const ok = await ask(strings.message(body), {
      title: strings.title,
      kind: 'info',
      okLabel: strings.confirmLabel,
      cancelLabel: strings.cancelLabel
    });
    if (!ok) return;

    await update.downloadAndInstall();
    const { relaunch } = await import('@tauri-apps/plugin-process');
    await relaunch();
  } catch (err) {
    console.debug('[updater] check skipped:', err);
  }
}
