/**
 * use-terminal-tabs-persistence — Issue #661
 *
 * IDE モード terminal タブを `~/.vibe-editor/terminal-tabs.json` に atomic 永続化し、
 * mount 時に load → 各タブを `addTerminalTab` で復元する hook。
 *
 * 流れ:
 *   1. projectRoot 確定後に `terminal_tabs_load()` を 1 度だけ呼ぶ
 *   2. 該当プロジェクトの persisted tabs を順に `addTerminalTab` で復元 (= --resume 経路)
 *   3. 以降 `terminalTabs` / `activeTerminalTabId` / `reportSize` の変化を
 *      500ms debounce で `terminal_tabs_save()` する
 *   4. ファイル全体の他プロジェクト entry は read-modify-write で保持する
 *
 * cwd は v1 では「mount 時 load → 復元」の片方向のみ更新する (runtime 中に cwd を
 * 切替える UI が存在しないため)。サイズは TerminalView の `onResize` 経由で
 * `reportSize()` が呼ばれる。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../tauri-api';
import {
  TERMINAL_TABS_SCHEMA_VERSION,
  type PersistedTerminalTab,
  type PersistedTerminalTabsByProject,
  type PersistedTerminalTabsFile
} from '../../../../types/shared';
import type {
  AddTerminalTabOptions,
  TerminalTab
} from './use-terminal-tabs';

const SAVE_DEBOUNCE_MS = 500;
/** 復元時の PTY default size (xterm 既定値)。Commit 3 で実 PTY size に置換される */
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

/**
 * Issue #662: 永続化ファイルから読んだ cols/rows 値が「PTY 起動 seed として安全か」を判定する。
 * portable-pty は cols/rows に u16 の正の整数を要求し、0 や巨大値で起動すると Windows ConPTY
 * 側で `E_INVALIDARG` になる。Linux/macOS でも cols=0 はカーネルが拒否する。再起動時に
 * ファイルが手編集 / 旧 schema 残骸 / 0 値で書かれていてもアプリが死なないよう、以下を満たす
 * 場合のみ seed として採用する:
 *   - 整数 (NaN / 小数を弾く)
 *   - 1..=10000 の範囲 (実用上の最大は ~999、安全マージンで 10000 上限)
 */
function isValidPtyDim(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 10000
  );
}

export interface UseTerminalTabsPersistenceOptions {
  projectRoot: string;
  terminalTabs: TerminalTab[];
  activeTerminalTabId: number;
  setActiveTerminalTabId: React.Dispatch<React.SetStateAction<number>>;
  addTerminalTab: (opts?: AddTerminalTabOptions) => number | null;
}

export interface UseTerminalTabsPersistenceResult {
  /** 永続化ファイルから復元処理が完了 (or 復元対象なし確定) したか */
  isReady: boolean;
  /** PTY size 変化を hook に通知 (TerminalView の onResize から呼ばれる) */
  reportSize: (tabId: number, cols: number, rows: number) => void;
}

