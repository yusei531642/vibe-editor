import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Bookmark,
  CheckCircle2,
  CircleDot,
  ClipboardList,
  Hourglass,
  LayoutGrid,
  List,
  Maximize2,
  Ruler,
  Skull,
  Users,
  ZoomIn,
  ZoomOut
} from 'lucide-react';
import { useReactFlow } from '@xyflow/react';
import { useT } from '../../lib/i18n';
import { useSettings } from '../../lib/settings-context';
import { useCanvasStore, type StageView, type CardData } from '../../stores/canvas';
import { useCanvasNodes, useCanvasStageView } from '../../stores/canvas-selectors';
import { useAgentActivityStore } from '../../stores/agent-activity';
import {
  aggregateTeamSummary,
  type CardSummary
} from '../../lib/agent-summary';
import { useTeamHealthMulti } from '../../lib/use-team-health';
import { deriveHealth } from '../../lib/agent-health';
import { TeamPresetsPanel } from './TeamPresetsPanel';
import { TeamDashboard } from './TeamDashboard';
import type { AgentPayload } from './cards/AgentNodeCard/types';
import type { ArrangeGap } from '../../lib/canvas-arrange';

/**
 * StageHud — Canvas 中央下部のガラス調ピル HUD。
 * Claude Design バンドルの .tc__hud を移植。
 * view 切替 (Stage / List / Focus) + fit + zoom in/out + arrange を含む。
 *
 * Issue #369: 整理ボタンを追加。占有を増やさないため通常時は 1 ボタンのみ表示し、
 * クリックで小さなポップオーバーを開いて 整頓 / サイズ統一 / 間隔 (Tight/Normal/Wide) を選ぶ。
 */
