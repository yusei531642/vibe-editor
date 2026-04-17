/**
 * HandoffEdge — team_send の hand-off を可視化するアニメーション付き edge。
 *
 * Rust 側 TeamHub が `team:handoff` event を emit すると、Canvas が一時的に
 * このエッジを追加 → 1.5 秒で自動 fade out。
 *
 * 表現:
 *   - bezier path
 *   - 線色は from ノード (発信者) のロールカラー
 *   - 点線アニメで粒子が「流れる」エフェクト (stroke-dasharray + animation)
 *   - メッセージ preview を edge label として中央に表示 (短縮)
 */
import { memo } from 'react';
import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from '@xyflow/react';

export interface HandoffEdgeData extends Record<string, unknown> {
  color?: string;
  preview?: string;
  fromRole?: string;
}

function HandoffEdgeImpl({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data
}: EdgeProps): JSX.Element {
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition
  });
  const d = data as HandoffEdgeData | undefined;
  const color = d?.color ?? '#7a7afd';
  const preview = d?.preview ?? '';

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        style={{
          stroke: color,
          strokeWidth: 2.5,
          strokeDasharray: '6 8',
          filter: `drop-shadow(0 0 6px ${color}88)`,
          animation: 'handoff-flow 0.8s linear infinite'
        }}
      />
      {preview && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              background: `${color}1a`,
              color,
              padding: '2px 8px',
              borderRadius: 6,
              fontSize: 10,
              border: `1px solid ${color}66`,
              maxWidth: 240,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              pointerEvents: 'none',
              fontFamily: "'Inter', sans-serif",
              backdropFilter: 'blur(4px)'
            }}
          >
            {preview}
          </div>
        </EdgeLabelRenderer>
      )}
      <style>{`
        @keyframes handoff-flow {
          to { stroke-dashoffset: -14; }
        }
      `}</style>
    </>
  );
}

export default memo(HandoffEdgeImpl);
