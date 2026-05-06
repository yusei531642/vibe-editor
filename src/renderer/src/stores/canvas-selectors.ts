/**
 * Canvas store の selector hook 群。
 *
 * `useCanvasStore((s) => s.xxx)` を component から直書きする pattern を集約し、
 * 「どの key を購読しているか」を hook 名から一目で読めるようにする。
 *
 * action 系 (setNodes / addCard / pulseEdge 等) はここに含めない:
 *   - zustand の action 参照は同一 store identity の間 stable なので、selector で
 *     購読する必要が無い (stable identity は再レンダーを引き起こさない)。
 *   - 既存のホットパスがそのまま `useCanvasStore((s) => s.setXxx)` を使い続けても
 *     同じキャッシュ挙動になるため、敢えて hook ラッパーを増やさない。
 */
import { useCanvasStore } from './canvas';
import type { Edge, Node, Viewport } from '@xyflow/react';
import type { CardData, StageView } from './canvas';

export const useCanvasNodes = (): Node<CardData>[] =>
  useCanvasStore((s) => s.nodes);

export const useCanvasEdges = (): Edge[] => useCanvasStore((s) => s.edges);

export const useCanvasViewport = (): Viewport =>
  useCanvasStore((s) => s.viewport);

export const useCanvasTeamLocks = (): Record<string, boolean> =>
  useCanvasStore((s) => s.teamLocks);

export const useCanvasStageView = (): StageView =>
  useCanvasStore((s) => s.stageView);
