/**
 * Recruit (team_recruit) で新メンバーカードを配置する位置を計算する pure module。
 *
 * Issue #259: 6 名以上は同心円配置を諦め、requester の右側 2 列グリッドに展開する。
 * Issue #569: requester (Leader / HR) が NodeResizer で拡大されている場合でも、
 *   center / radius / grid 起点を「requester の実サイズ」で計算することで新メンバーが
 *   requester の bounding box にめり込まないようにする。子カード自身のサイズは
 *   `addCard` 側で常に NODE_W × NODE_H 固定なので、ここでは requester サイズだけを
 *   動的に扱う (= Leader を拡大しても子は Leader と同じ大きさにしない、を維持)。
 *
 * `use-recruit-listener.ts` から `useEffect` 経由でしか呼ばれないが、tauri / react
 * 依存を持たない pure 関数として切り出すことで vitest から直接 unit test できる。
 * (`canvas-recruit-focus.ts` と同じ分離パターン。)
 */
import type { Node } from '@xyflow/react';
import type { CardData } from '../stores/canvas';
import { NODE_H, NODE_W } from '../stores/canvas';
import { getNodeSize } from './canvas-placement';

/**
 * Issue #259: 同心円配置のマージン。
 *  - 0-3 名: 60 (狭めに、1080p でも fitView せず収まる)
 *  - 4-5 名: 80 (PR #257 と同じ既存挙動を維持)
 */
function recruitMargin(memberCount: number): number {
  return memberCount <= 3 ? 60 : 80;
}

/**
 * Issue #259: 6 名以上 (Leader 含む newMemberCount >= 6) は同心円配置を諦め、
 * requester の右側 2 列グリッドに展開する。
 */
const GRID_PLACEMENT_THRESHOLD = 6;
const GRID_COLS = 2;
const GRID_COL_GAP = 32;
const GRID_ROW_GAP = 32;

/**
 * `window.innerWidth/innerHeight` から radius のキャップを計算する。
 * テストから注入できるよう関数化。
 */
function defaultScreenSize(): number {
  if (typeof window === 'undefined') return Math.max(1920, 1080);
  return Math.max(window.innerWidth || 1920, window.innerHeight || 1080);
}

export interface FindRecruitPositionOptions {
  /** screen-size cap 計算用。テストから注入する。 */
  getScreenSize?: () => number;
}

/** requester の周囲で空いている角度を見つけて配置位置を返す。
 *  既存メンバーの方角をスキャンし、最も空いている角度をピック。
 *
 *  Issue #569: requester (Leader / HR) が NodeResizer で拡大されている場合でも、
 *  `style.width/height` を読んで center / radius / grid の起点を実サイズベースに
 *  計算する。新メンバー側のカードサイズは固定 (NODE_W × NODE_H) のままなので、
 *  Leader を拡大しても子は同サイズにならない。
 */
export function findRecruitPosition(
  requester: Node<CardData>,
  team: Node<CardData>[],
  options: FindRecruitPositionOptions = {}
): { x: number; y: number } {
  const others = team.filter((n) => n.id !== requester.id);
  const newMemberCount = others.length + 1;
  const { width: rW, height: rH } = getNodeSize(requester, NODE_W, NODE_H);

  // Issue #259 / #569: 6 名以上は requester の右側 2 列グリッドに展開。
  // 1 列目の起点を「requester の右端 + GRID_COL_GAP」にすることで、
  // 拡大された requester でも overlap しない。
  if (newMemberCount >= GRID_PLACEMENT_THRESHOLD) {
    const newIdx = others.length; // 0-based new index = 既存 others 数
    const col = newIdx % GRID_COLS;
    const row = Math.floor(newIdx / GRID_COLS);
    return {
      x: requester.position.x + rW + GRID_COL_GAP + (NODE_W + GRID_COL_GAP) * col,
      y: requester.position.y + (NODE_H + GRID_ROW_GAP) * row
    };
  }

  // 通常: 同心円配置 (size-aware 半径)
  const cx = requester.position.x + rW / 2;
  const cy = requester.position.y + rH / 2;
  // requester の外接半径 + 子カードの外接半径 + マージン。
  // これにより requester の bounding box の外側に子の中心が来ることが保証される。
  // 旧挙動 (NODE_W + 60 / NODE_W + 80) は requester=NODE_W×NODE_H のときの
  // requesterOuter + childOuter ≒ NODE_W のケースに一致する設計。
  const requesterOuter = Math.max(rW, rH) / 2;
  const childOuter = Math.max(NODE_W, NODE_H) / 2;
  const margin = recruitMargin(newMemberCount);
  const baseRadius = requesterOuter + childOuter + margin;
  // 既存の screen-size cap (極端な小画面で radius が暴れないようにするガード) は維持。
  // ただし overlap 回避を優先するので、cap は baseRadius を必ず下回らせない
  // (= effectiveCap は baseRadius を絶対下限として clamp する)。
  const screenSize = (options.getScreenSize ?? defaultScreenSize)();
  const cap = Math.max(NODE_W, screenSize * 0.45);
  const effectiveCap = Math.max(cap, baseRadius);
  const radius = Math.min(baseRadius, effectiveCap);

  if (others.length === 0) {
    // 子カードの中心を (cx + radius, cy) に置きたいので、左上座標は子の半サイズ分戻す。
    return {
      x: cx + radius - NODE_W / 2,
      y: cy - NODE_H / 2
    };
  }
  // 既存メンバーの角度を集計 (他メンバーは既定サイズ前提で OK)
  const usedAngles = others.map((n) => {
    const ox = n.position.x + NODE_W / 2;
    const oy = n.position.y + NODE_H / 2;
    return Math.atan2(oy - cy, ox - cx);
  });
  // 12 等分のスロットを試して、最も近い既存メンバーから角度的に最も離れた slot を選ぶ
  const SLOTS = 12;
  let bestAngle = 0;
  let bestDist = -1;
  for (let i = 0; i < SLOTS; i++) {
    const a = (i / SLOTS) * Math.PI * 2 - Math.PI / 2; // 上から時計回り
    const minDistToUsed = usedAngles.reduce((min, u) => {
      const d = Math.min(
        Math.abs(a - u),
        Math.abs(a - u + Math.PI * 2),
        Math.abs(a - u - Math.PI * 2)
      );
      return Math.min(min, d);
    }, Number.POSITIVE_INFINITY);
    if (minDistToUsed > bestDist) {
      bestDist = minDistToUsed;
      bestAngle = a;
    }
  }
  return {
    x: cx + Math.cos(bestAngle) * radius - NODE_W / 2,
    y: cy + Math.sin(bestAngle) * radius - NODE_H / 2
  };
}
