/**
 * FileTreeCard — プロジェクトルートのファイルツリーを表示し、
 * クリックで EditorCard を Canvas に追加するカード。
 *
 * payload: { projectRoot, extraRoots? }
 */
import { memo, useCallback } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { CardFrame } from '../CardFrame';
import { FileTreePanel } from '../../FileTreePanel';
import { useCanvasStore } from '../../../stores/canvas';
import { useSettings } from '../../../lib/settings-context';

interface FileTreePayload {
  projectRoot?: string;
  extraRoots?: string[];
}

function FileTreeCardImpl({ id, data, positionAbsoluteX, positionAbsoluteY }: NodeProps): JSX.Element {
  const { settings } = useSettings();
  const payload = (data?.payload ?? {}) as FileTreePayload;
  const projectRoot = settings.claudeCwd || payload.projectRoot || '';
  const extraRoots = payload.extraRoots ?? settings.workspaceFolders ?? [];
  const title = (data?.title as string) ?? 'Files';

  const addCard = useCanvasStore((s) => s.addCard);

  const handleOpen = useCallback(
    (rootPath: string, relPath: string) => {
      addCard({
        type: 'editor',
        title: relPath.split(/[\\/]/).pop() ?? relPath,
        payload: { projectRoot: rootPath, relPath },
        position: {
          x: (positionAbsoluteX ?? 0) + 520,
          y: (positionAbsoluteY ?? 0) + 0
        }
      });
    },
    [addCard, positionAbsoluteX, positionAbsoluteY]
  );

  return (
    <>
      <Handle type="target" position={Position.Left} style={{ background: '#a7c8ff' }} />
      <CardFrame id={id} title={title} accent="#a7c8ff">
        <div style={{ height: '100%', overflow: 'auto' }}>
          <FileTreePanel
            primaryRoot={projectRoot}
            extraRoots={extraRoots}
            activeFilePath={null}
            onOpenFile={handleOpen}
            onAddWorkspaceFolder={() => {
              /* noop in canvas */
            }}
            onRemoveWorkspaceFolder={() => {
              /* noop in canvas */
            }}
          />
        </div>
      </CardFrame>
      <Handle type="source" position={Position.Right} style={{ background: '#a7c8ff' }} />
    </>
  );
}

export default memo(FileTreeCardImpl);
