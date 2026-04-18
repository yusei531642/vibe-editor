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
import { useT } from '../../../lib/i18n';
import { normalizePathKey } from '../../../lib/normalize-path';

interface FileTreePayload {
  projectRoot?: string;
  extraRoots?: string[];
}

function FileTreeCardImpl({ id, data, positionAbsoluteX, positionAbsoluteY }: NodeProps): JSX.Element {
  const { settings, update } = useSettings();
  const t = useT();
  const payload = (data?.payload ?? {}) as FileTreePayload;
  // Issue #23: lastOpenedRoot (現在プロジェクト) を最優先、claudeCwd は fallback。
  const projectRoot = settings.lastOpenedRoot || settings.claudeCwd || payload.projectRoot || '';
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
            onAddWorkspaceFolder={async () => {
              // Issue #73: Canvas FileTreeCard でも workspace フォルダを実操作できるよう、
              // IDE 側と同じく settings.workspaceFolders へ反映する。
              const picked = await window.api.dialog.openFolder(t('dialog.addWorkspace'));
              if (!picked) return;
              const current = settings.workspaceFolders ?? [];
              const key = normalizePathKey(picked);
              if (current.some((p) => normalizePathKey(p) === key)) return;
              await update({ workspaceFolders: [...current, picked] });
            }}
            onRemoveWorkspaceFolder={async (path: string) => {
              const current = settings.workspaceFolders ?? [];
              const next = current.filter((p) => p !== path);
              await update({ workspaceFolders: next });
            }}
          />
        </div>
      </CardFrame>
      <Handle type="source" position={Position.Right} style={{ background: '#a7c8ff' }} />
    </>
  );
}

export default memo(FileTreeCardImpl);
