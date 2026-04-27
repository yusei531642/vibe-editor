import { useEffect, useState } from 'react';
import type { AppSettings } from '../../../../types/shared';
import type { AppLogInfo } from '../../lib/tauri-api';

interface Props {
  language: AppSettings['language'];
}

export function LogsSection({ language }: Props): JSX.Element {
  const isJa = language === 'ja';
  const [info, setInfo] = useState<AppLogInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void window.api.app
      .getLogInfo()
      .then((next) => {
        if (!cancelled) setInfo(next);
      })
      .catch((err) => {
        if (!cancelled) setError(String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const refresh = (): void => {
    setReloadKey((key) => key + 1);
  };

  const clearLog = async (): Promise<void> => {
    setClearing(true);
    setError(null);
    try {
      const result = await window.api.app.clearLog();
      if (!result.ok) throw new Error(result.error ?? 'failed to clear log');
      refresh();
    } catch (err) {
      setError(String(err));
    } finally {
      setClearing(false);
    }
  };

  const copyPath = async (): Promise<void> => {
    if (!info?.path) return;
    try {
      await navigator.clipboard.writeText(info.path);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch (err) {
      setError(String(err));
    }
  };

  const logText =
    info?.content ||
    (isJa
      ? 'まだログはありません。アプリを起動・操作するとここに記録されます。'
      : 'No log entries yet. Launch and app events will appear here.');

  return (
    <section className="modal__section app-log-section">
      <h3>{isJa ? 'アプリログ' : 'Application log'}</h3>
      <p className="modal__note">
        {isJa
          ? '起動エラー、Claude/Codex の起動まわり、画面側の未処理エラーを保存します。バグった時は、この画面の内容を見れば原因を追いやすくなります。'
          : 'Stores startup errors, Claude/Codex launch events, and renderer errors so problems are easier to diagnose.'}
      </p>

      <div className="app-log-actions">
        <button type="button" className="toolbar__btn" onClick={refresh} disabled={loading}>
          {loading ? (isJa ? '読み込み中…' : 'Loading…') : isJa ? '更新' : 'Refresh'}
        </button>
        <button
          type="button"
          className="toolbar__btn toolbar__btn--danger"
          onClick={() => {
            void clearLog();
          }}
          disabled={clearing}
        >
          {clearing ? (isJa ? 'クリア中…' : 'Clearing…') : isJa ? 'ログをクリア' : 'Clear log'}
        </button>
        <button
          type="button"
          className="toolbar__btn"
          onClick={() => {
            void copyPath();
          }}
          disabled={!info?.path}
        >
          {copied ? (isJa ? 'コピーしました' : 'Copied') : isJa ? '保存先をコピー' : 'Copy path'}
        </button>
      </div>

      <div className="app-log-path">
        <span>{isJa ? '保存先' : 'Path'}</span>
        <code>{info?.path ?? '...'}</code>
      </div>

      {error && <p className="app-log-error">{error}</p>}
      {info?.truncated && (
        <p className="modal__note">
          {isJa
            ? `ログが長いため、末尾 ${Math.round(info.maxBytes / 1024)}KB だけ表示しています。`
            : `The log is long, so only the latest ${Math.round(info.maxBytes / 1024)}KB is shown.`}
        </p>
      )}

      <pre className="app-log-viewer" aria-live="polite">
        {logText}
      </pre>
    </section>
  );
}
