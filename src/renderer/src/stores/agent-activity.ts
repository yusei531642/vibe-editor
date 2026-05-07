/**
 * agent-activity store — Canvas 上の各 Agent カードのランタイム状態 (lastActivityAt /
 * activity / cardSummary) を共有する軽量 zustand store。
 *
 * Issue #521: CardFrame.tsx は idle timer / payload を持っているが、StageHud は
 * Canvas 全体を集約した HUD を出したい。両者を疎結合に保つために
 *   - CardFrame が `setActivity` / `setSummary` を呼ぶ (write 一方向)
 *   - StageHud が `summaries` を購読する (read 一方向)
 * という最小契約だけを定義する。
 *
 * 永続化はしない: PTY 出力タイムスタンプはセッション内でのみ意味がある (再起動後は
 * `idleMs = Infinity` 扱いの方が安全) ため localStorage には書かない。
 */
import { create } from 'zustand';
import type { CardSummary } from '../lib/agent-summary';
import type { AgentStatus } from '../components/canvas/cards/AgentNodeCard/types';

interface AgentRuntime {
  /** typing / thinking / idle */
  activity: AgentStatus;
  /** 最後に出力 or 入力イベントを観測した unix ms。null = 未観測 (起動直後) */
  lastActivityAt: number | null;
  /** CardFrame が deriveCardSummary で算出した最新サマリ */
  summary: CardSummary | null;
}

interface AgentActivityState {
  byCard: Record<string, AgentRuntime>;
  /** activity 状態を更新し、必要に応じて lastActivityAt も更新する */
  setActivity: (cardId: string, activity: AgentStatus, at: number) => void;
  /** CardFrame 側で派生したサマリを書き込む (HUD 用集計) */
  setSummary: (cardId: string, summary: CardSummary) => void;
  /** カード破棄時に runtime レコードを掃除 */
  clearCard: (cardId: string) => void;
}

export const useAgentActivityStore = create<AgentActivityState>((set) => ({
  byCard: {},
  setActivity: (cardId, activity, at) =>
    set((state) => {
      const prev = state.byCard[cardId];
      // typing / thinking のとき or activity 切替のときは lastActivityAt を進める。
      // idle 復帰時は「最後に出力した時刻」を据え置く (経過時間カウンタが進み続ける)。
      const nextLastAt =
        activity === 'idle' ? (prev?.lastActivityAt ?? null) : at;
      const next: AgentRuntime = {
        activity,
        lastActivityAt: nextLastAt,
        summary: prev?.summary ?? null
      };
      // 参照同一性で React re-render を最小化: activity が同一かつ lastActivityAt が
      // 据え置きなら state を変えない (idle 連発時の不要 publish 抑止)。
      if (
        prev &&
        prev.activity === next.activity &&
        prev.lastActivityAt === next.lastActivityAt
      ) {
        return state;
      }
      return { byCard: { ...state.byCard, [cardId]: next } };
    }),
  setSummary: (cardId, summary) =>
    set((state) => {
      const prev = state.byCard[cardId];
      const next: AgentRuntime = {
        activity: prev?.activity ?? 'idle',
        lastActivityAt: prev?.lastActivityAt ?? null,
        summary
      };
      // 同一サマリ参照なら state を変えない
      if (prev && prev.summary === summary) return state;
      return { byCard: { ...state.byCard, [cardId]: next } };
    }),
  clearCard: (cardId) =>
    set((state) => {
      if (!(cardId in state.byCard)) return state;
      const next = { ...state.byCard };
      delete next[cardId];
      return { byCard: next };
    })
}));
