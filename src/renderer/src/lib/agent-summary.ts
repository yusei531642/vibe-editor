/**
 * agent-summary — Canvas 上の各 Agent カードと Canvas 全体の状態要約を組み立てる純粋関数群。
 *
 * Issue #521: 「誰が何を / いつから / 次に何が必要か」を 1 行で把握できるよう、
 *   - カード単位の 3 行サマリ (current task / 経過 / 次に Leader 入力が必要か)
 *   - Canvas 全体の集計 (active / blocked / stale / completed)
 * を計算するロジックを 1 箇所に集約する。
 *
 * ここは IPC を呼ばない: 既存の AgentPayload と CardFrame 内で測れる lastActivityAt のみを
 * 入力にして派生する。Issue #510 / #514 の diagnostics + tasks IPC が後追いで入ったら、
 * `tauri-api/team.ts` 側の合成 wrapper がここを呼びつつ実値を流し込めるようにする。
 */
import type { Node } from '@xyflow/react';
import type { CardData } from '../stores/canvas';
import type { AgentPayload, AgentStatus } from '../components/canvas/cards/AgentNodeCard/types';

/**
 * 「次に Leader 入力が必要か」と判定する idle しきい値 (ms)。
 * Worker が `idle` 状態のまま 90 秒以上沈黙していれば、何らかの確認/指示待ちとみなす。
 * 短すぎると「思考中の長い 1 ターン」を Leader 待ちと誤検出するため余裕を取る。
 */
export const NEEDS_LEADER_IDLE_MS = 90_000;

/**
 * 「停滞 (stale)」とみなす最終出力からの経過時間 (ms)。
 * Issue #514 のダッシュボード stale カウントと一致させるため 5 分。
 */
export const STALE_OUTPUT_MS = 5 * 60_000;

export interface CardSummaryInput {
  payload: AgentPayload;
  /** ロール解決済み (leader / planner / worker / ...) */
  roleProfileId: string;
  /** カードタイトル (auto-summary 含む) */
  title: string;
  /** 現在のアクティビティ状態 (`idle` / `thinking` / `typing`) */
  activity: AgentStatus;
  /** 直近で出力 or 入力イベントがあった unix ms。未観測なら null。 */
  lastActivityAt: number | null;
  /** 表示時刻 (Date.now()) — テスト容易性のため引数に外出し */
  now: number;
}

export interface CardSummary {
  /** 1 行目: 現在のタスク (空文字列なら呼び出し側でフォールバック表示) */
  taskTitle: string;
  /** 2 行目: 「最終出力から N 秒/分/時間前」のローカライズ済みテキスト or null (未観測) */
  lastOutputAgo: { unit: 'now' | 'sec' | 'min' | 'hour' | 'day'; value: number } | null;
  /** 3 行目: Leader 入力待ちかどうか (true のときだけ警告行を出す) */
  needsLeaderInput: boolean;
  /** 集計用: 停滞しているか */
  isStale: boolean;
  /** 集計用: handoff 等で「完了」状態に達しているか */
  isCompleted: boolean;
  /** 集計用: アクティブに動いているか (typing / thinking) */
  isActive: boolean;
}

/**
 * カード 1 枚分のサマリを派生する。
 * 副作用無し / DOM 非依存 / 同じ input なら同じ output になる。
 */
export function deriveCardSummary(input: CardSummaryInput): CardSummary {
  const { payload, roleProfileId, title, activity, lastActivityAt, now } = input;

  const taskTitle = pickTaskTitle(payload, title);
  const lastOutputAgo =
    lastActivityAt === null ? null : formatRelativeMs(now - lastActivityAt);

  const handoffStatus = payload.latestHandoff?.status ?? null;
  const handoffWaitingAck =
    handoffStatus === 'created' || handoffStatus === 'injected';
  const handoffCompleted =
    handoffStatus === 'acked' ||
    handoffStatus === 'acknowledged' ||
    handoffStatus === 'retired';

  const isActive = activity === 'thinking' || activity === 'typing';
  const idleMs = lastActivityAt === null ? Infinity : now - lastActivityAt;
  const idleLong = idleMs >= NEEDS_LEADER_IDLE_MS;
  const isStale = idleMs >= STALE_OUTPUT_MS;
  // Worker が長く沈黙、もしくは leader への ack 待ちが残っているなら Leader 入力を促す。
  // Leader カード自身は判定対象外 (Leader が Leader を待つことは無いため)。
  const needsLeaderInput =
    roleProfileId !== 'leader' && (handoffWaitingAck || (idleLong && !isActive));

  return {
    taskTitle,
    lastOutputAgo,
    needsLeaderInput,
    isStale: isStale && !isActive,
    isCompleted: handoffCompleted,
    isActive
  };
}

