import { Editor } from '@monaco-editor/react';
import { Save } from 'lucide-react';
import '../lib/monaco-setup';
import { detectLanguage } from '../lib/language';
import { useMonacoTheme, useSettings } from '../lib/settings-context';
import { useT } from '../lib/i18n';

interface EditorViewProps {
  path: string;
  content: string;
  dirty: boolean;
  isBinary: boolean;
  loading: boolean;
  error: string | null;
  /** Issue #35: 非 UTF-8 などで保存が危険な場合、編集を禁止する */
  readOnly?: boolean;
  /** readOnly=true のときヘッダに出す警告文 */
  readOnlyReason?: string;
  onChange: (value: string) => void;
  onSave: () => void;
}

export function EditorView({
  path,
  content,
  dirty,
  isBinary,
  loading,
  error,
  readOnly = false,
  readOnlyReason,
  onChange,
  onSave
}: EditorViewProps): JSX.Element {
  const { settings } = useSettings();
  const theme = useMonacoTheme();
  const t = useT();

  if (loading) {
    return (
      <div className="diffview">
        <div className="diffview__placeholder">{t('editor.loading')}</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="diffview">
        <div className="diffview__placeholder diffview__placeholder--error">
          {error}
        </div>
      </div>
    );
  }

  if (isBinary) {
    return (
      <div className="diffview">
        <div className="diffview__placeholder">
          {t('editor.binaryNotice', { path })}
        </div>
      </div>
    );
  }

  const language = detectLanguage(path);

  return (
    <div className="diffview">
      <div className="diffview__header">
        <span className="diffview__path">
          {path}
          {dirty ? ' ●' : ''}
          {readOnly && readOnlyReason && (
            <span
              className="diffview__path"
              style={{ marginLeft: 8, opacity: 0.7, fontSize: 11 }}
              title={readOnlyReason}
            >
              — {readOnlyReason}
            </span>
          )}
        </span>
        <button
          type="button"
          className="toolbar__btn toolbar__btn--icon"
          onClick={onSave}
          disabled={!dirty || readOnly}
          title={readOnly ? readOnlyReason ?? t('editor.save') : t('editor.save')}
          aria-label="save"
        >
          <Save size={15} strokeWidth={1.75} />
        </button>
      </div>
      <div className="diffview__editor">
        <Editor
          value={content}
          language={language}
          theme={theme}
          onChange={(v) => onChange(v ?? '')}
          options={{
            readOnly,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            fontSize: settings.editorFontSize,
            fontFamily: settings.editorFontFamily,
            wordWrap: 'on',
            tabSize: 2,
            automaticLayout: true
          }}
        />
      </div>
    </div>
  );
}
