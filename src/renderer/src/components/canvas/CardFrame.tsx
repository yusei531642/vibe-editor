/**
 * CardFrame — Canvas 上の全 Card 共通の枠。
 * - ヘッダー: タイトル + 閉じるボタン
 * - ボディ: 子要素 (TerminalView 等を直接埋める)
 * - リサイズハンドルは React Flow の NodeResizer を使う想定 (Phase 4)
 */
import type { CSSProperties, ReactNode } from 'react';
import { NodeResizer } from '@xyflow/react';
import { useConfirmRemoveCard } from '../../lib/use-confirm-remove-card';

// Issue #253 review (#5): カード種別ごとに最小サイズを変えられるよう props で受け取る。
// デフォルトは旧 240x160 (Editor / Diff / FileTree / Changes 等の汎用カードの下限)。
// TerminalCard / AgentNodeCard は明示的に NODE_MIN_W/H (480/280) を渡してターミナル UI
// の見やすさを担保する (それ未満だと Codex/Claude TUI のヘッダーが折り返す)。
const DEFAULT_MIN_W = 240;
const DEFAULT_MIN_H = 160;

interface CardFrameProps {
  id: string;
  title: string;
  accent?: string;
  children: ReactNode;
  /** NodeResizer の最小幅 (default 240) */
  minWidth?: number;
  /** NodeResizer の最小高さ (default 160) */
  minHeight?: number;
}

export function CardFrame({
  id,
  title,
  accent,
  children,
  minWidth = DEFAULT_MIN_W,
  minHeight = DEFAULT_MIN_H
}: CardFrameProps): JSX.Element {
  const confirmRemoveCard = useConfirmRemoveCard();
  const cardStyle = {
    ['--card-accent' as string]: accent ?? '#7a7afd'
  } as CSSProperties;
  return (
    <div
      className="canvas-card-frame"
      style={cardStyle}
    >
      <NodeResizer
        minWidth={minWidth}
        minHeight={minHeight}
        color={accent ?? '#5c5cff'}
        handleStyle={{ width: 8, height: 8, borderRadius: 2 }}
        lineStyle={{ borderWidth: 1 }}
      />
      <header className="canvas-card-frame__header">
        <span className="canvas-card-frame__title-row">
          <span aria-hidden="true" className="canvas-card-frame__accent-dot" />
          <span className="canvas-card-frame__title" title={title}>
            {title}
          </span>
        </span>
        <button
          type="button"
          className="nodrag canvas-card-frame__close"
          onClick={() => confirmRemoveCard(id)}
          title="Close"
        >
          ×
        </button>
      </header>
      <div
        className="nodrag nowheel canvas-card-frame__body"
        // React Flow は親の onMouseDown で node selection / drag 開始を拾うため、
        // body 内のクリックが選択に変換され、内部の xterm が focus を奪えないケースがある。
        // 選択フローを完全に遮断して、クリックはそのまま子 (xterm 等) に届ける。
        onMouseDown={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
