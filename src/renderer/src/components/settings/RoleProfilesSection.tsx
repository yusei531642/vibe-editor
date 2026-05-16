/**
 * RoleProfilesSection — vibe-team のロール設定タブ。
 *
 * - built-in 6 種 + ユーザーカスタムを一覧
 * - 各 profile を展開すると label / description / color / glyph / 権限 / system prompt を編集可
 * - built-in は削除不可、編集は overrides として保存される
 * - custom は新規追加 / 削除可
 *
 * Monaco を使うほどの分量ではないので textarea でシンプルに開始 (将来差し替え可能)
 */
import { useState } from 'react';
import { ChevronDown, ChevronRight, Plus, Trash2 } from 'lucide-react';
import type { RoleProfile } from '../../../../types/shared';
import { useT } from '../../lib/i18n';
import { useNativeConfirm } from '../../lib/use-native-confirm';
import { useSettings } from '../../lib/settings-context';
import { useRoleProfiles } from '../../lib/role-profiles-context';
import { BUILTIN_BY_ID } from '../../lib/role-profiles-builtin';

export function RoleProfilesSection(): JSX.Element {
  const t = useT();
  const confirm = useNativeConfirm();
  const { settings } = useSettings();
  const { ordered, file, upsertOverride, addCustom, removeCustom, saveFile } = useRoleProfiles();
  const [expanded, setExpanded] = useState<string | null>(null);

  const onToggle = (id: string): void => {
    setExpanded((prev) => (prev === id ? null : id));
  };

  const onAddCustom = async (): Promise<void> => {
    const id = `custom-${Math.random().toString(36).slice(2, 8)}`;
    const newProfile: RoleProfile = {
      schemaVersion: 1,
      id,
      source: 'user',
      i18n: {
        en: { label: id, description: 'New custom role.' },
        ja: { label: id, description: t('settings.roles.newCustomDesc') }
      },
      visual: { color: '#7a7afd', glyph: id.slice(0, 1).toUpperCase() },
      prompt: {
        template:
          'You are the {selfLabel} of team "{teamName}". Role: {selfDescription} ' +
          '{globalPreamble}\nRoster: {roster}. {tools}'
      },
      permissions: {
        canRecruit: false,
        canDismiss: false,
        canAssignTasks: false,
        canCreateRoleProfile: false
      },
      defaultEngine: 'claude'
    };
    await addCustom(newProfile);
    setExpanded(id);
  };

  const onSavePreamble = async (lang: 'en' | 'ja', value: string): Promise<void> => {
    await saveFile({
      ...file,
      globalPreamble: { ...(file.globalPreamble ?? {}), [lang]: value }
    });
  };

  return (
    <div className="modal__section role-profiles">
      <h3 className="modal__section-title">{t('settings.roles.title')}</h3>
      <p className="modal__note">{t('settings.roles.desc')}</p>

      {/* グローバル preamble */}
      <details className="role-profile" style={{ marginBottom: 16 }}>
        <summary className="role-profile__summary">
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <ChevronRight size={13} className="role-profile__chev role-profile__chev--closed" />
            <ChevronDown size={13} className="role-profile__chev role-profile__chev--open" />
            <strong>{t('settings.roles.globalPreamble')}</strong>
          </span>
          <span className="role-profile__hint">{t('settings.roles.globalPreambleHint')}</span>
        </summary>
        <div className="role-profile__body">
          <label className="settings-field">
            <span className="settings-field__label">English</span>
            <textarea
              className="settings-field__textarea"
              value={file.globalPreamble?.en ?? ''}
              rows={3}
              onChange={(e) => void onSavePreamble('en', e.target.value)}
              placeholder="(empty)"
            />
          </label>
          <label className="settings-field">
            <span className="settings-field__label">日本語</span>
            <textarea
              className="settings-field__textarea"
              value={file.globalPreamble?.ja ?? ''}
              rows={3}
              onChange={(e) => void onSavePreamble('ja', e.target.value)}
              placeholder="(空)"
            />
          </label>
        </div>
      </details>

      <ul className="role-profile-list">
        {ordered.map((p) => (
          <RoleProfileRow
            key={p.id}
            profile={p}
            isExpanded={expanded === p.id}
            onToggle={() => onToggle(p.id)}
            onChange={async (patch) => {
              if (BUILTIN_BY_ID[p.id]) {
                // built-in: overrides に書く
                await upsertOverride(p.id, patch);
              } else {
                // custom: file.custom を直接書き換え
                const next = {
                  ...file,
                  custom: (file.custom ?? []).map((c) =>
                    c.id === p.id ? { ...c, ...patch, schemaVersion: 1 as const, source: 'user' as const, id: c.id } : c
                  )
                };
                await saveFile(next);
              }
            }}
            onRemove={
              BUILTIN_BY_ID[p.id]
                ? undefined
                : async () => {
                    if (await confirm(t('settings.roles.confirmDelete', { id: p.id }))) {
                      await removeCustom(p.id);
                    }
                  }
            }
            language={settings.language}
          />
        ))}
      </ul>

      <button
        type="button"
        className="settings-button settings-button--primary"
        onClick={() => void onAddCustom()}
        style={{ marginTop: 12 }}
      >
        <Plus size={14} />
        {t('settings.roles.addCustom')}
      </button>
    </div>
  );
}