export function StageHud(): JSX.Element {
  const t = useT();
  const stageView = useCanvasStageView();
  const setStageView = useCanvasStore((s) => s.setStageView);
  const arrangeGap = useCanvasStore((s) => s.arrangeGap);
  const setArrangeGap = useCanvasStore((s) => s.setArrangeGap);
  const tidyTerminalCards = useCanvasStore((s) => s.tidyTerminalCards);
  const unifyTerminalCardSize = useCanvasStore((s) => s.unifyTerminalCardSize);
  const { fitView, zoomIn, zoomOut } = useReactFlow();

  const [arrangeOpen, setArrangeOpen] = useState(false);
  const arrangeWrapRef = useRef<HTMLDivElement | null>(null);
  // Issue #522: team preset panel toggle. arrange popover とは独立。
  const [presetsOpen, setPresetsOpen] = useState(false);
  const presetsWrapRef = useRef<HTMLDivElement | null>(null);
  // Issue #514: team dashboard panel toggle.
  const [dashboardOpen, setDashboardOpen] = useState(false);
  const dashboardWrapRef = useRef<HTMLDivElement | null>(null);

  // ポップオーバー外クリック / Escape で閉じる
  useEffect(() => {
    if (!arrangeOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!arrangeWrapRef.current) return;
      if (!arrangeWrapRef.current.contains(e.target as Node)) {
        setArrangeOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setArrangeOpen(false);
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [arrangeOpen]);

  // Issue #514: dashboard も同じく親 ref で外クリック判定 (#522 同パターン)。
  useEffect(() => {
    if (!dashboardOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!dashboardWrapRef.current) return;
      if (!dashboardWrapRef.current.contains(e.target as Node)) {
        setDashboardOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDashboardOpen(false);
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [dashboardOpen]);

  // Issue #522: presets popover も同じく「ボタン + popover」を内包する親 ref で
  // 外クリック判定する。子コンポーネント (TeamPresetsPanel) 側で同じ処理をすると、
  // toggle ボタン押下の pointerdown が「外クリック扱い→close」 → onClick で再 open
  // という競合が起きるため、判定責務を親 (HUD) に集約する。
  useEffect(() => {
    if (!presetsOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!presetsWrapRef.current) return;
      if (!presetsWrapRef.current.contains(e.target as Node)) {
        setPresetsOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPresetsOpen(false);
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [presetsOpen]);

  // 翻訳結果の配列は `t` 依存。zustand store 変化 (stageView / arrangeGap) のたびに
  // 配列リテラル + JSX を作り直すと map 配下の Lucide アイコン (memo されない子) も
  // 全て新しい props で識別され、Chrome DevTools React profiler 上で目立つ flicker
  // 要因になる。t を使うので useMemo で `t` 同一 → 同一参照にする。
  const views = useMemo<Array<{ id: StageView; label: string; tip: string; icon: JSX.Element }>>(
    () => [
      {
        id: 'stage',
        label: t('canvas.hud.stage'),
        tip: t('canvas.hud.stage.tooltip'),
        icon: <Users size={12} strokeWidth={2} />
      },
      {
        id: 'list',
        label: t('canvas.hud.list'),
        tip: t('canvas.hud.list.tooltip'),
        icon: <List size={12} strokeWidth={2} />
      },
      {
        id: 'focus',
        label: t('canvas.hud.focus'),
        tip: t('canvas.hud.focus.tooltip'),
        icon: <Maximize2 size={12} strokeWidth={2} />
      }
    ],
    [t]
  );

  const gaps = useMemo<Array<{ id: ArrangeGap; label: string }>>(
    () => [
      { id: 'tight', label: t('canvas.hud.arrange.gap.tight') },
      { id: 'normal', label: t('canvas.hud.arrange.gap.normal') },
      { id: 'wide', label: t('canvas.hud.arrange.gap.wide') }
    ],
    [t]
  );

  // Issue #521: Canvas 全体の状態 (active / blocked / stale / completed) を 1 行で見せる。
  // 0 件のときは表示しない (HUD が肥大化しない)。集計は agent-activity store + canvas store
  // を購読して派生する純粋関数 aggregateTeamSummary に委譲。
  const allNodes = useCanvasNodes();
  const agentNodes = useMemo(
    () => allNodes.filter((n) => n.type === 'agent'),
    [allNodes]
  );
  const cardSummariesByCard = useAgentActivityStore((s) => s.byCard);
  const cardSummaries = useMemo<Record<string, CardSummary>>(() => {
    const out: Record<string, CardSummary> = {};
    for (const [cardId, runtime] of Object.entries(cardSummariesByCard)) {
      if (runtime.summary) out[cardId] = runtime.summary;
    }
    return out;
  }, [cardSummariesByCard]);
  const teamSummary = useMemo(
    () => aggregateTeamSummary({ agentNodes, cardSummaries }),
    [agentNodes, cardSummaries]
  );
  const showTeamSummary = teamSummary.total > 0;

  // Issue #510 / #615: TeamHub diagnostics から dead 数を集計し、HUD に 5 番目のピルとして出す。
  // dual preset (`dual-claude-claude` 等) で 2 つの team が並ぶケースに対応するため、
  // canvas 上に存在する **全ての agent teamId** を集めて useTeamHealthMulti で同時購読する。
  // 単一 team preset のときは長さ 1 の配列になり、従来挙動と等価。
  const aggregatedTeamIds = useMemo<string[]>(() => {
    const seen = new Set<string>();
    for (const node of agentNodes) {
      const payload = (node.data as CardData | undefined)?.payload as AgentPayload | undefined;
      if (payload?.teamId) seen.add(payload.teamId);
    }
    return Array.from(seen);
  }, [agentNodes]);
  const healthSnapshot = useTeamHealthMulti(aggregatedTeamIds);
  const deadCount = useMemo(() => {
    let n = 0;
    for (const node of agentNodes) {
      const payload = (node.data as CardData | undefined)?.payload as AgentPayload | undefined;
      if (!payload?.agentId) continue;
      const row = healthSnapshot.byAgentId[payload.agentId];
      const h = deriveHealth(row);
      if (h.state === 'dead') n += 1;
    }
    return n;
  }, [agentNodes, healthSnapshot]);

  // Issue #514 / #615: dashboard に渡す teamId / projectRoot を canvas state + settings から導出。
  // dual preset で 2 team が並ぶケースに対応するため、active な全 teamId を array で渡す。
  // ソート順は「Leader カードがある team を先頭」。Leader 不在の team は末尾に。
  const { settings } = useSettings();
  const dashboardTeamIds = useMemo<string[]>(() => {
    const leaderTeams = new Set<string>();
    const allTeams: string[] = [];
    const seen = new Set<string>();
    for (const node of agentNodes) {
      const payload = (node.data as CardData | undefined)?.payload as AgentPayload | undefined;
      if (!payload?.teamId) continue;
      if (!seen.has(payload.teamId)) {
        seen.add(payload.teamId);
        allTeams.push(payload.teamId);
      }
      const role = payload.roleProfileId ?? payload.role;
      if (role === 'leader') leaderTeams.add(payload.teamId);
    }
    // Leader を持つ team を先に、無い team を後に並べる (順序のみ調整、欠落させない)。
    return allTeams.slice().sort((a, b) => {
      const la = leaderTeams.has(a) ? 0 : 1;
      const lb = leaderTeams.has(b) ? 0 : 1;
      return la - lb;
    });
  }, [agentNodes]);
  const dashboardProjectRoot = settings.lastOpenedRoot || null;

  return (
    <>
      {/*
       * Issue #586: AI エージェントの状態サマリ (active / blocked / stale / dead / completed) は
       * 「読み取り専用の状態表示」であり、view 切替や zoom などの「ユーザー操作」とは役割が
       * 異なるため、別枠の glass pill (`.tc__hud-status`) として分離する。HUD と同じ
       * bottom-center 縦積みで視覚的にもグルーピングする。0 件のときは render しない。
       */}
      {showTeamSummary ? (
        <div
          className="tc__hud-status glass-surface"
          role="status"
          aria-live="polite"
          aria-label={t('canvas.hud.summary.label')}
        >
          <span
            className="tc__hud-summary-pill tc__hud-summary-pill--active"
            title={t('canvas.hud.summary.active.tooltip')}
          >
            <CircleDot size={11} strokeWidth={2.2} aria-hidden="true" />
            <span className="tc__hud-summary-num">{teamSummary.active}</span>
            <span className="tc__hud-summary-text">
              {t('canvas.hud.summary.active')}
            </span>
          </span>
          <span
            className={
              'tc__hud-summary-pill tc__hud-summary-pill--blocked' +
              (teamSummary.blocked > 0 ? ' is-on' : '')
            }
            title={t('canvas.hud.summary.blocked.tooltip')}
          >
            <AlertTriangle size={11} strokeWidth={2.2} aria-hidden="true" />
            <span className="tc__hud-summary-num">{teamSummary.blocked}</span>
            <span className="tc__hud-summary-text">
              {t('canvas.hud.summary.blocked')}
            </span>
          </span>
          <span
            className={
              'tc__hud-summary-pill tc__hud-summary-pill--stale' +
              (teamSummary.stale > 0 ? ' is-on' : '')
            }
            title={t('canvas.hud.summary.stale.tooltip')}
          >
            <Hourglass size={11} strokeWidth={2.2} aria-hidden="true" />
            <span className="tc__hud-summary-num">{teamSummary.stale}</span>
            <span className="tc__hud-summary-text">
              {t('canvas.hud.summary.stale')}
            </span>
          </span>
          <span
            className={
              'tc__hud-summary-pill tc__hud-summary-pill--dead' +
              (deadCount > 0 ? ' is-on' : '')
            }
            title={t('canvas.hud.summary.dead.tooltip')}
          >
            <Skull size={11} strokeWidth={2.2} aria-hidden="true" />
            <span className="tc__hud-summary-num">{deadCount}</span>
            <span className="tc__hud-summary-text">
              {t('canvas.hud.summary.dead')}
            </span>
          </span>
          <span
            className="tc__hud-summary-pill tc__hud-summary-pill--completed"
            title={t('canvas.hud.summary.completed.tooltip')}
          >
            <CheckCircle2 size={11} strokeWidth={2.2} aria-hidden="true" />
            <span className="tc__hud-summary-num">{teamSummary.completed}</span>
            <span className="tc__hud-summary-text">
              {t('canvas.hud.summary.completed')}
            </span>
          </span>
        </div>
      ) : null}
      <div className="tc__hud glass-surface" role="toolbar" aria-label="Canvas view">
      {views.map((v) => (
        <button
          key={v.id}
          type="button"
          className={stageView === v.id ? 'is-active' : ''}
          onClick={() => setStageView(v.id)}
          title={v.tip}
          aria-label={v.tip}
        >
          {v.icon}
          <span>{v.label}</span>
        </button>
      ))}
      <span className="tc__hud-sep" aria-hidden="true" />
      <button
        type="button"
        onClick={() => fitView({ duration: 320, padding: 0.18 })}
        title={t('canvas.hud.fit.tooltip')}
        aria-label={t('canvas.hud.fit.tooltip')}
      >
        <Maximize2 size={12} strokeWidth={2} />
      </button>
      <button
        type="button"
        onClick={() => zoomOut({ duration: 200 })}
        title={t('canvas.hud.zoomOut.tooltip')}
        aria-label={t('canvas.hud.zoomOut.tooltip')}
      >
        <ZoomOut size={12} strokeWidth={2} />
      </button>
      <button
        type="button"
        onClick={() => zoomIn({ duration: 200 })}
        title={t('canvas.hud.zoomIn.tooltip')}
        aria-label={t('canvas.hud.zoomIn.tooltip')}
      >
        <ZoomIn size={12} strokeWidth={2} />
      </button>
      <span className="tc__hud-sep" aria-hidden="true" />
      <div className="tc__hud-dashboard" ref={dashboardWrapRef}>
        <button
          type="button"
          className={dashboardOpen ? 'is-active' : ''}
          onClick={() => setDashboardOpen((v) => !v)}
          title={t('dashboard.button.tooltip')}
          aria-label={t('dashboard.button.tooltip')}
          aria-haspopup="dialog"
          aria-expanded={dashboardOpen}
        >
          <ClipboardList size={12} strokeWidth={2} />
        </button>
        {dashboardOpen ? (
          <TeamDashboard
            teamIds={dashboardTeamIds}
            projectRoot={dashboardProjectRoot}
            onClose={() => setDashboardOpen(false)}
          />
        ) : null}
      </div>
      <div className="tc__hud-presets" ref={presetsWrapRef}>
        <button
          type="button"
          className={presetsOpen ? 'is-active' : ''}
          onClick={() => setPresetsOpen((v) => !v)}
          title={t('preset.button.tooltip')}
          aria-label={t('preset.button.tooltip')}
          aria-haspopup="dialog"
          aria-expanded={presetsOpen}
        >
          <Bookmark size={12} strokeWidth={2} />
        </button>
        <TeamPresetsPanel open={presetsOpen} onClose={() => setPresetsOpen(false)} />
      </div>
      <span className="tc__hud-sep" aria-hidden="true" />
      <div className="tc__hud-arrange" ref={arrangeWrapRef}>
        <button
          type="button"
          className={arrangeOpen ? 'is-active' : ''}
          onClick={() => setArrangeOpen((v) => !v)}
          title={t('canvas.hud.arrange.open.tooltip')}
          aria-label={t('canvas.hud.arrange.open.tooltip')}
          aria-haspopup="menu"
          aria-expanded={arrangeOpen}
        >
          <LayoutGrid size={12} strokeWidth={2} />
        </button>
        {arrangeOpen ? (
          <div className="tc__hud-arrange-pop" role="menu">
            <button
              type="button"
              role="menuitem"
              className="tc__hud-arrange-item"
              onClick={() => {
                tidyTerminalCards();
                setArrangeOpen(false);
              }}
            >
              <LayoutGrid size={13} strokeWidth={2} />
              <span>{t('canvas.hud.arrange.tidy')}</span>
            </button>
            <button
              type="button"
              role="menuitem"
              className="tc__hud-arrange-item"
              onClick={() => {
                unifyTerminalCardSize();
                setArrangeOpen(false);
              }}
            >
              <Ruler size={13} strokeWidth={2} />
              <span>{t('canvas.hud.arrange.unifySize')}</span>
            </button>
            <div className="tc__hud-arrange-sep" aria-hidden="true" />
            <div className="tc__hud-arrange-label">{t('canvas.hud.arrange.gap.label')}</div>
            <div className="tc__hud-arrange-gaps" role="group">
              {gaps.map((g) => (
                <button
                  key={g.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={arrangeGap === g.id}
                  className={
                    'tc__hud-arrange-gap' + (arrangeGap === g.id ? ' is-active' : '')
                  }
                  onClick={() => {
                    setArrangeGap(g.id);
                    tidyTerminalCards(g.id);
                  }}
                >
                  {g.label}
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>
      </div>
    </>
  );
}
