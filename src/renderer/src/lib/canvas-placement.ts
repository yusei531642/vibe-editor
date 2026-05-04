import { NODE_H, NODE_W } from '../stores/canvas';

export interface CanvasPoint {
  x: number;
  y: number;
}

export interface CanvasPlacementNode {
  position?: Partial<CanvasPoint>;
  style?: {
    width?: unknown;
    height?: unknown;
  };
  measured?: {
    width?: unknown;
    height?: unknown;
  };
  width?: unknown;
  height?: unknown;
}

export interface BatchPlacementItem {
  position: CanvasPoint;
  width?: number;
  height?: number;
}

export interface BatchPlacementOptions {
  gap?: number;
  fallbackWidth?: number;
  fallbackHeight?: number;
}

interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const DEFAULT_GAP = 32;

function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function positiveDimension(value: unknown, fallback: number): number {
  const parsed = finiteNumber(value);
  return parsed !== null && parsed > 0 ? parsed : fallback;
}

function pointOrNull(position: Partial<CanvasPoint> | undefined): CanvasPoint | null {
  const x = finiteNumber(position?.x);
  const y = finiteNumber(position?.y);
  return x === null || y === null ? null : { x, y };
}

function nodeRect(
  node: CanvasPlacementNode,
  fallbackWidth: number,
  fallbackHeight: number
): Rect | null {
  const position = pointOrNull(node.position);
  if (!position) return null;
  const width = positiveDimension(
    node.style?.width ?? node.measured?.width ?? node.width,
    fallbackWidth
  );
  const height = positiveDimension(
    node.style?.height ?? node.measured?.height ?? node.height,
    fallbackHeight
  );
  return {
    left: position.x,
    top: position.y,
    right: position.x + width,
    bottom: position.y + height
  };
}

function itemRect(item: BatchPlacementItem, fallbackWidth: number, fallbackHeight: number): Rect {
  const width = positiveDimension(item.width, fallbackWidth);
  const height = positiveDimension(item.height, fallbackHeight);
  return {
    left: item.position.x,
    top: item.position.y,
    right: item.position.x + width,
    bottom: item.position.y + height
  };
}

function bounds(rects: Rect[]): Rect {
  return rects.reduce(
    (acc, rect) => ({
      left: Math.min(acc.left, rect.left),
      top: Math.min(acc.top, rect.top),
      right: Math.max(acc.right, rect.right),
      bottom: Math.max(acc.bottom, rect.bottom)
    }),
    rects[0]
  );
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function collides(rect: Rect, existing: Rect[]): boolean {
  return existing.some((item) => overlaps(rect, item));
}

function translateRect(rect: Rect, dx: number, dy: number): Rect {
  return {
    left: rect.left + dx,
    top: rect.top + dy,
    right: rect.right + dx,
    bottom: rect.bottom + dy
  };
}

function normalizeBatch<T extends BatchPlacementItem>(batch: readonly T[]): T[] {
  return batch.map((item) => {
    const x = finiteNumber(item.position.x) ?? 0;
    const y = finiteNumber(item.position.y) ?? 0;
    return { ...item, position: { x, y } } as T;
  });
}

function shiftBatch<T extends BatchPlacementItem>(
  batch: readonly T[],
  dx: number,
  dy: number
): T[] {
  return batch.map(
    (item) =>
      ({
        ...item,
        position: {
          x: item.position.x + dx,
          y: item.position.y + dy
        }
      }) as T
  );
}

/**
 * Move only the new batch when team spawn positions would overlap existing cards.
 * Existing user-arranged nodes are intentionally left untouched.
 */
export function placeBatchAwayFromNodes<T extends BatchPlacementItem>(
  existingNodes: readonly CanvasPlacementNode[],
  batch: readonly T[],
  options: BatchPlacementOptions = {}
): T[] {
  const fallbackWidth = positiveDimension(options.fallbackWidth, NODE_W);
  const fallbackHeight = positiveDimension(options.fallbackHeight, NODE_H);
  const gap = positiveDimension(options.gap, DEFAULT_GAP);
  const normalizedBatch = normalizeBatch(batch);
  if (normalizedBatch.length === 0) return normalizedBatch;

  const existingRects = existingNodes
    .map((node) => nodeRect(node, fallbackWidth, fallbackHeight))
    .filter((rect): rect is Rect => rect !== null);
  if (existingRects.length === 0) return normalizedBatch;

  const batchRect = bounds(
    normalizedBatch.map((item) => itemRect(item, fallbackWidth, fallbackHeight))
  );
  if (!collides(batchRect, existingRects)) return normalizedBatch;

  const occupied = bounds(existingRects);
  const candidates: CanvasPoint[] = [
    { x: occupied.right + gap, y: occupied.top },
    { x: occupied.left, y: occupied.bottom + gap },
    { x: occupied.right + gap, y: occupied.bottom + gap }
  ];

  for (const candidate of candidates) {
    const dx = candidate.x - batchRect.left;
    const dy = candidate.y - batchRect.top;
    if (!collides(translateRect(batchRect, dx, dy), existingRects)) {
      return shiftBatch(normalizedBatch, dx, dy);
    }
  }

  const stepX = fallbackWidth + gap;
  const stepY = fallbackHeight + gap;
  const scanLimit = Math.max(12, existingRects.length + normalizedBatch.length + 6);
  for (let row = 0; row <= scanLimit; row += 1) {
    for (let col = 0; col <= scanLimit; col += 1) {
      const candidate = {
        x: occupied.left + col * stepX,
        y: occupied.top + row * stepY
      };
      const dx = candidate.x - batchRect.left;
      const dy = candidate.y - batchRect.top;
      if (!collides(translateRect(batchRect, dx, dy), existingRects)) {
        return shiftBatch(normalizedBatch, dx, dy);
      }
    }
  }

  return shiftBatch(normalizedBatch, occupied.right + gap - batchRect.left, 0);
}
