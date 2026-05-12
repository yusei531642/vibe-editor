import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowDownToLine } from 'lucide-react';
import { useT } from '../../lib/i18n';
import { useSettings } from '../../lib/settings-context';
import type { StatusMascotState } from '../../lib/status-mascot';
import type { AvailableUpdateInfo } from '../../lib/updater-check';
import { StatusMascot } from './StatusMascot';
import { WindowControls } from './WindowControls';

interface TopbarProps {
  projectRoot: string;
  status: string;
  /** 左側に置く自作メニューバー (File / View / Help…) */
  menuBar?: ReactNode;
  /** silentCheckForUpdate で検出された更新情報。null のときボタンは出さない */
  availableUpdate?: AvailableUpdateInfo | null;
  /** 「更新」ボタンが押されたとき。runUpdateInstall を呼び出す想定 */
  onClickUpdate?: () => void;
  /**
   * status の右側、icons の左側に追加で表示するアクション群。
   * Canvas モードの IDE 切替 / Clear ボタンをここに差し込むことで、
   * canvas モード専用の 2 段目ヘッダー (旧 .canvas-header) を撤廃する。
   */
  extraActions?: ReactNode;
  /** Topbar 上を自由に歩き回るマスコット (旧 StatusBar 左端から移植) */
  mascotState?: StatusMascotState;
}

const MASCOT_WIDTH = 32;
const MASCOT_GAP_MARGIN = 12;
const MASCOT_MIN_GAP_WIDTH = MASCOT_WIDTH + MASCOT_GAP_MARGIN;
const MASCOT_ROAM_INTERVAL_MS = 4500;

/**
 * Redesign shell の上端バー (44px)。Topbar 内の他要素 (brand / menu /
 * project / status / extra / update / window controls) を避けて、空いている
 * 隙間を一定間隔でランダムに移動するマスコットを overlay として表示する。
 */
export function Topbar({
  projectRoot,
  status,
  menuBar,
  availableUpdate,
  onClickUpdate,
  extraActions,
  mascotState
}: TopbarProps): JSX.Element {
  const t = useT();
  const { settings } = useSettings();
  const topbarRef = useRef<HTMLDivElement>(null);
  const mascotRef = useRef<HTMLSpanElement>(null);
  const [mascotX, setMascotX] = useState<number | null>(null);

  const segments = projectRoot.split(/[\\/]/).filter(Boolean);
  const projectName = segments[segments.length - 1] ?? '';
  const parentSlice = segments.slice(Math.max(segments.length - 2, 0), -1).join(' / ');
  const isError = /error|failed|missing|warn|warning|失敗|警告|見つかりません/i.test(status);
  const isLoading = /loading|starting|checking|読み込み|起動中|確認中/i.test(status);
  const dotColor = isError
    ? 'var(--warning)'
    : isLoading
      ? 'var(--accent)'
      : 'var(--success)';

  useLayoutEffect(() => {
    if (!mascotState) {
      setMascotX(null);
      return;
    }
    const initial = pickMascotSpot(topbarRef.current, mascotRef.current);
    if (initial !== null) setMascotX(initial);
  }, [mascotState]);

  useEffect(() => {
    if (!mascotState) return;
    const move = (): void => {
      const next = pickMascotSpot(topbarRef.current, mascotRef.current);
      if (next !== null) setMascotX(next);
    };
    const id = window.setInterval(move, MASCOT_ROAM_INTERVAL_MS);
    const onResize = (): void => move();
    window.addEventListener('resize', onResize);
    return () => {
      window.clearInterval(id);
      window.removeEventListener('resize', onResize);
    };
  }, [mascotState]);

  return (
    <div className="topbar" role="banner" data-tauri-drag-region ref={topbarRef}>
      <div className="topbar__brand" data-tauri-drag-region title="vibe-editor">
        <img
          className="topbar__brand-logo"
          src="/vibe-editor.png"
          alt="vibe-editor"
          draggable={false}
        />
        <span>vibe-editor</span>
      </div>

      {menuBar}

      {projectRoot ? (
        <button
          type="button"
          className="topbar__project"
          title={projectRoot}
          aria-label={projectRoot}
        >
          {parentSlice ? (
            <>
              <span className="topbar__project-parent">{parentSlice}</span>
              <span className="topbar__project-sep">/</span>
            </>
          ) : null}
          <span className="topbar__project-name">{projectName}</span>
        </button>
      ) : null}

      <div className="topbar__spacer" data-tauri-drag-region />

      {status ? (
        <span className="topbar__status" title={status}>
          <span className="topbar__status-dot" aria-hidden="true" style={{ background: dotColor }} />
          <span className="topbar__status-text">{status}</span>
        </span>
      ) : null}

      {extraActions ? <div className="topbar__extra">{extraActions}</div> : null}

      {availableUpdate && onClickUpdate ? (
        <div className="topbar__icons">
          <button
            type="button"
            className="topbar__update"
            onClick={onClickUpdate}
            title={t('updater.button.title', { version: availableUpdate.version })}
            aria-label={t('updater.button.title', { version: availableUpdate.version })}
          >
            <ArrowDownToLine size={13} strokeWidth={2} />
            <span className="topbar__update-label">
              {t('updater.button.label', { version: availableUpdate.version })}
            </span>
          </button>
        </div>
      ) : null}

      {/* Issue #260 PR-2: カスタムタイトルバーのウィンドウ制御 (decorations: false の代替) */}
      <WindowControls />

      {mascotState ? (
        <span
          className="topbar__mascot"
          ref={mascotRef}
          data-ready={mascotX !== null ? 'true' : 'false'}
          style={mascotX !== null ? { transform: `translate3d(${mascotX}px, -50%, 0)` } : undefined}
          aria-hidden="true"
        >
          <StatusMascot
            state={mascotState}
            label={t(`status.mascot.${mascotState}`)}
            variant={settings.statusMascotVariant ?? 'vibe'}
            customPath={settings.statusMascotCustomPath}
          />
        </span>
      ) : null}
    </div>
  );
}

