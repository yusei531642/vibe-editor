/**
 * DiffCard — Canvas 上で 1 ファイルの git diff を Monaco DiffEditor で表示するカード。
 *
 * payload: { projectRoot, relPath }
 */
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { GitDiffResult } from '../../../../../types/shared';
import { CardFrame } from '../CardFrame';
import { DiffView } from '../../DiffView';
import { useFilesChanged } from '../../../lib/use-files-changed';

interface DiffPayload {
  projectRoot: string;
  relPath: string;
  /** Issue #19: rename の HEAD 側パス。CanvasSidebar / ChangesCard が渡す。 */
  originalRelPath?: string;
}

function DiffCardImpl({ id, data }: NodeProps): JSX.Element {
  const payload = (data?.payload ?? {}) as DiffPayload;
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
