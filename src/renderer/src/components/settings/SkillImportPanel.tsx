import { useCallback, useEffect, useState } from 'react';
import type { ApiAgentImportableSkill } from '../../../../types/shared';
import { useT } from '../../lib/i18n';

interface Props {
  /** import / remove 後に親の skill selector を再読み込みさせる。 */
  onChanged: () => void;
}

/**
 * Claude / Codex の skill を vibe-editor 専用フォルダへ import (コピー) するパネル (Issue #1017)。
 * `~/.claude/skills` `<project>/.claude/skills` `~/.agents/skills` `<project>/.agents/skills`
 * を走査し、選択して import する。import 済みは削除もできる。
 */
export function SkillImportPanel({ onChanged }: Props): JSX.Element {
  const t = useT();
  const [sources, setSources] = useState<ApiAgentImportableSkill[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async (): Promise<void> => {
    try {
      setSources(await window.api.apiAgents.listSkillSources());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (
    key: string,
    op: () => Promise<unknown>
  ): Promise<void> => {
    setBusy(key);
    setError('');
    try {
      await op();
      await load();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <details className="skill-import">
      <summary>{t('settings.customAgents.skillImport.title')}</summary>
      <p className="modal__note">{t('settings.customAgents.skillImport.note')}</p>
      {error && <p className="modal__error">{error}</p>}
      {sources.length === 0 ? (
        <p className="modal__note">{t('settings.customAgents.skillImport.empty')}</p>
      ) : (
        <ul className="skill-import__list">
          {sources.map((s) => {
            const key = `${s.source}:${s.id}`;
            return (
              <li key={key} className="skill-import__item">
                <div className="skill-import__meta">
                  <span className="skill-import__name">{s.name}</span>
                  <span className="skill-import__badge">
                    {s.source} / {s.scope}
                  </span>
                  {s.description && (
                    <span className="skill-import__desc" title={s.description}>
                      {s.description}
                    </span>
                  )}
                </div>
                {s.imported ? (
                  <button
                    type="button"
                    className="toolbar__btn"
                    disabled={busy !== null}
                    onClick={() => run(key, () => window.api.apiAgents.removeSkill(s.id))}
                  >
                    {busy === key ? '…' : t('settings.customAgents.skillImport.remove')}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="toolbar__btn"
                    disabled={busy !== null}
                    onClick={() => run(key, () => window.api.apiAgents.importSkill(s.source, s.id))}
                  >
                    {busy === key ? '…' : t('settings.customAgents.skillImport.import')}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </details>
  );
}