/**
 * Topbar 内の他要素 (mascot 自身と spacer 以外) の bounding box を集計し、
 * 横方向で重なっていない「空きセグメント」を抽出する。各セグメントを幅で
 * 重み付けしてランダムに 1 つ選び、その内側の x を返す。
 */
function pickMascotSpot(
  topbar: HTMLDivElement | null,
  mascot: HTMLSpanElement | null
): number | null {
  if (!topbar) return null;
  const tbRect = topbar.getBoundingClientRect();
  if (tbRect.width <= 0) return null;

  const occupied: Array<[number, number]> = [];
  for (const child of Array.from(topbar.children) as HTMLElement[]) {
    if (child === mascot) continue;
    if (child.classList.contains('topbar__spacer')) continue;
    const r = child.getBoundingClientRect();
    if (r.width <= 0) continue;
    const left = Math.max(0, r.left - tbRect.left - MASCOT_GAP_MARGIN);
    const right = Math.min(tbRect.width, r.right - tbRect.left + MASCOT_GAP_MARGIN);
    if (right > left) occupied.push([left, right]);
  }
  occupied.sort((a, b) => a[0] - b[0]);

  const merged: Array<[number, number]> = [];
  for (const seg of occupied) {
    const last = merged[merged.length - 1];
    if (!last || seg[0] > last[1]) {
      merged.push([seg[0], seg[1]]);
    } else {
      last[1] = Math.max(last[1], seg[1]);
    }
  }

  const gaps: Array<[number, number]> = [];
  let cursor = 0;
  for (const [l, r] of merged) {
    if (l - cursor >= MASCOT_MIN_GAP_WIDTH) gaps.push([cursor, l]);
    cursor = r;
  }
  if (tbRect.width - cursor >= MASCOT_MIN_GAP_WIDTH) gaps.push([cursor, tbRect.width]);

  if (gaps.length === 0) return null;

  const weights = gaps.map(([l, r]) => r - l - MASCOT_WIDTH);
  const total = weights.reduce((s, w) => s + Math.max(0, w), 0);
  if (total <= 0) return null;

  let pick = Math.random() * total;
  for (let i = 0; i < gaps.length; i++) {
    const w = weights[i];
    if (w <= 0) continue;
    if (pick <= w) {
      const [l] = gaps[i];
      return l + Math.random() * w;
    }
    pick -= w;
  }
  return null;
}
