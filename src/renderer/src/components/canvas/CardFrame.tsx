/**
 * CardFrame — Canvas 上の全 Card 共通の枠。
 * - ヘッダー: タイトル + 閉じるボタン
 * - ボディ: 子要素 (TerminalView 等を直接埋める)
 * - リサイズハンドルは React Flow の NodeResizer を使う想定 (Phase 4)
 */
import type { ReactNode } from 'react';
import { NodeResizer } from '@xyflow/react';
import { useConfirmRemoveCard } from '../../lib/use-confirm-remove-card';
import { NODE_MIN_W, NODE_MIN_H } from '../../stores/canvas';

interface CardFrameProps {
  id: string;
  title: string;
  accent?: string;
  children: ReactNode;
}

export function CardFrame({ id, title, accent, children }: CardFrameProps): JSX.Element {
  const confirmRemoveCard = useConfirmRemoveCard();
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
        overflow: 'hidden'
        // boxShadow は付けない。
        // React Flow viewport の `transform: scale()` 配下で
        // `overflow:hidden + border-radius + box-shadow` が揃うと Chromium が
        // 合成レイヤを作って xterm DOM テキストごとビットマップ化し、
        // ズーム時にバイリニア補間で滲む。border だけで十分。
      }}
    >
      <NodeResizer
        minWidth={NODE_MIN_W}
        minHeight={NODE_MIN_H}
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
          onClick={() => confirmRemoveCard(id)}
          style={{
            // 旧 padding 2/6 + font 14 は押しにくかったので 28x28 のヒット領域に拡大
            width: 28,
            height: 28,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'transparent',
            border: 0,
            borderRadius: 6,
            color: 'var(--fg-muted, #a8a8b8)',
            cursor: 'pointer',
            fontSize: 18,
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
