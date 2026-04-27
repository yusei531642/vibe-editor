import type { AppSettings } from '../../../../types/shared';
import type { UpdateSetting } from './types';

interface Props {
  draft: AppSettings;
  update: UpdateSetting;
}

/**
 * × ボタンの挙動を切り替えるセクション。
 *   - tray: ウィンドウを隠し、Team の PTY をバックグラウンドで走らせ続ける
 *   - quit: 旧挙動 (PTY 全 kill + プロセス終了)
 * 設定値は Rust 側 lib.rs の CloseRequested ハンドラが settings.json から sync 読みする。
 */
export function CloseBehaviorSection({ draft, update }: Props): JSX.Element {
  const isJa = draft.language === 'ja';
  const value = draft.closeBehavior ?? 'tray';
  return (
    <section className="modal__section">
      <h3>{isJa ? '終了動作' : 'Close behavior'}</h3>
      <p
        style={{
          marginTop: 0,
          marginBottom: 12,
          color: 'var(--text-muted)',
          fontSize: '0.9em',
          lineHeight: 1.5
        }}
      >
        {isJa
          ? 'ウィンドウの × を押したときの動作。バックグラウンド常駐にすると Team が消えず、トレイから復帰できます。'
          : 'What happens when you click the window close button. Background mode keeps your Team running and lets you restore from the tray.'}
      </p>
      <div className="density-grid">
        <label
          className={`density-card ${value === 'tray' ? 'is-selected' : ''}`}
        >
          <input
            type="radio"
            name="closeBehavior"
            value="tray"
            checked={value === 'tray'}
            onChange={() => update('closeBehavior', 'tray')}
          />
          <strong>{isJa ? 'バックグラウンドで動かす (推奨)' : 'Run in background (recommended)'}</strong>
          <span>
            {isJa
              ? 'ウィンドウを隠すだけ。Claude / Codex のセッションは生存。'
              : 'Hide the window only. Claude / Codex sessions stay alive.'}
          </span>
        </label>
        <label
          className={`density-card ${value === 'quit' ? 'is-selected' : ''}`}
        >
          <input
            type="radio"
            name="closeBehavior"
            value="quit"
            checked={value === 'quit'}
            onChange={() => update('closeBehavior', 'quit')}
          />
          <strong>{isJa ? '完全に終了する' : 'Quit completely'}</strong>
          <span>
            {isJa
              ? 'PTY を全部 kill してプロセス終了。次回起動時は --resume で復元。'
              : 'Kill all PTYs and exit. Next launch restores via --resume.'}
          </span>
        </label>
      </div>
      <div style={{ marginTop: 12 }}>
        <button
          type="button"
          className="toolbar__btn"
          onClick={() => {
            void window.api.app.quit();
          }}
        >
          {isJa ? '今すぐ完全終了' : 'Quit now'}
        </button>
      </div>
    </section>
  );
}
