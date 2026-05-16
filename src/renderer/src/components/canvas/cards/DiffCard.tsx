/**
 * DiffCard — Canvas 上で 1 ファイルの git diff を Monaco DiffEditor で表示するカード。
 *
 * payload: { projectRoot, relPath }
 */
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import type { GitDiffResult } from '../../../../../types/shared';
import { CardFrame } from '../CardFrame';
import { DiffView } from '../../DiffView';
import { useFilesChanged } from '../../../lib/use-files-changed';
import type { CardDataOf, DiffCardPayload } from '../../../stores/canvas';

// Issue #732: payload 型は canvas store の判別可能 union に集約。`NodeProps` を
// `Node<CardDataOf<'diff'>>` で具体化することで `data.payload` の inline cast を撤廃。
function DiffCardImpl({ id, data }: NodeProps<Node<CardDataOf<'diff'>>>): JSX.Element {
  // 旧 `(data?.payload ?? {}) as DiffPayload` と同一挙動 (空 payload を許容)。
  const payload = (data?.payload ?? {}) as DiffCardPayload;
  const { projectRoot, relPath, originalRelPath } = payload;
  const title = (data?.title as string) ?? `diff: ${relPath}`;

  const [result, setResult] = useState<GitDiffResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [sideBySide, setSideBySide] = useState(true);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(() => {
    if (!projectRoot || !relPath) {
      if (mountedRef.current) setLoading(false);
      return;
    }
    setLoading(true);
    void window.api.git
      .diff(projectRoot, relPath, originalRelPath)
      .then((r) => {
        if (mountedRef.current) setResult(r);
      })
      .catch(() => {
        /* noop */
      })
      .finally(() => {
        if (mountedRef.current) setLoading(false);
      });
  }, [projectRoot, relPath, originalRelPath]);

  useEffect(() => {
    let cancelled = false;
    if (!projectRoot || !relPath) {
      setLoading(false);
      return;
    }
    setLoading(true);
    void window.api.git
      .diff(projectRoot, relPath, originalRelPath)
      .then((r) => {
        if (!cancelled) setResult(r);
      })
      .catch(() => {
        /* noop */
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [projectRoot, relPath, originalRelPath]);

  // Issue #128: 外部からの変更を検知して自動更新
  useFilesChanged(refresh);

  return (
    <>
      <Handle type="target" position={Position.Left} style={{ background: '#f5a85a' }} />
      <CardFrame id={id} title={title} accent="#f5a85a">
        <DiffView
          result={result}
          loading={loading}
          sideBySide={sideBySide}
          onToggleSideBySide={() => setSideBySide((s) => !s)}
        />
      </CardFrame>
      <Handle type="source" position={Position.Right} style={{ background: '#f5a85a' }} />
    </>
  );
}

export default memo(DiffCardImpl);
