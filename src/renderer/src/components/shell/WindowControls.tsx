/**
 * Issue #260 PR-2: カスタムタイトルバー用のウィンドウ制御ボタン
 * (最小化 / 最大化・復元 / 閉じる)。
 *
 * `decorations: false` でネイティブ chrome を外した代わりに、Tauri 2 の
 * `getCurrentWindow()` API を呼んでウィンドウ操作を行う。`-webkit-app-region: drag`
 * のドラッグ可能領域に置かれるので、ボタン側は `no-drag` を CSS で当てる。
 */
import { useEffect, useState } from 'react';
import { Minus, Square, Copy, X } from 'lucide-react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useT } from '../../lib/i18n';

export function WindowControls(): JSX.Element {
  const t = useT();
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    const win = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void (async () => {
      try {
        const initial = await win.isMaximized();
        if (!disposed) setIsMaximized(initial);
        // Tauri 2: onResized は最大化/復元/手動 resize 全てで発火する。
        unlisten = await win.onResized(async () => {
          try {
            const next = await win.isMaximized();
            if (!disposed) setIsMaximized(next);
          } catch {
            /* swallow */
          }
        });
      } catch (err) {
        // dev-mode で window API が解決できない等の場合は静かに諦める
        // (titlebar UI は無効化されるが致命的ではない)
        console.warn('[window-controls] init failed:', err);
      }
    })();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const handleMinimize = (): void => {
    void getCurrentWindow().minimize();
  };
  const handleToggleMaximize = (): void => {
    void getCurrentWindow().toggleMaximize();
  };
  const handleClose = (): void => {
    void getCurrentWindow().close();
  };

  return (
    <div className="window-controls" role="group" aria-label="Window controls">
      <button
        type="button"
        className="window-controls__btn window-controls__btn--minimize"
        onClick={handleMinimize}
        title={t('windowControls.minimize')}
        aria-label={t('windowControls.minimize')}
      >
        <Minus size={12} strokeWidth={2} />
      </button>
      <button
        type="button"
        className="window-controls__btn window-controls__btn--maximize"
        onClick={handleToggleMaximize}
        title={
          isMaximized ? t('windowControls.restore') : t('windowControls.maximize')
        }
        aria-label={
          isMaximized ? t('windowControls.restore') : t('windowControls.maximize')
        }
      >
        {isMaximized ? (
          <Copy size={11} strokeWidth={2} />
        ) : (
          <Square size={11} strokeWidth={2} />
        )}
      </button>
      <button
        type="button"
        className="window-controls__btn window-controls__btn--close"
        onClick={handleClose}
        title={t('windowControls.close')}
        aria-label={t('windowControls.close')}
      >
        <X size={13} strokeWidth={2} />
      </button>
    </div>
  );
}