export function useTerminalTabsPersistence(
  opts: UseTerminalTabsPersistenceOptions
): UseTerminalTabsPersistenceResult {
  const {
    projectRoot,
    terminalTabs,
    activeTerminalTabId,
    addTerminalTab,
    setActiveTerminalTabId
  } = opts;

  const [isReady, setIsReady] = useState(false);
  /** 復元中に save loop が走らないようガードするフラグ */
  const restoringRef = useRef(false);
  /** 各 tabId の PTY size。reportSize で更新、save で参照 */
  const sizeMapRef = useRef(new Map<number, { cols: number; rows: number }>());
  /** 各 tabId の cwd。load 時に焼き付ける (v1 では runtime 更新無し)。save で参照、未設定なら projectRoot を fallback */
  const cwdMapRef = useRef(new Map<number, string>());
  /** 永続化ファイルの直近キャッシュ。save 時に他プロジェクトの entry を保持する用途 */
  const fileCacheRef = useRef<PersistedTerminalTabsFile | null>(null);
  /** size/cwd の Map 更新を save effect に観測させるための tick */
  const [tickNonce, setTickNonce] = useState(0);
  const bumpTick = useCallback(() => setTickNonce((n) => n + 1), []);

  // mount 時に 1 度だけ load → 復元
  useEffect(() => {
    if (!projectRoot) return;
    let disposed = false;
    void (async () => {
      let file: PersistedTerminalTabsFile | null = null;
      try {
        file = await api.terminalTabs.load();
      } catch (err) {
        console.warn('[terminal-tabs] load failed:', err);
      }
      if (disposed) return;
      fileCacheRef.current = file;
      const slot = file?.byProject?.[projectRoot];
      if (slot && slot.tabs.length > 0 && terminalTabs.length === 0) {
        restoringRef.current = true;
        const numericByPersistedId = new Map<string, number>();
        for (const p of slot.tabs) {
          const newId = addTerminalTab({
            agent: p.kind,
            resumeSessionId: p.sessionId,
            role: p.role ?? null,
            teamId: p.teamId ?? null,
            agentId: p.agentId ?? undefined,
            customLabel: p.label ?? null,
            cwd: p.cwd,
            // Issue #662: 永続化された PTY size を初回 spawn の seed として渡す。
            // 値が壊れていても 0 / 負値 / NaN は use-xterm-bind 側で sanitize されるが、
            // ここでも防御的に妥当範囲だけを seed する (壊れた値で xterm が cells=0 で
            // 立ち上がる事故を防ぐ)。
            initialCols: isValidPtyDim(p.cols) ? p.cols : null,
            initialRows: isValidPtyDim(p.rows) ? p.rows : null
          });
          if (newId !== null) {
            numericByPersistedId.set(p.tabId, newId);
            sizeMapRef.current.set(newId, { cols: p.cols, rows: p.rows });
            cwdMapRef.current.set(newId, p.cwd);
          }
        }
        if (slot.activeTabId !== null) {
          const target = numericByPersistedId.get(slot.activeTabId);
          if (target !== undefined) setActiveTerminalTabId(target);
        }
        restoringRef.current = false;
      }
      setIsReady(true);
    })();
    return () => {
      disposed = true;
    };
    // 復元は projectRoot 確定 1 回限り。
    // addTerminalTab / setActiveTerminalTabId の identity 変化で再復元しないよう deps から外す。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectRoot]);

  // terminalTabs / activeTerminalTabId / size/cwd Map の変化を 500ms debounce で save
  useEffect(() => {
    if (!isReady || !projectRoot || restoringRef.current) return;
    const timer = setTimeout(() => {
      const persisted: PersistedTerminalTab[] = terminalTabs.map((t) => {
        const size = sizeMapRef.current.get(t.id) ?? {
          cols: DEFAULT_COLS,
          rows: DEFAULT_ROWS
        };
        const cwd = cwdMapRef.current.get(t.id) ?? projectRoot;
        return {
          tabId: String(t.id),
          kind: t.agent,
          cwd,
          cols: size.cols,
          rows: size.rows,
          sessionId: t.resumeSessionId,
          label: t.customLabel,
          teamId: t.teamId,
          agentId: t.agentId,
          role: t.role
        };
      });
      const slot: PersistedTerminalTabsByProject = {
        tabs: persisted,
        activeTabId: activeTerminalTabId > 0 ? String(activeTerminalTabId) : null
      };
      const prevFile = fileCacheRef.current ?? {
        schemaVersion: TERMINAL_TABS_SCHEMA_VERSION,
        lastSavedAt: '',
        byProject: {}
      };
      const nextFile: PersistedTerminalTabsFile = {
        schemaVersion: TERMINAL_TABS_SCHEMA_VERSION,
        lastSavedAt: new Date().toISOString(),
        byProject: { ...prevFile.byProject, [projectRoot]: slot }
      };
      fileCacheRef.current = nextFile;
      void api.terminalTabs.save(nextFile).catch((err) => {
        console.warn('[terminal-tabs] save failed:', err);
      });
    }, SAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [terminalTabs, activeTerminalTabId, projectRoot, isReady, tickNonce]);

  const reportSize = useCallback(
    (tabId: number, cols: number, rows: number) => {
      const prev = sizeMapRef.current.get(tabId);
      if (prev && prev.cols === cols && prev.rows === rows) return;
      sizeMapRef.current.set(tabId, { cols, rows });
      bumpTick();
    },
    [bumpTick]
  );

  return { isReady, reportSize };
}
