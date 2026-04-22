import { useEffect, useState } from 'react';
import type { GitStatus } from '../../../../types/shared';
import { useT } from '../../lib/i18n';
import { useSettings } from '../../lib/settings-context';
import { useUiStore } from '../../stores/ui';

interface StatusBarProps {
  gitStatus: GitStatus | null;
  activeFilePath: string | null;
  terminalCount: number;
}

/**
 * Redesign shell の下端バー (26px, font-mono)。
 * デザインバンドルの .status セクションに準拠し、git branch / 変更数 /
 * アクティブファイル / 起動中ターミナル数 / 言語 / テーマ / クロック を
 * 左→右の順で並べる。情報が無い要素は非表示。
 */
export function StatusBar({
  gitStatus,
  activeFilePath,
  terminalCount
}: StatusBarProps): JSX.Element {
  const t = useT();
  const { settings } = useSettings();
  const viewMode = useUiStore((s) => s.viewMode);
  const [clock, setClock] = useState<string>(() => formatClock(new Date()));

  useEffect(() => {
    const id = window.setInterval(() => setClock(formatClock(new Date())), 15000);
    return () => window.clearInterval(id);
  }, []);

  const branch = gitStatus?.ok ? gitStatus.branch : null;
  const changes = gitStatus?.ok ? gitStatus.files.length : 0;
  const activeFileLabel = activeFilePath
    ? activeFilePath.split(/[\\/]/).filter(Boolean).slice(-2).join('/')
    : null;

  return (
    <div className="status" role="contentinfo">
      <span className="status__item">
        <span className="status__dot" aria-hidden="true" />
        <span>{viewMode === 'canvas' ? 'canvas' : 'ide'}</span>
      </span>
      {branch ? (
        <span className="status__item" title={branch}>
          <span className="status__label">{t('status.branch')}</span>
          <span>{branch}</span>
        </span>
      ) : null}
      {changes > 0 ? (
        <span className="status__item">
          <span>{changes}</span>
          <span className="status__label">{t('status.changes')}</span>
        </span>
      ) : null}
      {activeFileLabel ? (
        <span className="status__item status__item--truncate" title={activeFilePath ?? ''}>
          {activeFileLabel}
        </span>
      ) : null}
      <span className="status__spacer" />
      {terminalCount > 0 ? (
        <span className="status__item">
          <span>{terminalCount}</span>
          <span className="status__label">pty</span>
        </span>
      ) : null}
      <span className="status__item">
        <span className="status__label">{t('status.lang')}</span>
        <span>{settings.language === 'ja' ? 'ja' : 'en'}</span>
      </span>
      <span className="status__item">
        <span className="status__label">{t('status.theme')}</span>
        <span>{settings.theme ?? 'claude-dark'}</span>
      </span>
      <span className="status__item">{clock}</span>
    </div>
  );
}

function formatClock(d: Date): string {
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}
