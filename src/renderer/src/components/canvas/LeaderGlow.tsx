import { memo } from 'react';

/**
 * LeaderGlow — Canvas 中央に配置するリーダー用ラジアルグロー。
 * Claude Design バンドルの .tc__leader-glow を移植。
 * Canvas viewport transform の外側 (ステージ座標系でなく CSS viewport 中央) に置く。
 *
 * Canvas 全体が再レンダーするたびに <div /> を作り直すコストはゼロに近いが、
 * memo で包んで「props 無し → 親の再レンダーをそのまま素通り」できるようにする。
 */
function LeaderGlowImpl(): JSX.Element {
  return <div className="tc__leader-glow" aria-hidden="true" />;
}

export const LeaderGlow = memo(LeaderGlowImpl);
