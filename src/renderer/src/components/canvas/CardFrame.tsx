/**
 * CardFrame — Canvas 上の全 Card 共通の枠。
 * - ヘッダー: タイトル + 閉じるボタン
 * - ボディ: 子要素 (TerminalView 等を直接埋める)
 * - リサイズハンドルは React Flow の NodeResizer を使う想定 (Phase 4)
 */
import type { ReactNode } from 'react';
import { NodeResizer } from '@xyflow/react';
import { useCanvasStore } from '../../stores/canvas';

interface CardFrameProps {
  id: string;
  title: string;
  accent?: string;
  children: ReactNode;
}

export function CardFrame({ id, title, accent, children }: CardFrameProps): JSX.Element {
  const removeCard = useCanvasStore((s) => s.removeCard);
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--bg-elevated, #16161c)',
        border: `1px solid ${accent ?? 'var(--border, #2a2a35)'}`,
        borderRadius: 8,
        overflow: 'hidden',
        boxShadow: '0 8px 24px rgba(0,0,0,0.35)'
      }}
    >
      <NodeResizer
        minWidth={240}
        minHeight={160}
        color={accent ?? '#5c5cff'}
        handleStyle={{ width: 8, height: 8, borderRadius: 2 }}
        lineStyle={{ borderWidth: 1 }}
      />
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '6px 10px',
          background: 'var(--bg-deep, #0d0d12)',
          borderBottom: '1px solid var(--border, #2a2a35)',
          fontSize: 12,
          color: 'var(--fg-muted, #a8a8b8)',
          userSelect: 'none',
          cursor: 'grab'
        }}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: accent ?? '#7a7afd'
            }}
          />
          {title}
        </span>
        <button
          type="button"
          className="nodrag"
          onClick={() => removeCard(id)}
          style={{
            background: 'transparent',
            border: 0,
            color: 'var(--fg-muted, #a8a8b8)',
            cursor: 'pointer',
            padding: '2px 6px',
            fontSize: 14,
            lineHeight: 1
          }}
          title="Close"
        >
          ×
        </button>
      </header>
      <div
        className="nodrag nowheel"
        // React Flow は親の onMouseDown で node selection / drag 開始を拾うため、
        // body 内のクリックが選択に変換され、内部の xterm が focus を奪えないケースがある。
        // 選択フローを完全に遮断して、クリックはそのまま子 (xterm 等) に届ける。
        onMouseDown={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
        style={{
          flex: 1,
          minHeight: 0,
          minWidth: 0,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          position: 'relative'
        }}
      >
        {children}
      </div>
    </div>
  );
}
