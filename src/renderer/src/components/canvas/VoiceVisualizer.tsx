// Issue #825: Voice ボタンの周囲に表示する audio visualizer。
//
// MVP: status のみを props で受け取り、CSS @keyframes で円形リング (3 重) をパルスさせる。
// 本物の AnalyserNode 連動 (= 振幅に応じて伸縮) は Phase 2 で追加予定。
//
// status='connecting': スピナー風 (ゆっくり一定速度で回転)
// status='listening': リングが脈打つ (intensity が高い)
// その他: 何も描かない (mount しない想定)

import type { JSX } from 'react';
import type { VoiceCommandStatus } from '../../../../types/shared';

interface Props {
  status: VoiceCommandStatus;
}

export function VoiceVisualizer({ status }: Props): JSX.Element | null {
  if (status !== 'listening' && status !== 'connecting') {
    return null;
  }
  return (
    <div
      className="voice-visualizer"
      data-status={status}
      aria-hidden="true"
    >
      <span className="voice-visualizer__ring voice-visualizer__ring--1" />
      <span className="voice-visualizer__ring voice-visualizer__ring--2" />
      <span className="voice-visualizer__ring voice-visualizer__ring--3" />
    </div>
  );
}
