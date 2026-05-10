import { useCallback, useEffect, useState } from 'react';
import { useSettingsValue } from '../settings-context';
import { useUiStore } from '../../stores/ui';
import { useToast } from '../toast-context';

export interface ClaudeCheckState {
  state: 'checking' | 'ok' | 'missing';
  error?: string;
}

export interface UseClaudeCheckResult {
  /** Claude CLI 検査状態 (生)。JSX の分岐 (`<ClaudeNotFound>` の checking/missing/ok)
   *  や `useTerminalTabs.opts.claudeReady` 派生値の組み立てに使う。 */
  claudeCheck: ClaudeCheckState;
  /** 検査をリトライ。`<ClaudeNotFound onRetry>` から呼ばれる。 */
  runClaudeCheck: () => Promise<void>;
}

/**
 * Issue #373 Phase 1-7: Claude CLI 検査と起動時アップデーター遅延 effect を
 * App.tsx から切り出した hook。
 *
 * 同居の根拠: tasks/refactor-handoff.md で「Phase 1-7 use-claude-check.ts
 * (claudeCheck / アップデーター遅延 effect)」と明示されており、両者とも
 * 「起動時 1 回 / 設定変更時に追従する App ライフサイクル系の副作用」という
 * 共通点を持つ。内部実装は別 useEffect で完全分離してある。
 *
 * 将来 updater 周りが太ったら use-updater-poll.ts に再分離する余地あり。
 *
 * 流儀:
 * - opts なし純粋 hook (Phase 1-5 use-layout-resize と同じ)
 * - useSettingsValue('claudeCommand') を hook 内で直接呼ぶ (Phase 1-4 流儀)
 * - 既存挙動を完全保持: runClaudeCheck の deps は [claudeCommand]、
 *   再検査 effect の deps は [runClaudeCheck] のまま
 */
export function useClaudeCheck(): UseClaudeCheckResult {
  const claudeCommand = useSettingsValue('claudeCommand');
  // Issue #609: silent check で signature 系 error を検知したとき、24h cooldown 付きで
  // 1 度だけ toast を出す経路を hook 内で確保する。
  const language = useSettingsValue('language');
  const { showToast } = useToast();

  const [claudeCheck, setClaudeCheck] = useState<ClaudeCheckState>({
    state: 'checking'
  });

  const runClaudeCheck = useCallback(async () => {
    setClaudeCheck({ state: 'checking' });
    try {
      const res = await window.api.app.checkClaude(claudeCommand || 'claude');
      setClaudeCheck(
        res.ok ? { state: 'ok' } : { state: 'missing', error: res.error }
      );
    } catch (err) {
      setClaudeCheck({ state: 'missing', error: String(err) });
    }
  }, [claudeCommand]);

  // 設定の claudeCommand が変わるたびに再検査
  useEffect(() => {
    void runClaudeCheck();
  }, [runClaudeCheck]);

  // 起動時に GitHub Release の latest.json を「確認だけ」する (prod のみ)。
  // 旧仕様の「ask → 即 install → relaunch」は撤廃。代わりに silentCheckForUpdate で
  // 更新の有無を検出して useUiStore.availableUpdate に書き、Topbar / CanvasLayout の
  // 「Update」ボタンを点灯させる。実 install はユーザーがボタンを押したときだけ走る。
  // 起動直後の負荷を避けるため少し遅延させる (5 秒)。
  //
  // Issue #609: signature 系 error を検出したときは silentCheckForUpdate 内部で
  // 24h cooldown 付き toast を出すため、deps として { language, showToast } を渡す。
  useEffect(() => {
    let cancelled = false;
    const handle = window.setTimeout(() => {
      void import('../updater-check').then(async (m) => {
        const info = await m.silentCheckForUpdate({ language, showToast });
        if (cancelled) return;
        useUiStore.getState().setAvailableUpdate(info);
      });
    }, 5_000);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
    // language / showToast の値が起動 5 秒以内に変わるケースは想定しないため、
    // deps を空のままにして「起動時 1 回」を厳守する。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { claudeCheck, runClaudeCheck };
}
