/**
 * LeaderGlow — Canvas 中央に配置するリーダー用ラジアルグロー。
 * Claude Design バンドルの .tc__leader-glow を移植。
 * Canvas viewport transform の外側 (ステージ座標系でなく CSS viewport 中央) に置く。
 */
export function LeaderGlow(): JSX.Element {
  return <div className="tc__leader-glow" aria-hidden="true" />;
}
