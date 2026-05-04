import { useEffect, useRef, useState } from 'react';
import { LayoutGrid, List, Maximize2, Ruler, Users, ZoomIn, ZoomOut } from 'lucide-react';
import { useReactFlow } from '@xyflow/react';
import { useT } from '../../lib/i18n';
import { useCanvasStore, type StageView } from '../../stores/canvas';
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
  const stageView = useCanvasStore((s) => s.stageView);
  const setStageView = useCanvasStore((s) => s.setStageView);
  const arrangeGap = useCanvasStore((s) => s.arrangeGap);
  const setArrangeGap = useCanvasStore((s) => s.setArrangeGap);
  const tidyTerminalCards = useCanvasStore((s) => s.tidyTerminalCards);
  const unifyTerminalCardSize = useCanvasStore((s) => s.unifyTerminalCardSize);
  const { fitView, zoomIn, zoomOut } = useReactFlow();

  const [arrangeOpen, setArrangeOpen] = useState(false);
  const arrangeWrapRef = useRef<HTMLDivElement | null>(null);

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

  const views: Array<{ id: StageView; label: string; tip: string; icon: JSX.Element }> = [
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
  ];

  const gaps: Array<{ id: ArrangeGap; label: string }> = [
    { id: 'tight', label: t('canvas.hud.arrange.gap.tight') },
    { id: 'normal', label: t('canvas.hud.arrange.gap.normal') },
    { id: 'wide', label: t('canvas.hud.arrange.gap.wide') }
  ];

  return (
    <div className="tc__hud" role="toolbar" aria-label="Canvas view">
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
  );
}
