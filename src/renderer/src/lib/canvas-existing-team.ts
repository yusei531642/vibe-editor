import type { Node } from '@xyflow/react';
import { cardTeamId, type CardData } from '../stores/canvas';

/**
 * Issue #893: Recent Teams から同じ teamId を再開しようとした時に、
 * 新しいカードを増やさず既存カードへフォーカスするための検出ヘルパ。
 */
export function findExistingTeamNode(
  nodes: readonly Node<CardData>[],
  teamId: string
): Node<CardData> | undefined {
  return nodes.find((node) => cardTeamId(node.data) === teamId);
}
