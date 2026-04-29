/**
 * LogsSection — Issue #326
 *
 * 設定モーダル内に「ログ」セクションを追加し、`~/.vibe-editor/logs/vibe-editor.log`
 * の末尾を GUI 上で閲覧できるようにする。
 *
 * 機能 (MVP):
 *   - リフレッシュボタンで末尾 256KB を再取得
 *   - レベルフィルタ (ALL / ERROR / WARN / INFO)
 *   - ログフォルダを OS ファイルマネージャで開く
 *   - ログパスの表示
 *
 * 自動 tail / 全文検索 / 行番号表示は Phase 2 に分離する。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { FolderOpen, RefreshCw } from 'lucide-react';
import type { ReadLogTailResponse } from '../../../../types/shared';
import { useT } from '../../lib/i18n';

type LevelFilter = 'all' | 'error' | 'warn' | 'info';

const LEVEL_REGEX: Record<Exclude<LevelFilter, 'all'>, RegExp> = {
  // tracing-subscriber fmt の標準フォーマットは `2026-04-29T12:34:56.789Z  ERROR ...`
  // のように LEVEL が大文字で出るので大文字 / 大小無視の両対応で抽出する。
  error: /\bERROR\b/i,
  warn: /\bWARN\b/i,
  info: /\bINFO\b/i
};

function filterLines(content: string, filter: LevelFilter): string {
  if (filter === 'all') return content;
  const re = LEVEL_REGEX[filter];
  return content
    .split(/\r?\n/)
    .filter((line) => re.test(line))
    .join('\n');
}

export function LogsSection(): JSX.Element {
  const t = useT();
  const [resp, setResp] = useState<ReadLogTailResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<LevelFilter>('all');

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await window.api.logs.readTail();
      setResp(r);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleOpenDir = useCallback(async () => {
    try {
      await window.api.logs.openDir();
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const filtered = useMemo(
    () => (resp ? filterLines(resp.content, filter) : ''),
    [resp, filter]
  );

  return (
    <section className="modal__section logs-section">
      <h3>{t('settings.logs.title')}</h3>
      <p className="modal__note">{t('settings.logs.desc')}</p>

      <div className="logs-section__toolbar">
        <button
          type="button"
          className="toolbar__btn"
          onClick={() => void refresh()}
          disabled={loading}
        >
          <RefreshCw size={13} strokeWidth={2} />
          {t('settings.logs.refresh')}
        </button>
        <button type="button" className="toolbar__btn" onClick={() => void handleOpenDir()}>
          <FolderOpen size={13} strokeWidth={2} />
          {t('settings.logs.openDir')}
        </button>
        <label className="logs-section__filter">
          <span>{t('settings.logs.levelFilter')}</span>
          <select value={filter} onChange={(e) => setFilter(e.target.value as LevelFilter)}>
            <option value="all">{t('settings.logs.level.all')}</option>
            <option value="error">ERROR</option>
            <option value="warn">WARN</option>
            <option value="info">INFO</option>
          </select>
        </label>
      </div>

      {resp && (
        <div className="logs-section__path" title={resp.path}>
          {resp.path}
          {resp.truncated && ` — ${t('settings.logs.truncated')}`}
        </div>
      )}

      {error && (
        <div className="modal__note logs-section__error">{error}</div>
      )}

      <pre className="logs-section__view">
        {loading
          ? t('settings.logs.loading')
          : !resp || resp.empty
            ? t('settings.logs.empty')
            : filtered.length === 0
              ? t('settings.logs.noMatch')
              : filtered}
      </pre>
    </section>
  );
}
