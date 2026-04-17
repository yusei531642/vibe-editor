/**
 * UI Mode store — IDE / Canvas / 将来のタブを切り替える最小ストア。
 *
 * Phase 2 では App.tsx の状態 (terminalTabs 等) はまだここに移行せず、
 * 「どのレイアウトを描画するか」だけを持つ。Phase 3 以降で
 * stores/{workspace,terminals,teams,canvas} に分割していく。
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type ViewMode = 'ide' | 'canvas';

interface UiState {
  viewMode: ViewMode;
  setViewMode: (m: ViewMode) => void;
  toggleViewMode: () => void;
  /** 共通サイドバーから「設定」を開くためのグローバルフラグ */
  settingsOpen: boolean;
  setSettingsOpen: (open: boolean) => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set, get) => ({
      viewMode: 'ide',
      setViewMode: (m) => set({ viewMode: m }),
      toggleViewMode: () => set({ viewMode: get().viewMode === 'ide' ? 'canvas' : 'ide' }),
      settingsOpen: false,
      setSettingsOpen: (open) => set({ settingsOpen: open })
    }),
    {
      name: 'vibe-editor:ui',
      partialize: (s) => ({ viewMode: s.viewMode })
    }
  )
);
