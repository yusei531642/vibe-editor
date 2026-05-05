/**
 * HandoffEdge — team_send の hand-off を可視化するアニメーション付き edge。
 *
 * Rust 側 TeamHub が `team:handoff` event を emit すると、Canvas が一時的に
 * このエッジを追加 → 10 秒で自動 fade out (#379)。
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

  // @keyframes handoff-flow は canvas.css に集約済み (旧実装は edge mount のたびに
  // 同一内容の <style> を吐いていた)。インライン style は色依存ぶんだけ残す。
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
            className="canvas-handoff-edge__label"
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              background: `${color}1a`,
              color,
              border: `1px solid ${color}66`,
              // Glass CSS contract (`.tc__hud` 以外で backdrop-filter 禁止) に従い
              // インライン style 側で blur をかける。一時 edge ラベルなので影響軽微。
              backdropFilter: 'blur(4px)'
            }}
          >
            {preview}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

export default memo(HandoffEdgeImpl);
