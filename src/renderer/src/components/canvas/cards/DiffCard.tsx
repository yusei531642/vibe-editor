/**
 * DiffCard — Canvas 上で 1 ファイルの git diff を Monaco DiffEditor で表示するカード。
 *
 * payload: { projectRoot, relPath }
 */
import { memo, useEffect, useState } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { GitDiffResult } from '../../../../../types/shared';
import { CardFrame } from '../CardFrame';
import { DiffView } from '../../DiffView';

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
