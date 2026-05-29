// Issue #825: AI が `send_to_leader` で渡してきた text に危険キーワードが含まれているか
// 判定する純粋関数。Renderer 側の最終 fail-safe (VoiceConfirmModal) のトリガーに使う。
//
// MVP は単純な keyword regex マッチ。`confirmationMode === 'bypass'` のときはこの判定を
// 完全に skip して即実行する (caller 側で confirmationMode を見て分岐)。
// Phase 2 で `safetyLevel='blocked'` のリストを追加予定。
//
// `safe` だけが「即実行可」、`confirm` は UI で modal 確認、`blocked` は即拒否 (今は未使用)。

import type { VoiceCommandStatus } from '../../../types/shared';

export type VoiceSafetyLevel = 'safe' | 'confirm' | 'blocked';

/**
 * 「うっかり実行されると取り返しがつかない」操作を含む発話。case-insensitive で部分マッチ。
 * 過剰に攻撃的だが MVP では false positive を許容する (誤検出時はユーザーが UI で OK を押す)。
 */
const DANGER_PATTERNS: RegExp[] = [
  /\bgit\s+push\b/i,
  /\bgit\s+reset\b/i,
  /\bgit\s+rebase\b/i,
  /\brm\s+-r?f?\b/i,
  /\bsudo\b/i,
  /\bdelete\b/i,
  /\bdrop\s+(database|table)\b/i,
  /\bdeploy(?:ment)?\b/i,
  /\bproduction\b/i,
  /\b--force\b/i,
  /\bforce[\s-]?push\b/i,
  /\b本番\b/u
];

/**
 * 危険ではないが注意したいキーワード (`safe` のまま扱うが、UI で hint を出す余地に使える)。
 * MVP では `safe` 扱いに留め、`confirm` には昇格しない。
 */
const CAUTION_PATTERNS: RegExp[] = [/\bmerge\b/i, /\brevert\b/i];

export interface VoiceSafetyAssessment {
  level: VoiceSafetyLevel;
  /** マッチした pattern の source 配列 (UI hint 用、空配列なら hit なし)。 */
  matched: string[];
}

/**
 * `text` が危険キーワードを含むか判定する。
 *
 * - 危険パターンが 1 つ以上ヒット → `confirm`
 * - 注意パターンのみ → `safe` (matched に source を載せる)
 * - 何も hit しない → `safe`
 *
 * `blocked` は Phase 2 で別ロジックを追加する。
 */
export function assessVoiceSafety(text: string): VoiceSafetyAssessment {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { level: 'safe', matched: [] };
  }
  const dangerHits = DANGER_PATTERNS.filter((re) => re.test(trimmed)).map((re) => re.source);
  if (dangerHits.length > 0) {
    return { level: 'confirm', matched: dangerHits };
  }
  const cautionHits = CAUTION_PATTERNS.filter((re) => re.test(trimmed)).map((re) => re.source);
  return { level: 'safe', matched: cautionHits };
}

/**
 * 「現在ボタンが操作可能か」を 3 条件 (Canvas モード / enabled / hasApiKey) から判定する
 * 補助関数。caller が React 側で集約するときの一貫した判定に使う。
 */
export function isVoiceButtonClickable(opts: {
  status: VoiceCommandStatus;
  enabled: boolean;
  hasApiKey: boolean;
}): boolean {
  if (!opts.enabled || !opts.hasApiKey) {
    return false;
  }
  return opts.status === 'idle' || opts.status === 'listening' || opts.status === 'error';
}
