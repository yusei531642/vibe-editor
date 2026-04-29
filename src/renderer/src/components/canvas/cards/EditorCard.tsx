/**
 * EditorCard — Canvas 上で 1 ファイルを Monaco で編集するカード。
 *
 * payload: { projectRoot, relPath }
 * 自前で files.read/write を呼び、dirty 管理 + Ctrl+S 保存。
 */
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { CardFrame } from '../CardFrame';
import { EditorView } from '../../EditorView';
import { detectLanguage } from '../../../lib/language';

interface EditorPayload {
  projectRoot: string;
  relPath: string;
}

function EditorCardImpl({ id, data }: NodeProps): JSX.Element {
  const payload = (data?.payload ?? {}) as EditorPayload;
  const { projectRoot, relPath } = payload;
  const title = (data?.title as string) ?? relPath ?? 'Editor';
  const isImage = useMemo(
    () => (relPath ? detectLanguage(relPath) === 'image' : false),
    [relPath]
  );

  const [content, setContent] = useState('');
  const [original, setOriginal] = useState('');
  const [isBinary, setIsBinary] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!projectRoot || !relPath) {
      setLoading(false);
      return;
    }
    // Issue #325: 画像ファイルは files.read を呼ばず ImagePreview に委ねる。
    // バイナリを丸ごと UTF-8 lossy で読むコストを避けるため早期 return する。
    if (isImage) {
      setLoading(false);
      return;
    }
    setLoading(true);
    void window.api.files
      .read(projectRoot, relPath)
      .then((res) => {
        if (cancelled) return;
        if (!res.ok) {
          setError(res.error ?? 'failed to read');
        } else {
          setContent(res.content);
          setOriginal(res.content);
          setIsBinary(res.isBinary);
          setError(null);
        }
      })
      .catch((e) => !cancelled && setError(String(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [projectRoot, relPath, isImage]);

  const dirty = content !== original;

  const onSave = useCallback(async () => {
    if (!dirty) return;
    const res = await window.api.files.write(projectRoot, relPath, content);
    if (res.ok) {
      setOriginal(content);
    } else {
      setError(res.error ?? 'failed to save');
    }
  }, [dirty, projectRoot, relPath, content]);

  return (
    <>
      <Handle type="target" position={Position.Left} style={{ background: '#7a9eff' }} />
      <CardFrame id={id} title={isImage ? title : dirty ? `● ${title}` : title} accent="#7a9eff">
        <EditorView
          path={relPath}
          projectRoot={projectRoot}
          content={content}
          dirty={dirty}
          isBinary={isBinary}
          loading={loading}
          error={error}
          onChange={setContent}
          onSave={() => void onSave()}
        />
      </CardFrame>
      <Handle type="source" position={Position.Right} style={{ background: '#7a9eff' }} />
    </>
  );
}

export default memo(EditorCardImpl);
