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
        </span>
        <button
          type="button"
          className="toolbar__btn toolbar__btn--icon"
          onClick={onSave}
          disabled={!dirty}
          title={t('editor.save')}
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
            readOnly: false,
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
