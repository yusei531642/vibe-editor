/**
 * FileTreeCard — プロジェクトルートのファイルツリーを表示し、
 * クリックで EditorCard を Canvas に追加するカード。
 *
 * payload: { projectRoot, extraRoots? }
 */
import { memo, useCallback } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { CardFrame } from '../CardFrame';
import { FileTreePanel } from '../../FileTreePanel';
import { useCanvasStore } from '../../../stores/canvas';
import type { CardDataOf } from '../../../stores/canvas';
import { useSettings } from '../../../lib/settings-context';
import { useProject } from '../../../lib/app-state-context';

// Issue #732: payload 型は canvas store の判別可能 union に集約。`NodeProps` を
// `Node<CardDataOf<'fileTree'>>` で具体化することで `data.payload` が直接読め、inline cast を撤廃。
function FileTreeCardImpl({
  id,
  data,
  positionAbsoluteX,
  positionAbsoluteY
}: NodeProps<Node<CardDataOf<'fileTree'>>>): JSX.Element {
  const { settings } = useSettings();
  const {
    projectRoot,
    handleAddWorkspaceFolder,
    handleRemoveWorkspaceFolder
  } = useProject();
  const payload = data?.payload ?? {};
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

  // Issue #273: 展開状態 / 永続化は FileTreeStateProvider に集約済み。FileTreeCard 自身は
  // 永続化ロジックを持たない (Sidebar との last-writer-wins 排除)。
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
            onAddWorkspaceFolder={() => void handleAddWorkspaceFolder()}
            onRemoveWorkspaceFolder={(p) => void handleRemoveWorkspaceFolder(p)}
          />
        </div>
      </CardFrame>
      <Handle type="source" position={Position.Right} style={{ background: '#a7c8ff' }} />
    </>
  );
}

export default memo(FileTreeCardImpl);
