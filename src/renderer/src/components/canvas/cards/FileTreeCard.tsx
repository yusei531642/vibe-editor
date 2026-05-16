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
import { useT } from '../../../lib/i18n';
import { useNativeConfirm } from '../../../lib/use-native-confirm';

// Issue #732: payload 型は canvas store の判別可能 union に集約。`NodeProps` を
// `Node<CardDataOf<'fileTree'>>` で具体化することで `data.payload` が直接読め、inline cast を撤廃。
function FileTreeCardImpl({
  id,
  data,
  positionAbsoluteX,
  positionAbsoluteY
}: NodeProps<Node<CardDataOf<'fileTree'>>>): JSX.Element {
  const { settings, update } = useSettings();
  const t = useT();
  const confirm = useNativeConfirm();
  const payload = data?.payload ?? {};
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

  // Issue #73: Canvas でも workspace folder 操作を効かせる。
  // 旧実装は両方 no-op だったため、Canvas 上の「追加」ボタン / 削除 × が silent に無反応だった。
  const handleAddWorkspaceFolder = useCallback(async () => {
    const picked = await window.api.dialog.openFolder(t('appMenu.addWorkspaceDialogTitle'));
    if (!picked) return;
    const current = settings.workspaceFolders ?? [];
    if (current.includes(picked)) return;
    await update({ workspaceFolders: [...current, picked] });
  }, [settings.workspaceFolders, update, t]);

  const handleRemoveWorkspaceFolder = useCallback(
    async (path: string) => {
      const current = settings.workspaceFolders ?? [];
      const isPrimary = path === projectRoot;
      if (!isPrimary && !current.includes(path)) return;
      if (isPrimary) {
        const name = path.split(/[\\/]/).pop() ?? path;
        if (!(await confirm(t('workspace.removePrimaryConfirm', { name })))) return;
      }
      const nextPrimary = isPrimary ? current.find((p) => p !== path) ?? '' : projectRoot;
      await update({
        workspaceFolders: current.filter((p) => p !== path && p !== nextPrimary),
        ...(isPrimary ? { lastOpenedRoot: nextPrimary } : {})
      });
    },
    [settings.workspaceFolders, projectRoot, update, t, confirm]
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