interface RowProps {
  profile: RoleProfile;
  isExpanded: boolean;
  onToggle: () => void;
  onChange: (patch: Partial<Omit<RoleProfile, 'id' | 'source' | 'schemaVersion'>>) => Promise<void>;
  onRemove?: () => Promise<void>;
  language: 'ja' | 'en';
}

function RoleProfileRow({
  profile,
  isExpanded,
  onToggle,
  onChange,
  onRemove,
  language
}: RowProps): JSX.Element {
  const t = useT();
  const lang = language === 'ja' ? profile.i18n.ja ?? profile.i18n.en : profile.i18n.en;
  const isBuiltin = profile.source === 'builtin';

  const updateI18n = (which: 'en' | 'ja', field: 'label' | 'description', value: string): void => {
    const i18n = { ...profile.i18n };
    const base = (i18n[which] ?? { label: '', description: '' }) as { label: string; description: string };
    i18n[which] = { ...base, [field]: value };
    void onChange({ i18n });
  };

  return (
    <li className="role-profile" data-open={isExpanded || undefined}>
      <button type="button" className="role-profile__summary" onClick={onToggle}>
        <span
          aria-hidden="true"
          className="role-profile__avatar"
          style={{ background: profile.visual.color }}
        >
          {profile.visual.glyph}
        </span>
        <span className="role-profile__id">
          <strong>{lang.label}</strong>
          <span className="role-profile__hint">{profile.id}</span>
        </span>
        <span className="role-profile__source">
          {isBuiltin ? t('settings.roles.builtin') : t('settings.roles.custom')}
        </span>
        {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </button>

      {isExpanded && (
        <div className="role-profile__body">
          <div className="role-profile__row">
            <label className="settings-field">
              <span className="settings-field__label">EN label</span>
              <input
                className="settings-field__input"
                value={profile.i18n.en.label}
                onChange={(e) => updateI18n('en', 'label', e.target.value)}
              />
            </label>
            <label className="settings-field">
              <span className="settings-field__label">JA label</span>
              <input
                className="settings-field__input"
                value={profile.i18n.ja?.label ?? ''}
                onChange={(e) => updateI18n('ja', 'label', e.target.value)}
              />
            </label>
          </div>

          <div className="role-profile__row">
            <label className="settings-field">
              <span className="settings-field__label">{t('settings.roles.color')}</span>
              <input
                className="settings-field__input"
                type="color"
                value={profile.visual.color}
                onChange={(e) =>
                  void onChange({ visual: { ...profile.visual, color: e.target.value } })
                }
                style={{ width: 60, padding: 2 }}
              />
            </label>
            <label className="settings-field">
              <span className="settings-field__label">{t('settings.roles.glyph')}</span>
              <input
                className="settings-field__input"
                value={profile.visual.glyph}
                maxLength={2}
                onChange={(e) =>
                  void onChange({ visual: { ...profile.visual, glyph: e.target.value } })
                }
                style={{ width: 60 }}
              />
            </label>
            <label className="settings-field">
              <span className="settings-field__label">{t('settings.roles.defaultEngine')}</span>
              <select
                className="settings-field__input"
                value={profile.defaultEngine}
                onChange={(e) =>
                  void onChange({ defaultEngine: e.target.value as 'claude' | 'codex' })
                }
              >
                <option value="claude">Claude Code</option>
                <option value="codex">Codex</option>
              </select>
            </label>
          </div>

          <fieldset className="role-profile__perms">
            <legend>{t('settings.roles.permissions')}</legend>
            {(['canRecruit', 'canDismiss', 'canAssignTasks', 'canCreateRoleProfile'] as const).map(
              (perm) => (
                <label key={perm} className="role-profile__perm">
                  <input
                    type="checkbox"
                    checked={profile.permissions[perm]}
                    onChange={(e) =>
                      void onChange({
                        permissions: { ...profile.permissions, [perm]: e.target.checked }
                      })
                    }
                  />
                  <span>{perm}</span>
                </label>
              )
            )}
            <label className="role-profile__perm">
              <input
                type="checkbox"
                checked={!!profile.singleton}
                onChange={(e) => void onChange({ singleton: e.target.checked })}
              />
              <span>singleton</span>
            </label>
          </fieldset>

          <label className="settings-field">
            <span className="settings-field__label">{t('settings.roles.promptEn')}</span>
            <textarea
              className="settings-field__textarea"
              rows={6}
              value={profile.prompt.template}
              onChange={(e) =>
                void onChange({ prompt: { ...profile.prompt, template: e.target.value } })
              }
              spellCheck={false}
            />
            <span className="settings-field__hint">{t('settings.roles.promptPlaceholders')}</span>
          </label>

          <label className="settings-field">
            <span className="settings-field__label">{t('settings.roles.promptJa')}</span>
            <textarea
              className="settings-field__textarea"
              rows={6}
              value={profile.prompt.templateJa ?? ''}
              onChange={(e) =>
                void onChange({ prompt: { ...profile.prompt, templateJa: e.target.value } })
              }
              spellCheck={false}
            />
          </label>

          {onRemove && (
            <button
              type="button"
              className="settings-button settings-button--danger"
              onClick={() => void onRemove()}
              style={{ marginTop: 8 }}
            >
              <Trash2 size={14} />
              {t('settings.roles.deleteRole')}
            </button>
          )}
        </div>
      )}
    </li>
  );
}
