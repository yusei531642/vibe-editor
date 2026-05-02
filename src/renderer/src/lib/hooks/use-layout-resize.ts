import { useCallback, useEffect, useRef } from 'react';
import { useSettingsActions, useSettingsValue } from '../settings-context';

/** Claude Code パネル最小幅 (px) */
const MIN_PANEL = 320;
/** Claude Code パネル最大幅 (px) */
const MAX_PANEL = 900;
/** Claude Code パネルのデフォルト幅。CSS の var() フォールバックと一致 */
const DEFAULT_PANEL = 460;

/** サイドバー最小幅 (px) - Issue #337 */
const MIN_SIDEBAR = 200;
/** サイドバー最大幅 (px) - Issue #337 */
const MAX_SIDEBAR = 600;
/** サイドバーのデフォルト幅。dblclick リセット先 - Issue #337 */
const DEFAULT_SIDEBAR = 272;

export interface UseLayoutResizeResult {
  /** Claude Code パネル左端ハンドルの onMouseDown */
  onClaudePanelResizeStart: (e: React.MouseEvent<HTMLDivElement>) => void;
  /** サイドバー右端ハンドルの onMouseDown */
  onSidebarResizeStart: (e: React.MouseEvent<HTMLDivElement>) => void;
  /** サイドバー右端ハンドルの onDoubleClick (DEFAULT_SIDEBAR にリセット) */
  onSidebarResizeDouble: () => void;
}

/**
 * Issue #373 Phase 1-5: Claude Code パネル / サイドバーの drag リサイズと
 * settings 永続化を App.tsx から切り出した hook。
 *
 * 設計:
 * - drag 中は React の再レンダリングを避けるため、CSS 変数 (`--claude-code-width` /
 *   `--shell-sidebar-w`) を `document.documentElement.style.setProperty` で直接更新
 *   する。`updateSettings` は **mouseup の 1 回のみ** で呼んで永続化する
 *   (debounce ではなく mouseup gating)。
 * - 起動時 / settings 復元時に CSS 変数を初期化する effect を 2 本持つ。
 *   `index.css` / `tokens.css` 側に var() フォールバックがあるので、ロード前は
 *   既定値で描画される。
 *
 * Phase 1-1 〜 1-4 と異なり、本 hook は **opts を一切取らない** (settings の
 * 読み書きのみで完結する純粋な責務のため)。
 */
export function useLayoutResize(): UseLayoutResizeResult {
  const claudeCodePanelWidth = useSettingsValue('claudeCodePanelWidth');
  const sidebarWidth = useSettingsValue('sidebarWidth');
  const { update: updateSettings } = useSettingsActions();

  const resizeDragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const sidebarResizeDragRef = useRef<{ startX: number; startWidth: number } | null>(
    null
  );

  // 設定からの初期幅を CSS 変数に反映 (Claude Code パネル)
  useEffect(() => {
    const w = Math.max(MIN_PANEL, Math.min(MAX_PANEL, claudeCodePanelWidth ?? DEFAULT_PANEL));
    document.documentElement.style.setProperty('--claude-code-width', `${w}px`);
  }, [claudeCodePanelWidth]);

  // Issue #337: サイドバー幅を CSS 変数に反映
  useEffect(() => {
    const w = Math.max(MIN_SIDEBAR, Math.min(MAX_SIDEBAR, sidebarWidth ?? DEFAULT_SIDEBAR));
    document.documentElement.style.setProperty('--shell-sidebar-w', `${w}px`);
  }, [sidebarWidth]);

  const onClaudePanelResizeStart = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      e.preventDefault();
      const currentWidth = Math.max(
        MIN_PANEL,
        Math.min(MAX_PANEL, claudeCodePanelWidth ?? DEFAULT_PANEL)
      );
      resizeDragRef.current = {
        startX: e.clientX,
        startWidth: currentWidth
      };
      document.body.classList.add('is-resizing');
      const handleEl = e.currentTarget;
      handleEl.classList.add('is-dragging');

      let latestWidth = currentWidth;

      const onMove = (ev: MouseEvent): void => {
        const drag = resizeDragRef.current;
        if (!drag) return;
        const dx = drag.startX - ev.clientX; // 左へドラッグ = width 増える
        const next = Math.max(MIN_PANEL, Math.min(MAX_PANEL, drag.startWidth + dx));
        latestWidth = next;
        // ドラッグ中は CSS 変数を直接書き換え（React 再レンダリング回避）
        document.documentElement.style.setProperty(
          '--claude-code-width',
          `${next}px`
        );
      };

      const onUp = (): void => {
        resizeDragRef.current = null;
        document.body.classList.remove('is-resizing');
        handleEl.classList.remove('is-dragging');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        // 確定値を設定に保存
        void updateSettings({ claudeCodePanelWidth: latestWidth });
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    },
    [claudeCodePanelWidth, updateSettings]
  );

  // Issue #337: サイドバーと main の境界をドラッグして幅を調整する
  const onSidebarResizeStart = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      e.preventDefault();
      const currentWidth = Math.max(
        MIN_SIDEBAR,
        Math.min(MAX_SIDEBAR, sidebarWidth ?? DEFAULT_SIDEBAR)
      );
      sidebarResizeDragRef.current = {
        startX: e.clientX,
        startWidth: currentWidth
      };
      document.body.classList.add('is-resizing');
      const handleEl = e.currentTarget;
      handleEl.classList.add('is-dragging');

      let latestWidth = currentWidth;

      const onMove = (ev: MouseEvent): void => {
        const drag = sidebarResizeDragRef.current;
        if (!drag) return;
        // 右へドラッグ = width 増える (claude-code-panel と方向が逆)
        const dx = ev.clientX - drag.startX;
        const next = Math.max(
          MIN_SIDEBAR,
          Math.min(MAX_SIDEBAR, drag.startWidth + dx)
        );
        latestWidth = next;
        document.documentElement.style.setProperty('--shell-sidebar-w', `${next}px`);
      };

      const onUp = (): void => {
        sidebarResizeDragRef.current = null;
        document.body.classList.remove('is-resizing');
        handleEl.classList.remove('is-dragging');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        void updateSettings({ sidebarWidth: latestWidth });
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    },
    [sidebarWidth, updateSettings]
  );

  // Issue #337: ダブルクリックで default 幅にリセット
  const onSidebarResizeDouble = useCallback(() => {
    document.documentElement.style.setProperty(
      '--shell-sidebar-w',
      `${DEFAULT_SIDEBAR}px`
    );
    void updateSettings({ sidebarWidth: DEFAULT_SIDEBAR });
  }, [updateSettings]);

  return {
    onClaudePanelResizeStart,
    onSidebarResizeStart,
    onSidebarResizeDouble
  };
}
