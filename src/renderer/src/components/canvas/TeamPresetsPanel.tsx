/**
 * TeamPresetsPanel — Issue #522.
 *
 * Canvas 上で「うまくいったチーム編成」を `~/.vibe-editor/presets/<id>.json` に保存し、
 * 別タイミングで 1 操作で再構築できるようにする小型 popover panel。
 *
 * 構成:
 *   - 上部: 「現在のチームを preset として保存」フォーム (展開式)
 *   - 中部: 保存済 preset の一覧 (各エントリで Apply / Delete)
 *   - 下部: 空状態メッセージ
 *
 * Apply は canvasStore.addCards で agent カードを順次配置するだけの最小実装。
 * Leader の team_recruit を自動で叩くフロー (plan の Step 4) は別 issue で扱う。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Hand, Plus, Save, Trash2 } from 'lucide-react';
import { useT } from '../../lib/i18n';
import { useToast } from '../../lib/toast-context';
import { useCanvasNodes } from '../../stores/canvas-selectors';
import { useCanvasStore, NODE_W, NODE_H, type CardData } from '../../stores/canvas';
import type {
  TeamPreset,
  TeamPresetLayoutEntry,
  TeamPresetRole
} from '../../../../types/shared';
import type {
  AgentPayload
} from './cards/AgentNodeCard/types';

interface TeamPresetsPanelProps {
  open: boolean;
  onClose: () => void;
}

/**
 * `crypto.randomUUID()` を使った id 生成。Tauri WebView2 / 主要ブラウザで利用可能。
 * Rust 側 `is_safe_id` (英数 + `-` + `_` 限定 / 1〜128 文字) を満たす形に整形する。
 */
function newPresetId(): string {
  // crypto.randomUUID は `8-4-4-4-12` 形式の英数 + `-` のみで Rust 側のバリデートに通る。
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return `pst-${(crypto as Crypto & { randomUUID(): string }).randomUUID()}`;
  }
  // フォールバック: Date + Math.random で衝突しづらい id。最悪ケースの保険。
  const rnd = Math.random().toString(36).slice(2, 10);
  return `pst-${Date.now().toString(36)}-${rnd}`;
}

/**
 * Canvas 上の現在の agent カードから 1 件の preset 雛形を組み立てる。
 * roles は store の出現順、layout は (x,y,w,h) を roleProfileId キーで保持する。
 */
function buildPresetFromCanvas(
  agentNodes: ReturnType<typeof useCanvasNodes>,
  name: string,
  description: string
): TeamPreset {
  const roles: TeamPresetRole[] = [];
  const layout: Record<string, TeamPresetLayoutEntry> = {};
  let agents: Array<'claude' | 'codex' | 'mixed'> = [];
  for (const node of agentNodes) {
    const data = node.data as CardData | undefined;
    if (data?.cardType !== 'agent') continue;
    const payload = data.payload as AgentPayload | undefined;
    const roleProfileId = payload?.roleProfileId ?? payload?.role ?? '';
    if (!roleProfileId) continue;
    const agent = (payload?.agent ?? 'claude') as 'claude' | 'codex';
    agents.push(agent);
    roles.push({
      roleProfileId,
      agent,
      label: typeof data.title === 'string' ? data.title : null,
      customInstructions:
        payload?.customInstructions ?? payload?.codexInstructions ?? null
    });
    // 同 roleProfileId が複数あった場合、最後のものが上書きされる (preset では今回未対応)。
    layout[roleProfileId] = {
      x: node.position.x,
      y: node.position.y,
      width: typeof node.style?.width === 'number' ? node.style.width : null,
      height: typeof node.style?.height === 'number' ? node.style.height : null
    };
  }
  // engine_policy: 全部 claude / 全部 codex / 混在
  const uniqueAgents = new Set(agents);
  const enginePolicy: TeamPreset['enginePolicy'] =
    uniqueAgents.size === 1
      ? (agents[0] ?? 'claude')
      : 'mixed';
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    id: newPresetId(),
    name: name.trim(),
    description: description.trim() || null,
    createdAt: now,
    updatedAt: now,
    enginePolicy,
    roles,
    layout: Object.keys(layout).length > 0 ? { byRole: layout } : null
  };
}

