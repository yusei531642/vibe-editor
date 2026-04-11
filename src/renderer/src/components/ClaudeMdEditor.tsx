import Editor, { type OnMount } from '@monaco-editor/react';
import { useCallback } from 'react';
import '../lib/monaco-setup';
import { useMonacoTheme, useSettings } from '../lib/settings-context';

interface ClaudeMdEditorProps {
  value: string;
  /** 保存済みコンテンツ（インラインの diff 装飾に使用） */
  originalValue: string;
  onChange: (value: string) => void;
  onSaveShortcut: () => void;
}

/**
 * CLAUDE.md 編集用の Monaco Editor。
 * claude.ai 風の「清潔な単一編集面」にするため、通常の Editor コンポーネントを使用し、
 * savedContent との差分は UI 外の dirty マーカーとツールバーステータスに委ねる。
 */
export function ClaudeMdEditor({
  value,
  onChange,
  onSaveShortcut
}: ClaudeMdEditorProps): JSX.Element {
  const { settings } = useSettings();
  const theme = useMonacoTheme();

  const handleMount: OnMount = useCallback(
    (editor, monaco) => {
      editor.addCommand(
        monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
        () => {
          onSaveShortcut();
        }
      );
    },
    [onSaveShortcut]
  );

  return (
    <div className="editor">
      <Editor
        height="100%"
        defaultLanguage="markdown"
        value={value}
        onChange={(v) => onChange(v ?? '')}
        onMount={handleMount}
        theme={theme}
        options={{
          fontSize: settings.editorFontSize,
          fontFamily: settings.editorFontFamily,
          fontLigatures: true,
          minimap: { enabled: false },
          wordWrap: 'on',
          lineNumbers: 'on',
          renderWhitespace: 'none',
          scrollBeyondLastLine: false,
          tabSize: 2,
          padding: { top: 20, bottom: 20 },
          lineDecorationsWidth: 12,
          lineNumbersMinChars: 3,
          folding: false,
          scrollbar: {
            verticalScrollbarSize: 10,
            horizontalScrollbarSize: 10,
            useShadows: false
          },
          overviewRulerLanes: 0,
          hideCursorInOverviewRuler: true,
          overviewRulerBorder: false
        }}
      />
    </div>
  );
}
