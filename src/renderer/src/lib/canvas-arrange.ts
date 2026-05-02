/**
 * Issue #369: Canvas モードの terminal / agent カードを「一括整理整頓」する純粋関数。
 *
 * 整列対象は `terminal` と `agent` (どちらも内部に TerminalView を抱える) に限定し、
 * editor / diff / fileTree / changes は触らない。ノード id / data / payload は維持し、
 * `position` と `style.width/height` だけを書き換えるので、内蔵 PTY が再生成される
 * リスクは無い。
 */
import type { Node } from '@xyflow/react';
import type { CardData, CardType } from '../stores/canvas';
import { NODE_W, NODE_H } from '../stores/canvas';

export type ArrangeGap = 'tight' | 'normal' | 'wide';

export const ARRANGE_GAP_PX: Record<ArrangeGap, number> = {
  tight: 24,
  normal: 32,
  wide: 48
};

const TERMINAL_LIKE: ReadonlySet<CardType> = new Set<CardType>(['terminal', 'agent']);

export function isTerminalLike(node: Node<CardData>): boolean {
  const t = (node.type ?? node.data?.cardType) as CardType | undefined;
  return t !== undefined && TERMINAL_LIKE.has(t);
}

/** sqrt 基準で列数を決定。少数ノードでも過剰横長にならないようにする。 */
export function computeColumns(count: number): number {
  if (count <= 0) return 1;
  return Math.max(1, Math.ceil(Math.sqrt(count)));
}

interface ArrangeOptions {
  /** ピッチ (cards 間 gap) */
  gap?: ArrangeGap;
  /** カード幅 */
  width?: number;
  /** カード高さ */
  height?: number;
}

/**
 * `tidy`: terminal-like ノードを起点 (左上の最小 x/y) から grid 配置し、
 * size と position を統一する。非 terminal-like は元のまま返す。
 */
export function tidyTerminals(
  nodes: Node<CardData>[],
  options: ArrangeOptions = {}
): Node<CardData>[] {
  const width = options.width ?? NODE_W;
  const height = options.height ?? NODE_H;
  const gap = ARRANGE_GAP_PX[options.gap ?? 'normal'];

  const targets = nodes.filter(isTerminalLike);
  if (targets.length === 0) return nodes;

  const originX = Math.min(...targets.map((n) => n.position.x));
  const originY = Math.min(...targets.map((n) => n.position.y));
  const cols = computeColumns(targets.length);

  // 元の左→右、上→下の順を尊重して並べ替えてから grid に埋める
  const sorted = [...targets].sort((a, b) => {
    if (a.position.y !== b.position.y) return a.position.y - b.position.y;
    return a.position.x - b.position.x;
  });
  const orderById = new Map<string, number>();
  sorted.forEach((n, i) => orderById.set(n.id, i));

  return nodes.map((n) => {
    if (!isTerminalLike(n)) return n;
    const idx = orderById.get(n.id) ?? 0;
    const col = idx % cols;
    const row = Math.floor(idx / cols);
    return {
      ...n,
      position: {
        x: originX + col * (width + gap),
        y: originY + row * (height + gap)
      },
      style: {
        ...(n.style ?? {}),
        width,
        height
      }
    };
  });
}

/**
 * `unifySize`: 位置はそのままで terminal-like ノードのサイズだけを統一する。
 */
export function unifyTerminalSize(
  nodes: Node<CardData>[],
  options: Pick<ArrangeOptions, 'width' | 'height'> = {}
): Node<CardData>[] {
  const width = options.width ?? NODE_W;
  const height = options.height ?? NODE_H;
  let touched = false;
  const next = nodes.map((n) => {
    if (!isTerminalLike(n)) return n;
    touched = true;
    return {
      ...n,
      style: {
        ...(n.style ?? {}),
        width,
        height
      }
    };
  });
  return touched ? next : nodes;
}
