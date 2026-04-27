/**
 * UI Mode store — IDE / Canvas / 将来のタブを切り替える最小ストア。
 *
 * Phase 2 では App.tsx の状態 (terminalTabs 等) はまだここに移行せず、
 * 「どのレイアウトを描画するか」だけを持つ。Phase 3 以降で
 * stores/{workspace,terminals,teams,canvas} に分割していく。
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { AvailableUpdateInfo } from '../lib/updater-check';

export type ViewMode = 'ide' | 'canvas';

interface UiState {
  viewMode: ViewMode;
  setViewMode: (m: ViewMode) => void;
  toggleViewMode: () => void;
  /** 共通サイドバーから「設定」を開くためのグローバルフラグ */
  settingsOpen: boolean;
  setSettingsOpen: (open: boolean) => void;
  /** Redesign: 右ドロワーの Activity (handoff feed) 表示フラグ */
  activityOpen: boolean;
  setActivityOpen: (open: boolean) => void;
  toggleActivity: () => void;
  /** Redesign: Tweaks 軽量パネル (テーマ/アクセント等) 表示フラグ */
  tweaksOpen: boolean;
  setTweaksOpen: (open: boolean) => void;
  toggleTweaks: () => void;
  /** Sidebar (rail の右にある幅広パネル) を畳むフラグ。
   *  Rail のアクティブ tab 再クリック / Ctrl+B で toggle。 */
  sidebarCollapsed: boolean;
  setSidebarCollapsed: (collapsed: boolean) => void;
  toggleSidebar: () => void;
  /** 起動時 silentCheckForUpdate() で検出された更新情報。
   *  Topbar / CanvasLayout 右上の「更新」ボタンの表示制御に使う。
   *  null = 更新なし or 未チェック。永続化しない (再起動時に再検出する)。 */
  availableUpdate: AvailableUpdateInfo | null;
  setAvailableUpdate: (info: AvailableUpdateInfo | null) => void;
  /**
   * Canvas モードで App の MenuBar を埋め込むための slot DOM 参照。
   * CanvasLayout 内 canvas-header に配置した <div> を mount 時に登録し、
   * App.tsx 側はこの slot に対して createPortal で MenuBar を転送する。
   * IDE モードでは null。永続化しない。
   */
  canvasMenuBarSlot: HTMLElement | null;
  setCanvasMenuBarSlot: (el: HTMLElement | null) => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set, get) => ({
      viewMode: 'ide',
      setViewMode: (m) => set({ viewMode: m }),
      toggleViewMode: () => set({ viewMode: get().viewMode === 'ide' ? 'canvas' : 'ide' }),
      settingsOpen: false,
      setSettingsOpen: (open) => set({ settingsOpen: open }),
      activityOpen: false,
      setActivityOpen: (open) => set({ activityOpen: open }),
      toggleActivity: () => set({ activityOpen: !get().activityOpen }),
      tweaksOpen: false,
      setTweaksOpen: (open) => set({ tweaksOpen: open }),
      toggleTweaks: () => set({ tweaksOpen: !get().tweaksOpen }),
      sidebarCollapsed: false,
      setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
      toggleSidebar: () => set({ sidebarCollapsed: !get().sidebarCollapsed }),
      availableUpdate: null,
      setAvailableUpdate: (info) => set({ availableUpdate: info }),
      canvasMenuBarSlot: null,
      setCanvasMenuBarSlot: (el) => set({ canvasMenuBarSlot: el })
    }),
    {
      name: 'vibe-editor:ui',
      partialize: (s) => ({
        activityOpen: s.activityOpen,
        sidebarCollapsed: s.sidebarCollapsed
      }),
      merge: (persisted, current) => {
        const saved = persisted as Partial<UiState> | undefined;
        return {
          ...current,
          // 起動時は必ず IDE から始める。Canvas は重い Team/PTY 復元を伴うため、
          // ユーザーが開いたタイミングで初めて読み込む。
          viewMode: 'ide',
          activityOpen: saved?.activityOpen ?? current.activityOpen,
          sidebarCollapsed: saved?.sidebarCollapsed ?? current.sidebarCollapsed
        };
      }
    }
  )
);
