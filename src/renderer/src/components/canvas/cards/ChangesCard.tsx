/**
 * ChangesCard — git status 一覧を表示し、クリックで DiffCard を Canvas に追加するカード。
 *
 * payload: { projectRoot }
 */
import { memo, useCallback, useEffect, useState } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { GitStatus } from '../../../../../types/shared';
import { CardFrame } from '../CardFrame';
import { ChangesPanel } from '../../ChangesPanel';
import { useCanvasStore } from '../../../stores/canvas';
import { useSettings } from '../../../lib/settings-context';

interface ChangesPayload {
  projectRoot?: string;
}

function ChangesCardImpl({ id, data, positionAbsoluteX, positionAbsoluteY }: NodeProps): JSX.Element {
  const { settings } = useSettings();
  const payload = (data?.payload ?? {}) as ChangesPayload;
  // workspace を真の source とする: settings.claudeCwd 優先、payload は fallback
  const projectRoot = settings.claudeCwd || payload.projectRoot || '';
  const title = (data?.title as string) ?? 'Changes';

  const addCard = useCanvasStore((s) => s.addCard);
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(() => {
    if (!projectRoot) return;
    setLoading(true);
    void window.api.git
      .status(projectRoot)
      .then(setStatus)
      .catch(() => setStatus(null))
      .finally(() => setLoading(false));
  }, [projectRoot]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleOpenDiff = useCallback(
    (file: { path: string }) => {
      addCard({
        type: 'diff',
        title: `diff: ${file.path.split(/[\\/]/).pop() ?? file.path}`,
        payload: { projectRoot, relPath: file.path },
        position: {
          x: (positionAbsoluteX ?? 0) + 520,
          y: (positionAbsoluteY ?? 0) + 0
        }
      });
    },
    [addCard, positionAbsoluteX, positionAbsoluteY, projectRoot]
  );

  return (
    <>
      <Handle type="target" position={Position.Left} style={{ background: '#f06060' }} />
      <CardFrame id={id} title={title} accent="#f06060">
        <div style={{ height: '100%', overflow: 'auto' }}>
          <ChangesPanel
            status={status}
            loading={loading}
            onRefresh={refresh}
            onOpenDiff={handleOpenDiff}
            onFileContextMenu={() => {
              /* noop */
            }}
            activeDiffPath={null}
          />
        </div>
      </CardFrame>
      <Handle type="source" position={Position.Right} style={{ background: '#f06060' }} />
    </>
  );
}

export default memo(ChangesCardImpl);
