/**
 * FileTreeCard — プロジェクトルートのファイルツリーを表示し、
 * クリックで EditorCard を Canvas に追加するカード。
 *
 * payload: { projectRoot, extraRoots? }
 */
import { memo, useCallback, useMemo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { CardFrame } from '../CardFrame';
import { FileTreePanel } from '../../FileTreePanel';
import { useCanvasStore } from '../../../stores/canvas';
import { useSettings } from '../../../lib/settings-context';
import { useT } from '../../../lib/i18n';

interface FileTreePayload {
  projectRoot?: string;
  extraRoots?: string[];
}

/** Issue #250: FileTreePanel と同じ NUL 区切りキー (`<rootPath>\0<relPath>`) */
const KEY_SEP = '\0';

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
      if (!current.includes(path)) return;
      await update({ workspaceFolders: current.filter((p) => p !== path) });
    },
    [settings.workspaceFolders, update]
  );

  // Issue #250: IDE モード (Sidebar) と同じ map を共有することで Canvas 上の
  // FileTreeCard でも展開状態が永続化され、再起動後も保たれる。
  const initialExpanded = useMemo(() => {
    const set = new Set<string>();
    const map = settings.fileTreeExpanded ?? {};
    for (const [root, rels] of Object.entries(map)) {
      for (const rel of rels) {
        set.add(`${root}${KEY_SEP}${rel}`);
      }
    }
    return set;
  }, [settings.fileTreeExpanded]);

  const initialCollapsedRoots = useMemo(
    () => new Set(settings.fileTreeCollapsedRoots ?? []),
    [settings.fileTreeCollapsedRoots]
  );

  const handlePersistFileTreeState = useCallback(
    ({ expanded, collapsedRoots }: { expanded: Set<string>; collapsedRoots: Set<string> }) => {
      const map: Record<string, string[]> = {};
      for (const key of expanded) {
        const sep = key.indexOf(KEY_SEP);
        if (sep <= 0) continue;
        const root = key.slice(0, sep);
        const rel = key.slice(sep + 1);
        (map[root] ??= []).push(rel);
      }
      void update({
        fileTreeExpanded: map,
        fileTreeCollapsedRoots: Array.from(collapsedRoots)
      });
    },
    [update]
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
            onAddWorkspaceFolder={() => void handleAddWorkspaceFolder()}
            onRemoveWorkspaceFolder={(p) => void handleRemoveWorkspaceFolder(p)}
            initialExpanded={initialExpanded}
            initialCollapsedRoots={initialCollapsedRoots}
            onPersistState={handlePersistFileTreeState}
          />
        </div>
      </CardFrame>
      <Handle type="source" position={Position.Right} style={{ background: '#a7c8ff' }} />
    </>
  );
}

export default memo(FileTreeCardImpl);
