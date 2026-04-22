import { List, Maximize2, Users, ZoomIn, ZoomOut } from 'lucide-react';
import { useReactFlow } from '@xyflow/react';
import { useT } from '../../lib/i18n';
import { useCanvasStore, type StageView } from '../../stores/canvas';

/**
 * StageHud — Canvas 中央下部のガラス調ピル HUD。
 * Claude Design バンドルの .tc__hud を移植。
 * view 切替 (Stage / List / Focus) + fit + zoom in/out を含む。
 */
export function StageHud(): JSX.Element {
  const t = useT();
  const stageView = useCanvasStore((s) => s.stageView);
  const setStageView = useCanvasStore((s) => s.setStageView);
  const { fitView, zoomIn, zoomOut } = useReactFlow();

  const views: Array<{ id: StageView; label: string; icon: JSX.Element }> = [
    { id: 'stage', label: t('canvas.hud.stage'), icon: <Users size={12} strokeWidth={2} /> },
    { id: 'list', label: t('canvas.hud.list'), icon: <List size={12} strokeWidth={2} /> },
    { id: 'focus', label: t('canvas.hud.focus'), icon: <Maximize2 size={12} strokeWidth={2} /> }
  ];

  return (
    <div className="tc__hud" role="toolbar" aria-label="Canvas view">
      {views.map((v) => (
        <button
          key={v.id}
          type="button"
          className={stageView === v.id ? 'is-active' : ''}
          onClick={() => setStageView(v.id)}
          title={v.label}
        >
          {v.icon}
          <span>{v.label}</span>
        </button>
      ))}
      <span className="tc__hud-sep" aria-hidden="true" />
      <button
        type="button"
        onClick={() => fitView({ duration: 320, padding: 0.18 })}
        title={t('canvas.hud.fit')}
      >
        <Maximize2 size={12} strokeWidth={2} />
      </button>
      <button
        type="button"
        onClick={() => zoomOut({ duration: 200 })}
        title={t('canvas.hud.zoomOut')}
      >
        <ZoomOut size={12} strokeWidth={2} />
      </button>
      <button
        type="button"
        onClick={() => zoomIn({ duration: 200 })}
        title={t('canvas.hud.zoomIn')}
      >
        <ZoomIn size={12} strokeWidth={2} />
      </button>
    </div>
  );
}
