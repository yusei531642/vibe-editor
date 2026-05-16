import { memo } from 'react';
import { ChevronRight, File as DefaultFileIcon } from 'lucide-react';
import type { FileNode } from '../../../../types/shared';
import { fileIcon, folderIcon } from '../../lib/file-icon-color';
import type { DirState } from '../../lib/filetree-state-context';
import { fileTreeGuideStyle } from './utils';

interface FileTreeNodeProps {
  rootPath: string;
  node: FileNode;
  depth: number;
  isOpen: boolean;
  isActive: boolean;
  /**
   * Issue #480: 最近開いたファイルの順位 (0 = 直近, 1 = その前, ...)。
   * -1 は履歴に含まれていない。active と重なる場合は UI 側で active を優先する。
   */
  recentRank: number;
  /** 子ディレクトリの DirState (再レンダー判定用)。null は未読込 or ファイル */
  childState: DirState | null;
  onToggle: (rootPath: string, node: FileNode) => void;
  onOpenFile: (rootPath: string, relPath: string) => void;
  /** Issue #251: 右クリックメニュー要求 */
  onContextMenu: (e: React.MouseEvent, rootPath: string, node: FileNode) => void;
  renderChildren: (
    rootPath: string,
    relPath: string,
    depth: number
  ) => JSX.Element | null;
}

function FileTreeNodeImpl({
  rootPath,
  node,
  depth,
  isOpen,
  isActive,
  recentRank,
  onToggle,
  onOpenFile,
  onContextMenu,
  renderChildren
}: FileTreeNodeProps): JSX.Element {
  const fileIconDef = node.isDir ? undefined : fileIcon(node.name);
  const FileTypeIcon = fileIconDef?.Icon ?? DefaultFileIcon;
  const fileTypeColor = fileIconDef?.color;
  const folderDef = node.isDir ? folderIcon(node.name, isOpen) : undefined;

  const handleClick = (): void => {
    if (node.isDir) onToggle(rootPath, node);
    else onOpenFile(rootPath, node.path);
  };

  return (
    <>
      <button
        type="button"
        className={`filetree__row${isActive ? ' is-active' : ''}`}
        style={fileTreeGuideStyle(depth)}
        onClick={handleClick}
        onContextMenu={(e) => onContextMenu(e, rootPath, node)}
      >
        {node.isDir && folderDef ? (
          <>
            <ChevronRight
              size={13}
              strokeWidth={2.25}
              className={`filetree__chevron${isOpen ? ' is-open' : ''}`}
            />
            <folderDef.Icon
              size={14}
              strokeWidth={2}
              fill="currentColor"
              fillOpacity={isOpen ? 0.22 : 0.18}
              className={`filetree__icon${isOpen ? ' filetree__icon--open' : ''}${folderDef.color ? ' filetree__icon--colored' : ''}`}
              style={folderDef.color ? { color: folderDef.color } : undefined}
              aria-hidden
            />
          </>
        ) : (
          <>
            <span className="filetree__chevron-spacer" />
            <FileTypeIcon
              size={14}
              strokeWidth={2}
              className="filetree__file-icon"
              style={fileTypeColor ? { color: fileTypeColor } : undefined}
              aria-hidden
            />
          </>
        )}
        <span
          className={
            'filetree__name' +
            // Issue #480: active でない最近ファイルに段階的な色クラスを付与
            (!isActive && recentRank >= 0
              ? recentRank === 0
                ? ' is-recent is-recent-1'
                : recentRank <= 2
                  ? ' is-recent is-recent-2'
                  : recentRank <= 5
                    ? ' is-recent is-recent-3'
                    : ' is-recent'
              : '')
          }
        >{node.name}</span>
      </button>
      {node.isDir && isOpen ? renderChildren(rootPath, node.path, depth + 1) : null}
    </>
  );
}

/**
 * Issue #129: React.memo で「親が再レンダーしても自分の入力 (node, isOpen, isActive,
 * childState など) が変わらない限り再レンダーしない」ようにする。
 * 親が expanded Set を新規生成しても、各ノードの isOpen は親側で計算してから
 * primitive boolean として渡しているので memo が安全に効く。
 * renderChildren は親が毎レンダー再生成するため、ここでは再レンダー判定から外す
 * (renderChildren 経由で開いた子供は依然として再帰的に再構築されるが、
 *  閉じているノード/葉は本 memo + props 比較で再レンダーをスキップできる)。
 */
export const FileTreeNode = memo(FileTreeNodeImpl, (prev, next) => {
  return (
    prev.rootPath === next.rootPath &&
    prev.node === next.node &&
    prev.depth === next.depth &&
    prev.isOpen === next.isOpen &&
    prev.isActive === next.isActive &&
    prev.recentRank === next.recentRank &&
    prev.childState === next.childState &&
    prev.onToggle === next.onToggle &&
    prev.onOpenFile === next.onOpenFile &&
    prev.onContextMenu === next.onContextMenu
    // renderChildren は意図的に比較しない (毎レンダー新参照になるが、
    // 開いているディレクトリは isOpen + childState の変化で再レンダーが
    // 既に走るので問題なし。閉じているノード/葉は早期 return できる)。
  );
});
