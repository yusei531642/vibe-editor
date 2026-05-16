import { create } from 'zustand';

export type FileTreeClipboard = {
  rootPath: string;
  relPath: string;
  isDir: boolean;
  /** 'cut' は paste 後に元を消す (move)、'copy' は元を残す (copy)。 */
  mode: 'cut' | 'copy';
};

interface FileTreeClipboardState {
  clipboard: FileTreeClipboard | null;
  setClipboard: (next: FileTreeClipboard | null) => void;
}

export const useFileTreeClipboardStore = create<FileTreeClipboardState>()((set) => ({
  clipboard: null,
  setClipboard: (clipboard) => set({ clipboard })
}));
