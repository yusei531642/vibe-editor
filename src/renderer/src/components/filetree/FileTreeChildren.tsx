import type { FileNode } from '../../../../types/shared';
import {
  KEY_SEP,
  dirKey,
  type DirState
} from '../../lib/filetree-state-context';
import type { ContextMenuItem } from '../ContextMenu';
import { FileTreeInlineRow } from './FileTreeInlineRow';
import { FileTreeNode } from './FileTreeNode';
import type { InlineInputState } from './types';

interface FileTreeChildrenProps {
  rootPath: string;
  relPath: string;
  depth: number;
  dirs: Map<string, DirState>;
  expanded: Set<string>;
  activeFilePath: string | null;
  recentRankMap: Map<string, number>;
  inlineInput: InlineInputState | null;
  newFolderPlaceholder: string;
  newFilePlaceholder: string;
  renamePlaceholder: string;
  onInlineSubmit: (value: string) => Promise<boolean>;
  onInlineCancel: () => void;
  onToggle: (rootPath: string, node: FileNode) => void;
  onOpenFile: (rootPath: string, relPath: string) => void;
  onContextMenu: (e: React.MouseEvent, rootPath: string, node: FileNode) => void;
}

export function FileTreeChildren(props: FileTreeChildrenProps): JSX.Element | null {
  const {
    rootPath,
    relPath,
    depth,
    dirs,
    expanded,
    activeFilePath,
    recentRankMap,
    inlineInput,
    newFolderPlaceholder,
    newFilePlaceholder,
    renamePlaceholder,
    onInlineSubmit,
    onInlineCancel,
    onToggle,
    onOpenFile,
    onContextMenu
  } = props;
  const state = dirs.get(dirKey(rootPath, relPath));
  if (!state) return null;
  if (state.loading && state.entries.length === 0) {
    return (
      <div className="filetree__loading" style={{ paddingLeft: 10 + depth * 12 }}>
        …
      </div>
    );
  }
  if (state.error) {
    return (
      <div className="filetree__error" style={{ paddingLeft: 10 + depth * 12 }}>
        {state.error}
      </div>
    );
  }
  // Issue #592: 当該ディレクトリ直下に inline-input が出る場合は、entries 一覧の頭で表示する。
  const showInline =
    inlineInput &&
    inlineInput.rootPath === rootPath &&
    inlineInput.parentRel === relPath &&
    (inlineInput.mode === 'create-file' || inlineInput.mode === 'create-folder');
  if (state.entries.length === 0 && !showInline) {
    return (
      <div className="filetree__empty" style={{ paddingLeft: 10 + depth * 12 }}>
        —
      </div>
    );
  }

  const renderChildren = (
    childRootPath: string,
    childRelPath: string,
    childDepth: number
  ): JSX.Element | null => (
    <FileTreeChildren
      {...props}
      rootPath={childRootPath}
      relPath={childRelPath}
      depth={childDepth}
    />
  );

  return (
    <>
      {showInline && (
        <FileTreeInlineRow
          depth={depth + 1}
          kind={inlineInput.mode === 'create-folder' ? 'folder' : 'file'}
          placeholder={
            inlineInput.mode === 'create-folder'
              ? newFolderPlaceholder
              : newFilePlaceholder
          }
          initialValue=""
          onSubmit={onInlineSubmit}
          onCancel={onInlineCancel}
        />
      )}
      {state.entries.map((node) => {
        const childKey = dirKey(rootPath, node.path);
        const isOpen = node.isDir && expanded.has(childKey);
        const childState: DirState | null = node.isDir
          ? dirs.get(childKey) ?? null
          : null;
        const isActive = !node.isDir && activeFilePath === node.path;
        const recentRank = node.isDir
          ? -1
          : recentRankMap.get(`${rootPath}${KEY_SEP}${node.path}`) ?? -1;
        // Issue #592: rename inline-input は対象 entry を inline 入力欄で置換する。
        const isRenaming =
          inlineInput &&
          inlineInput.mode === 'rename' &&
          inlineInput.rootPath === rootPath &&
          inlineInput.originalRelPath === node.path;
        if (isRenaming) {
          return (
            <FileTreeInlineRow
              key={`rename-${childKey}`}
              depth={depth + 1}
              kind={node.isDir ? 'folder' : 'file'}
              placeholder={renamePlaceholder}
              initialValue={node.name}
              onSubmit={onInlineSubmit}
              onCancel={onInlineCancel}
            />
          );
        }
        return (
          <FileTreeNode
            key={childKey}
            rootPath={rootPath}
            node={node}
            depth={depth}
            isOpen={isOpen}
            isActive={isActive}
            recentRank={recentRank}
            childState={childState}
            onToggle={onToggle}
            onOpenFile={onOpenFile}
            onContextMenu={onContextMenu}
            renderChildren={renderChildren}
          />
        );
      })}
    </>
  );
}
