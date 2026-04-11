import { DiffEditor } from '@monaco-editor/react';
import { Columns3, Rows3 } from 'lucide-react';
import '../lib/monaco-setup';
import type { GitDiffResult } from '../../../types/shared';
import { detectLanguage } from '../lib/language';
import { useMonacoTheme, useSettings } from '../lib/settings-context';

interface DiffViewProps {
  result: GitDiffResult | null;
  loading: boolean;
  sideBySide: boolean;
  onToggleSideBySide: () => void;
}

export function DiffView({
  result,
  loading,
  sideBySide,
  onToggleSideBySide
}: DiffViewProps): JSX.Element {
  const { settings } = useSettings();
  const theme = useMonacoTheme();

  if (loading || !result) {
    return (
      <div className="diffview">
        <div className="diffview__placeholder">
          {loading ? 'diff を読み込み中…' : '差分を表示するファイルを選択してください'}
        </div>
      </div>
    );
  }

  if (!result.ok) {
    return (
      <div className="diffview">
        <div className="diffview__placeholder diffview__placeholder--error">
          エラー: {result.error}
        </div>
      </div>
    );
  }

  if (result.isBinary) {
    return (
      <div className="diffview">
        <div className="diffview__placeholder">
          バイナリファイルは diff 表示できません: {result.path}
        </div>
      </div>
    );
  }

  const language = detectLanguage(result.path);
  const header: string[] = [result.path];
  if (result.isNew) header.push('(新規追加)');
  else if (result.isDeleted) header.push('(削除)');

  return (
    <div className="diffview">
      <div className="diffview__header">
        <span className="diffview__path">{header.join(' ')}</span>
        <button
          type="button"
          className="toolbar__btn toolbar__btn--icon"
          onClick={onToggleSideBySide}
          title={sideBySide ? 'インラインに切替' : 'サイドバイサイドに切替'}
          aria-label="差分表示モード切替"
        >
          {sideBySide ? (
            <Rows3 size={15} strokeWidth={1.75} />
          ) : (
            <Columns3 size={15} strokeWidth={1.75} />
          )}
        </button>
      </div>
      <div className="diffview__editor">
        <DiffEditor
          original={result.original}
          modified={result.modified}
          language={language}
          theme={theme}
          options={{
            readOnly: true,
            renderSideBySide: sideBySide,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            fontSize: settings.editorFontSize,
            fontFamily: settings.editorFontFamily,
            wordWrap: 'on'
          }}
        />
      </div>
    </div>
  );
}