export function TeamPresetsPanel({ open, onClose }: TeamPresetsPanelProps): JSX.Element | null {
  const t = useT();
  const { showToast } = useToast();
  const allNodes = useCanvasNodes();
  const addCards = useCanvasStore((s) => s.addCards);
  const agentNodes = useMemo(
    () => allNodes.filter((n) => n.type === 'agent'),
    [allNodes]
  );
  const [presets, setPresets] = useState<TeamPreset[]>([]);
  const [loading, setLoading] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [draftDescription, setDraftDescription] = useState('');

  // open 時に preset 一覧をリロード。Rust 側はディレクトリ走査だけなので軽量。
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    void window.api.teamPresets
      .list()
      .then((list) => {
        if (cancelled) return;
        setPresets(list);
      })
      .catch((err) => {
        console.warn('[team-presets] list failed:', err);
        if (!cancelled) {
          showToast(t('preset.error.listFailed'), { tone: 'error', duration: 6000 });
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, showToast, t]);

  // 外クリック / Escape ハンドリングは「ボタン + popover」を内包する親 (StageHud 側の
  // `.tc__hud-presets` ref) で実施する。本コンポーネント内に持つと、トグルボタン押下の
  // pointerdown が「外クリック扱い→close」に解釈され、続く onClick で再 open される
  // 競合 (open→close→open のチラつき) になるため、判定責務を親へ委譲する。

  const handleSaveCurrent = useCallback(() => {
    if (agentNodes.length === 0) {
      showToast(t('preset.error.empty'), { tone: 'error', duration: 6000 });
      return;
    }
    if (!draftName.trim()) {
      showToast(t('preset.error.noName'), { tone: 'error', duration: 6000 });
      return;
    }
    const preset = buildPresetFromCanvas(agentNodes, draftName, draftDescription);
    void window.api.teamPresets
      .save(preset)
      .then((res) => {
        if (!res.ok || !res.preset) {
          throw new Error(res.error ?? 'save failed');
        }
        showToast(t('preset.saved', { name: res.preset.name }), {
          tone: 'success',
          duration: 6000
        });
        setPresets((prev) => {
          const without = prev.filter((p) => p.id !== res.preset!.id);
          return [res.preset!, ...without];
        });
        setSaveOpen(false);
        setDraftName('');
        setDraftDescription('');
      })
      .catch((err) => {
        const detail = err instanceof Error ? err.message : String(err);
        showToast(t('preset.error.saveFailed', { detail }), {
          tone: 'error',
          duration: 8000
        });
      });
  }, [agentNodes, draftDescription, draftName, showToast, t]);

  const handleApply = useCallback(
    (preset: TeamPreset) => {
      // layout が無いときの cascading 配置: 既存カードと重ならないよう右下に並べる。
      const baseX = 60;
      const baseY = 60;
      const stride = NODE_W + 40;
      const cards = preset.roles.map((role, idx) => {
        const layoutEntry = preset.layout?.byRole[role.roleProfileId];
        const position = layoutEntry
          ? { x: layoutEntry.x, y: layoutEntry.y }
          : { x: baseX + (idx % 4) * stride, y: baseY + Math.floor(idx / 4) * (NODE_H + 40) };
        const payload: AgentPayload = {
          agent: role.agent === 'codex' ? 'codex' : 'claude',
          roleProfileId: role.roleProfileId,
          customInstructions: role.customInstructions ?? undefined
        };
        return {
          type: 'agent' as const,
          title: role.label ?? role.roleProfileId,
          payload: payload as unknown,
          position
        };
      });
      const ids = addCards(cards);
      showToast(
        t('preset.applied', { name: preset.name, count: ids.length }),
        { tone: 'success', duration: 5000 }
      );
      onClose();
    },
    [addCards, onClose, showToast, t]
  );

  const handleDelete = useCallback(
    (preset: TeamPreset) => {
      void window.api.teamPresets
        .delete(preset.id)
        .then((res) => {
          if (!res.ok) {
            throw new Error(res.error ?? 'delete failed');
          }
          setPresets((prev) => prev.filter((p) => p.id !== preset.id));
          showToast(t('preset.deleted', { name: preset.name }), {
            tone: 'success',
            duration: 4000
          });
        })
        .catch((err) => {
          const detail = err instanceof Error ? err.message : String(err);
          showToast(t('preset.error.deleteFailed', { detail }), {
            tone: 'error',
            duration: 8000
          });
        });
    },
    [showToast, t]
  );

  if (!open) return null;

  return (
    <div
      className="tc__preset-panel glass-surface"
      role="dialog"
      aria-label={t('preset.title')}
    >
      <div className="tc__preset-panel-header">
        <span className="tc__preset-panel-title">{t('preset.title')}</span>
        <button
          type="button"
          className="tc__preset-panel-close"
          onClick={onClose}
          aria-label={t('common.close')}
          title={t('common.close')}
        >
          ×
        </button>
      </div>

      <div className="tc__preset-panel-section">
        {!saveOpen ? (
          <button
            type="button"
            className="tc__preset-panel-action"
            onClick={() => setSaveOpen(true)}
            disabled={agentNodes.length === 0}
            title={
              agentNodes.length === 0
                ? t('preset.error.empty')
                : t('preset.saveCurrent.tooltip')
            }
          >
            <Plus size={13} strokeWidth={2} />
            <span>{t('preset.saveCurrent')}</span>
          </button>
        ) : (
          <div className="tc__preset-panel-form">
            <input
              type="text"
              placeholder={t('preset.namePlaceholder')}
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              aria-label={t('preset.name')}
              autoFocus
            />
            <textarea
              placeholder={t('preset.descriptionPlaceholder')}
              value={draftDescription}
              onChange={(e) => setDraftDescription(e.target.value)}
              aria-label={t('preset.description')}
              rows={2}
            />
            <div className="tc__preset-panel-form-actions">
              <button
                type="button"
                className="tc__preset-panel-action tc__preset-panel-action--primary"
                onClick={handleSaveCurrent}
              >
                <Save size={13} strokeWidth={2} />
                <span>{t('preset.save')}</span>
              </button>
              <button
                type="button"
                className="tc__preset-panel-action"
                onClick={() => {
                  setSaveOpen(false);
                  setDraftName('');
                  setDraftDescription('');
                }}
              >
                {t('common.cancel')}
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="tc__preset-panel-list" role="list">
        {loading ? (
          <div className="tc__preset-panel-empty">{t('preset.loading')}</div>
        ) : presets.length === 0 ? (
          <div className="tc__preset-panel-empty">{t('preset.empty')}</div>
        ) : (
          presets.map((preset) => (
            <div key={preset.id} className="tc__preset-panel-item" role="listitem">
              <div className="tc__preset-panel-item-meta">
                <span className="tc__preset-panel-item-name">{preset.name}</span>
                <span className="tc__preset-panel-item-roles">
                  {t('preset.roleCount', { count: preset.roles.length })}
                  {' · '}
                  {preset.enginePolicy}
                </span>
              </div>
              <div className="tc__preset-panel-item-actions">
                <button
                  type="button"
                  className="tc__preset-panel-action tc__preset-panel-action--primary"
                  onClick={() => handleApply(preset)}
                  title={t('preset.apply.tooltip')}
                >
                  <Hand size={12} strokeWidth={2} />
                  <span>{t('preset.apply')}</span>
                </button>
                <button
                  type="button"
                  className="tc__preset-panel-action tc__preset-panel-action--danger"
                  onClick={() => handleDelete(preset)}
                  title={t('preset.delete.tooltip')}
                  aria-label={t('preset.delete')}
                >
                  <Trash2 size={12} strokeWidth={2} />
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
