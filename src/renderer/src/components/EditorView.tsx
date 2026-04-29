import { useState } from 'react';
import { Editor } from '@monaco-editor/react';
import { Code2, Eye, Save } from 'lucide-react';
import '../lib/monaco-setup';
import { detectLanguage } from '../lib/language';
import { useMonacoTheme, useSettings } from '../lib/settings-context';
import { useT } from '../lib/i18n';
import { MarkdownPreview } from './MarkdownPreview';
import { ImagePreview } from './ImagePreview';

interface EditorViewProps {
  path: string;
  /**
   * Issue #325: ImagePreview に絶対パスを渡すために必要。
   * 未指定なら画像ファイルでも従来どおり binary プレースホルダにフォールバックする。
   */
  projectRoot?: string;
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

/**
 * Issue #325: relPath を projectRoot に結合して OS 絶対パスを作る。
 * convertFileSrc は forward slash でも動作するため `/` で統一し、
 * 重複区切りやバックスラッシュは正規化する。
 */
function joinAbsolutePath(projectRoot: string, relPath: string): string {
  const root = projectRoot.replace(/[\\/]+$/, '');
  const rel = relPath.replace(/^[\\/]+/, '').replace(/\\/g, '/');
  return `${root}/${rel}`;
}

export function EditorView({
  path,
  projectRoot,
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
  // .md ファイルは既定でプレビュー表示。トグルでコード編集に切替。
  // 早期 return より後で useState すると Rules of Hooks 違反になるので、
  // フックは全て先頭で呼ぶ。
  const [previewMode, setPreviewMode] = useState<boolean>(true);

  // Issue #325: 画像言語にマップされる拡張子は loading / isBinary より優先して
  // ImagePreview に流す。binary プレースホルダではなく実際の画像を表示する。
  const language = detectLanguage(path);
  const isImage = language === 'image';

  if (isImage && projectRoot) {
    return (
      <div className="diffview">
        <div className="diffview__header">
          <span className="diffview__path">{path}</span>
        </div>
        <div className="diffview__editor">
          <ImagePreview
            absolutePath={joinAbsolutePath(projectRoot, path)}
            relativePath={path}
          />
        </div>
      </div>
    );
  }

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

  const isMarkdown = language === 'markdown';
  const showPreview = isMarkdown && previewMode;

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
        {isMarkdown && (
          <button
            type="button"
            className="toolbar__btn toolbar__btn--icon"
            onClick={() => setPreviewMode((v) => !v)}
            title={previewMode ? t('editor.viewSource') : t('editor.viewPreview')}
            aria-label={previewMode ? t('editor.viewSource') : t('editor.viewPreview')}
            aria-pressed={previewMode}
          >
            {previewMode ? (
              <Code2 size={15} strokeWidth={1.75} />
            ) : (
              <Eye size={15} strokeWidth={1.75} />
            )}
          </button>
        )}
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
        {showPreview ? (
          <MarkdownPreview source={content} />
        ) : (
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
        )}
      </div>
    </div>
  );
}
