/**
 * AgentNodeCard 内で共有する型定義。
 *
 * Issue #487: AgentNodeCard 単一ファイルを CardFrame.tsx / TerminalOverlay.tsx /
 * index.tsx に分割した際、両側が読む型をここに集約する。挙動は不変、構造のみ。
 */
import type {
  HandoffReference,
  InjectFailureReason,
  TeamOrganizationMeta
} from '../../../../../../types/shared';

export interface AgentPayload {
  agent?: 'claude' | 'codex';
  /** 新スキーマ: ロール識別子。未設定時は legacy `role` をフォールバックとして読む。 */
  roleProfileId?: string;
  /** @deprecated 旧フィールド。canvas store v2 マイグレーションで roleProfileId に移行済み */
  role?: string;
  teamId?: string;
  agentId?: string;
  command?: string;
  args?: string[];
  cwd?: string;
  /** Claude Code のセッション id。検出時に payload に書き戻し、次回 spawn で
   *  `--resume <id>` を付与して前回会話を復元する。 */
  resumeSessionId?: string | null;
  /**
   * Issue #117: team_recruit の custom_instructions が新規エージェントに渡るように、
   * use-recruit-listener.ts が payload に積んでくる「役職追加指示の生テキスト」。
   *   - Claude  : sysPrompt の末尾に追記して --append-system-prompt に流す。
   *   - Codex   : codex_instructions として一時ファイル化し、起動時に PTY 注入される。
   *   - 動的ロール (instructions ベース) と併用された場合は両方をブレンドする。
   * undefined / 空文字なら「指定なし」と同じ扱い。
   */
  customInstructions?: string;
  /** @deprecated `customInstructions` の旧名。互換のため受理だけする (後方互換)。 */
  codexInstructions?: string;
  /** Issue #359: handoff から新セッションを起動するときに初手で送るプロンプト。 */
  initialMessage?: string;
  /** Issue #370: 複数組織同時運用時の所属表示・履歴復元用情報。 */
  organization?: TeamOrganizationMeta;
  /** Issue #359: 本文はファイル保存し、payload には最新 handoff 参照だけ残す。 */
  latestHandoff?: HandoffReference;
  /**
   * Issue #511: 直近の `team_send` で **この agent への inject** が失敗したときの記録。
   * Hub 側 `team:inject_failed` event を `use-team-inject-failed` フックが受けて、
   * 該当 agent の payload にこのフィールドを書き込む。CardFrame は値が存在するときだけ
   * warning row + retry button を表示する。retry が成功すると null クリアされる
   * (= UI から失敗表示が消える)。
   */
  lastInjectFailure?: {
    /** 元 message の id (retry IPC が同じ message を再 inject する用)。 */
    messageId: number;
    /** `inject_*` 名前空間の安定 code (例: `inject_session_replaced`)。 */
    reason: InjectFailureReason;
    /** RFC3339 失敗時刻。表示用。 */
    failedAt: string;
    /** Hub から見た送信元 role (UI tooltip の "誰からの送信か" 表示用)。 */
    fromRole?: string;
    /** message body の先頭プレビュー (UI tooltip 用、80 文字切り)。 */
    preview?: string;
  };
}

export type AgentStatus = 'idle' | 'thinking' | 'typing';