/**
 * payload から「現在のタスクっぽい 1 行テキスト」を取り出す。
 * 優先順位:
 *   1. payload.initialMessage (handoff 経由の起動プロンプト)
 *   2. payload.customInstructions / codexInstructions (Leader recruit 時の追加指示)
 * カードタイトルは header 側で既に表示されるためサマリ行では敢えて参照しない
 * (重複表示にならないよう header との役割分担を保つ)。すべて空なら空文字列を
 * 返し、呼び出し側で「未割当」フォールバック表示する。
 * 第 2 引数 `_title` は将来 title から拾う必要が出たとき用に残してある。
 */
export function pickTaskTitle(payload: AgentPayload, _title: string): string {
  const sources = [
    payload.initialMessage,
    payload.customInstructions,
    payload.codexInstructions
  ];
  for (const raw of sources) {
    if (!raw) continue;
    const cleaned = raw.replace(/\s+/g, ' ').trim();
    if (!cleaned) continue;
    return truncateTaskTitle(cleaned, 64);
  }
  return '';
}

/**
 * タスクタイトルの末尾省略。CJK 1 文字 = 1 列前提のシンプル切り詰め。
 * 長過ぎる prompt がカード幅を破壊しないように使う。
 */
export function truncateTaskTitle(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + '…';
}

/**
 * 経過時間を「単位 + 値」に正規化する。i18n 文字列はここでは組まず、呼び出し側で
 * `t('agentCard.summary.ago.min', { value })` 等に流す。
 *
 * 範囲:
 *   - < 5 秒: now (たった今)
 *   - < 60 秒: sec
 *   - < 60 分: min
 *   - < 24 時間: hour
 *   - それ以上: day
 */
export function formatRelativeMs(
  diffMs: number
): { unit: 'now' | 'sec' | 'min' | 'hour' | 'day'; value: number } {
  const ms = Math.max(0, diffMs);
  if (ms < 5_000) return { unit: 'now', value: 0 };
  if (ms < 60_000) return { unit: 'sec', value: Math.floor(ms / 1_000) };
  if (ms < 3_600_000) return { unit: 'min', value: Math.floor(ms / 60_000) };
  if (ms < 86_400_000) return { unit: 'hour', value: Math.floor(ms / 3_600_000) };
  return { unit: 'day', value: Math.floor(ms / 86_400_000) };
}

export interface TeamSummaryAggregate {
  total: number;
  active: number;
  blocked: number;
  stale: number;
  completed: number;
}

export interface TeamAggregateInput {
  /** Agent カードのみ。caller 側で `n.type === 'agent'` でフィルタ済みを渡す。 */
  agentNodes: Node<CardData>[];
  /** カード id -> CardSummary。CardFrame 側からブロードキャストされた最新値を集約する。 */
  cardSummaries: Record<string, CardSummary>;
}

/**
 * 全 agent カードの CardSummary から HUD 用集計を作る。
 * cardSummaries に未登録のカードは「unknown / count しない」扱い。
 */
export function aggregateTeamSummary(input: TeamAggregateInput): TeamSummaryAggregate {
  let total = 0;
  let active = 0;
  let blocked = 0;
  let stale = 0;
  let completed = 0;
  for (const node of input.agentNodes) {
    if (node.type !== 'agent') continue;
    total += 1;
    const summary = input.cardSummaries[node.id];
    if (!summary) continue;
    if (summary.isCompleted) {
      completed += 1;
      continue;
    }
    if (summary.needsLeaderInput) blocked += 1;
    else if (summary.isStale) stale += 1;
    else if (summary.isActive) active += 1;
  }
  return { total, active, blocked, stale, completed };
}
