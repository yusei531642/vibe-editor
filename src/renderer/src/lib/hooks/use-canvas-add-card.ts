import type { Node } from '@xyflow/react';
import type { CardData, CardType } from '../../stores/canvas';
import { useCanvasStore } from '../../stores/canvas';
import { nextFallbackCardPosition } from '../../stores/canvas-card-identity';
import { useUiStore } from '../../stores/ui';
import { engineForAgentConfig } from '../agent-registry';
import { useSettings } from '../settings-context';
import { useToast } from '../toast-context';
import { useT } from '../i18n';
import { parseCustomAgentArgs } from '../parse-args';

interface UseCanvasAddCardOptions {
  /** drag-settled な nodes スナップショット (CanvasLayout が所有, Issue #124) */
  nodes: Node<CardData>[];
  projectRoot: string;
}

export interface CanvasAddCardApi {
  /** 既存ノードが占有していない staggered 配置座標を返す */
  stagger: (kind: CardType) => { x: number; y: number };
  addAgent: (agent: 'claude' | 'codex') => void;
  addCustomAgent: (agentId: string) => void;
  addApiAgent: () => void;
  addByType: (type: Exclude<CardType, 'terminal' | 'agent' | 'apiAgent'>) => void;
}

/**
 * Canvas への単体カード追加 (agent / custom agent / API agent / editor 等) を所有する hook。
 * Issue #1032: CanvasLayout の god-file 分割で切り出し。配置座標 (stagger) の
 * 不変条件 (NODE_W/NODE_H ピッチの 6 列グリッド, Issue #442) はこのモジュールに閉じる。
 */
export function useCanvasAddCard({ nodes, projectRoot }: UseCanvasAddCardOptions): CanvasAddCardApi {
  const addCards = useCanvasStore((s) => s.addCards);
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen);
  const { settings } = useSettings();
  const { showToast } = useToast();
  const t = useT();

  const cardCounter = (type: CardType): number => nodes.filter((n) => n.type === type).length + 1;

  // Issue #166: Date.now() % 600 だと連続クリックで数 ms 差しか出ず、全カードが
  // ほぼ同じ x に積み重なって UI 上「追加されていない」ように見えていた。
  // 既存ノード (現在 viewport 内に限らずグローバル) の空き位置を6列グリッドから返す。
  // Issue #442: 旧実装は agent/terminal を 480+32 / 320+32、その他を 360+32 / 240+32 で
  // 並べていたが、addCard / addCards は全 type に NODE_W/NODE_H (= 640x400, Issue #253)
  // を style として付与するため、type 別ピッチは根拠が無くカードが重なっていた。
  // Issue #1141: nodes.length採番では削除後に既存slotへ重なるため、store fallbackと
  // 同じ占有スロット探索を使う。kindに関係なく全カードは同じ既定寸法/ピッチを共有する。
  const stagger = (_kind: CardType): { x: number; y: number } =>
    nextFallbackCardPosition(nodes);

  const addAgent = (agent: 'claude' | 'codex'): void => {
    const cwd = projectRoot;
    const n = cardCounter('agent');
    addCards([
      {
        type: 'agent',
        title: agent === 'codex' ? `Codex #${n}` : `Claude #${n}`,
        position: stagger('agent'),
        payload: { agent, role: 'leader', cwd }
      }
    ]);
  };

  // Issue #1117: 登録済みの任意 custom agent (CLI/API) を id 指定で Canvas に単体追加する。
  //   CLI は engine + agentConfigId + command/args を伝搬し (custom が Claude に偽装されない)、
  //   API は apiAgent カードを生成する。未登録 id は設定モーダルへ誘導する。
  const addCustomAgent = (agentId: string): void => {
    const cfg = (settings.customAgents ?? []).find((a) => a.id === agentId);
    if (!cfg) {
      setSettingsOpen(true);
      return;
    }
    const cwd = projectRoot;
    if (cfg.runtime === 'api') {
      addCards([
        {
          type: 'apiAgent',
          title: cfg.name,
          position: stagger('apiAgent'),
          payload: {
            agentId: cfg.id,
            agentConfigId: cfg.id,
            providerId: cfg.providerId,
            model: cfg.model,
            toolMode: cfg.toolMode ?? 'auto',
            configured: true
          }
        }
      ]);
    } else {
      const engine = engineForAgentConfig(cfg);
      const customArgs = parseCustomAgentArgs(cfg.args);
      customArgs.warnings.forEach((w) => showToast(t(w.messageKey, w.params), { tone: 'warning' }));
      addCards([
        {
          type: 'agent',
          title: cfg.name,
          position: stagger('agent'),
          payload: {
            agent: engine,
            agentConfigId: cfg.id,
            command: cfg.command || undefined,
            args: cfg.args ? customArgs.args : undefined,
            cwd,
            role: 'leader'
          }
        }
      ]);
    }
  };

  const addApiAgent = (): void => {
    const apiAgent = (settings.customAgents ?? []).find((a) => a.runtime === 'api');
    if (!apiAgent || apiAgent.runtime !== 'api') {
      setSettingsOpen(true);
      return;
    }
    addCards([
      {
        type: 'apiAgent',
        title: apiAgent.name,
        position: stagger('apiAgent'),
        payload: {
          agentId: apiAgent.id,
          providerId: apiAgent.providerId,
          model: apiAgent.model,
          toolMode: apiAgent.toolMode ?? 'auto',
          configured: true
        }
      }
    ]);
  };

  const addByType = (type: Exclude<CardType, 'terminal' | 'agent' | 'apiAgent'>): void => {
    const cwd = projectRoot;
    if (type === 'editor') {
      addCards([{
        type,
        title: t('canvas.card.editor'),
        position: stagger(type),
        payload: { projectRoot: cwd, relPath: '' }
      }]);
    } else if (type === 'diff') {
      addCards([{
        type,
        title: 'Diff',
        position: stagger(type),
        payload: { projectRoot: cwd, relPath: '' }
      }]);
    } else if (type === 'fileTree') {
      addCards([{
        type,
        title: t('sidebar.files'),
        position: stagger(type),
        payload: { projectRoot: cwd }
      }]);
    } else {
      addCards([{
        type,
        title: t('sidebar.changes'),
        position: stagger(type),
        payload: { projectRoot: cwd }
      }]);
    }
  };

  return { stagger, addAgent, addCustomAgent, addApiAgent, addByType };
}
