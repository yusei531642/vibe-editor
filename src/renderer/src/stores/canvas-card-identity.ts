/**
 * Issue #938: Canvas カードの identity (agentId) 照合と永続化スキーマ。
 *
 * ## カード状態の所有権規約
 *
 * Canvas カードの「位置・サイズ・teamId・agentId・sessionId」は複数の場所に複製されるが、
 * 役割は次のとおり単方向に固定する:
 *
 *   1. **zustand store (`stores/canvas.ts`) が正本 (single source of truth)**。
 *      カードの追加・更新は必ず `addCard` / `addCards` / `setCardPayload` 経由で行う。
 *   2. localStorage persist は store の **キャッシュ** (`PersistedCardNode` スキーマに
 *      明示変換してから保存。React Flow のランタイムフィールドは構造的に持ち込めない)。
 *   3. team-history.json (Rust 経由) は store の **射影 (書込のみ)**。復元時は
 *      `spawnTeam` が射影から `CardSpec` を組み、`addCards` の reconcile が store と照合する。
 *   4. Rust TeamHub / PTY registry は **プロセスのランタイムレジストリ** であり、
 *      カード identity の正本ではない (agentId で突き合わせるだけ)。
 *
 * `addCard` / `addCards` は agentId をキーにした **reconcile (upsert)**: 同 type かつ
 * 同 agentId のカードが既にあれば新規カードを作らず payload を更新して既存 id を返す。
 * これにより resume / preset / recruit 等の「カードを生やす」経路が増えても、
 * 同一 agentId のカード複製 → 同 agent_id 再 spawn → registry の旧 PTY kill (#893)
 * という事故経路が構造的に再生産されない。
 */
import type { Node } from '@xyflow/react';
import { NODE_W, NODE_H } from '../lib/canvas-migrations';
import type { CardData, CardPayloadMap, CardType } from './canvas';

/** agentId を持ちうるカード (agent / terminal) からそれを取り出す。 */
function nodeAgentId(data: CardData | undefined): string | undefined {
  if (!data) return undefined;
  if (data.cardType === 'agent' || data.cardType === 'terminal') {
    return data.payload?.agentId;
  }
  return undefined;
}

/**
 * addCard / addCards の reconcile (upsert) 対象を探す。
 *
 * agentId は PTY registry の識別子であり、「同 agent_id で再 spawn されると旧 PTY を
 * kill + drop する」規約 (#42 / registry.rs) を持つ。同 type + 同 agentId のカードを
 * 二重に生やすと稼働中 PTY の巻き添え kill (#893) になるため、identity 一致時は
 * 新規カードを作らず既存カードへ payload を merge する。
 *
 * agentId を持たないカード (editor / diff / 単発 terminal 等) は対象外 (常に append)。
 */
export function findReconcileTarget(
  nodes: Node<CardData>[],
  type: CardType,
  payload: { agentId?: string } | undefined
): Node<CardData> | undefined {
  if (type !== 'agent' && type !== 'terminal') return undefined;
  const agentId = payload?.agentId;
  if (!agentId) return undefined;
  return nodes.find((n) => n.type === type && nodeAgentId(n.data) === agentId);
}

/**
 * reconcile 時の既存ノード更新。position / size (= ユーザーが今いじっている配置) は
 * 既存値を正とし、title と payload (resumeSessionId / latestHandoff 等の復元コンテキスト)
 * だけを浅く merge する。
 */
export function reconcileCardNode(
  node: Node<CardData>,
  title: string,
  payload: Record<string, unknown> | undefined
): Node<CardData> {
  const prev = (node.data.payload ?? {}) as Record<string, unknown>;
  return {
    ...node,
    data: {
      ...node.data,
      title,
      payload: payload ? ({ ...prev, ...payload } as CardData['payload']) : node.data.payload
    } as CardData
  };
}

/**
 * `addCard` / `addCards` 共通の `Node<CardData>` 生成ヘルパ (Issue #732 から移設)。
 * `type` と `payload` は呼び出し側 (generic / `CardSpec`) で対応付けて渡されるため、
 * 構築する `data` は実体として `CardData` のいずれかの variant。generic `T` を union
 * member へ静的に絞れないので `data` 構築の 1 箇所だけ cast する。
 */
export function makeCardNode<T extends CardType>(
  id: string,
  type: T,
  position: { x: number; y: number },
  title: string,
  payload: CardPayloadMap[T] | undefined
): Node<CardData> {
  return {
    id,
    type,
    position,
    data: { cardType: type, title, payload } as CardData,
    style: { width: NODE_W, height: NODE_H }
  };
}

/** Issue #840: 6 列グリッド上の占有スロットを避け、最初の空き位置を返す。 */
export function nextFallbackCardPosition(nodes: Node<CardData>[]): { x: number; y: number } {
  const cols = 6;
  const stepX = NODE_W + 32;
  const stepY = NODE_H + 32;
  const occupied = new Set(
    nodes.map((node) => `${Math.round(node.position.x)},${Math.round(node.position.y)}`)
  );

  for (let slot = 0; slot <= nodes.length; slot++) {
    const x = (slot % cols) * stepX;
    const y = Math.floor(slot / cols) * stepY;
    if (!occupied.has(`${x},${y}`)) return { x, y };
  }

  return {
    x: ((nodes.length + 1) % cols) * stepX,
    y: Math.floor((nodes.length + 1) / cols) * stepY
  };
}

/**
 * localStorage に保存するカード 1 枚分の宣言的スキーマ (Issue #938)。
 *
 * 旧実装は React Flow のランタイムオブジェクト (`Node<CardData>`) を丸ごと保存しており、
 * `dragging` / `selected` / `measured` 等のランタイムフィールドが永続化境界を越えるたびに
 * 症状別の除外パッチ (#894 / #895) を当てていた。書込側 (`toPersistedCardNode`) で
 * このスキーマへ **明示変換 (pick)** することで、列挙されていないフィールドは型レベルで
 * 永続化不能になる。
 *
 * `width` / `height` (top-level) は NodeResizer の手動リサイズ値で、`style` の既定サイズ
 * より優先される **意図的な** 永続データなので含める。
 */
export interface PersistedCardNode {
  id: string;
  type: CardType;
  position: { x: number; y: number };
  /** NodeResizer の手動リサイズ値。未リサイズなら省略。 */
  width?: number;
  height?: number;
  style?: { width?: number; height?: number };
  data: CardData;
}

/** `Node<CardData>` → `PersistedCardNode` の明示変換 (Issue #938)。 */
export function toPersistedCardNode(n: Node<CardData>): PersistedCardNode {
  const out: PersistedCardNode = {
    id: n.id,
    type: (n.type ?? n.data.cardType) as CardType,
    position: { x: n.position.x, y: n.position.y },
    data: { cardType: n.data.cardType, title: n.data.title, payload: n.data.payload } as CardData
  };
  if (typeof n.width === 'number' && Number.isFinite(n.width)) out.width = n.width;
  if (typeof n.height === 'number' && Number.isFinite(n.height)) out.height = n.height;
  const style = n.style as { width?: unknown; height?: unknown } | undefined;
  if (style) {
    const s: { width?: number; height?: number } = {};
    if (typeof style.width === 'number' && Number.isFinite(style.width)) s.width = style.width;
    if (typeof style.height === 'number' && Number.isFinite(style.height)) {
      s.height = style.height;
    }
    out.style = s;
  }
  return out;
}
