/**
 * AgentNodeCard / CardHandoff
 *
 * Issue #735: 旧 `CardFrame.tsx` (~900 行 god card) から「Leader 専用の handoff
 * 作成ボタン + bracketed-paste 注入フロー」(Issue #423) を切り出した子コンポーネント。
 *
 * Leader カードのヘッダーに置く小さなボタン 1 つと、その押下フロー:
 *   1. Rust 側 `handoffs.create` で handoff JSON / Markdown を確実に保存
 *   2. 保存先パス + MCP 手順を Leader 自身の PTY に bracketed paste で注入
 *   3. Leader (Claude/Codex) が `team_create_leader` → `team_send` → `team_switch_leader`
 *      を順に叩き、自律的に新 Leader へ交代する
 *
 * Leader 以外のカードでは描画されない (`null` を返す)。
 * 挙動・DOM・クラス名・トーストは元 `CardFrame.tsx` の handoff ボタンと完全一致。
 */
import { useCallback, useState, type RefObject } from 'react';
import { ClipboardCheck } from 'lucide-react';
import type { useToast } from '../../../../lib/toast-context';
import type { TerminalViewHandle } from '../../../TerminalView';
import type {
  HandoffCheckpoint,
  HandoffReference
} from '../../../../../../types/shared';
import type { AgentPayload } from './types';

/** i18n の `t` 関数シグネチャ。 */
type TFn = (key: string, params?: Record<string, string | number>) => string;

/** CardFrame から渡される `showToast` (useToast の戻り値そのまま)。 */
type ShowToastFn = ReturnType<typeof useToast>['showToast'];

/**
 * 絶対パスからファイル名だけを返す。Windows (`\`) と POSIX (`/`) の両方に対応するため
 * path モジュールを使わず手元で処理する (renderer 側に node:path は無い)。
 */
function basenameOf(absPath: string): string {
  const normalized = absPath.replace(/\\/g, '/');
  const idx = normalized.lastIndexOf('/');
  return idx >= 0 ? normalized.slice(idx + 1) : normalized;
}

function handoffReferenceOf(
  handoff: HandoffCheckpoint | HandoffReference
): HandoffReference {
  return {
    id: handoff.id,
    kind: handoff.kind,
    status: handoff.status,
    createdAt: handoff.createdAt,
    updatedAt: handoff.updatedAt,
    jsonPath: handoff.jsonPath,
    markdownPath: handoff.markdownPath,
    fromAgentId: handoff.fromAgentId,
    toAgentId: handoff.toAgentId,
    replacementForAgentId: handoff.replacementForAgentId
  };
}

/**
 * Issue #423: Leader 自身に「引き継ぎ手順」を伝える PTY 注入用プロンプトを組み立てる。
 * UI 側で handoff document を保存した直後、保存先パスをこのプロンプトに埋めて Leader の
 * PTY に bracketed paste で注入する。Leader は MCP `team_create_leader` → `team_switch_leader`
 * を呼び、自律的に新 Leader へ交代する。
 */
function buildLeaderHandoffPrompt(markdownPath: string, handoffId: string): string {
  return [
    '【引き継ぎ手順】',
    '',
    `引き継ぎ書を保存しました: ${markdownPath}`,
    `Handoff id: ${handoffId}`,
    '',
    '次の手順で引き継ぎを完了してください:',
    '1. 上記 handoff markdown を Read tool で読み、現在の作業状況・未完了タスク・次アクションを確認する。',
    '2. 必要なら handoff の Notes / Next Actions を補強する追加メモを書き足す。',
    '3. MCP tool `team_create_leader` を呼び、新しい Leader を採用する:',
    `     team_create_leader({ handoff_id: "${handoffId}" })`,
    '   返り値の `agentId` を控えること。',
    '4. 新 Leader が起動したら、`team_send` で agentId 宛にこの handoff のパスと「お前が新 Leader だ」という旨を伝える:',
    `     team_send({ to: "<上で得た agentId>", handoff_id: "${handoffId}", message: "あなたが新 Leader です。handoff を読んで team_ack_handoff({ handoff_id: '${handoffId}' }) を呼び、ACK を返してください: ${markdownPath}" })`,
    '5. 新 Leader が `team_ack_handoff` と ACK を返したら、MCP tool `team_switch_leader` を呼ぶ:',
    `     team_switch_leader({ new_leader_agent_id: "<上で得た agentId>", handoff_id: "${handoffId}" })`,
    '   呼び出し成功後、約 2 秒で自分のカードが自動的に閉じられる。',
    '',
    '上記を順に実行してください。'
  ].join('\n');
}

/** 文字列を bracketed paste マーカーで包む。Claude/Codex TUI に「1 件のペースト」として渡る。 */
function wrapBracketedPaste(text: string): string {
  return `\x1b[200~${text}\x1b[201~`;
}

interface CardHandoffProps {
  /** Canvas ノード id (handoff の notes / setCardPayload 用)。 */
  cardId: string;
  /** agent payload (teamId / agentId / agent / cwd / resumeSessionId を読む)。 */
  payload: AgentPayload;
  /** 解決済みロール識別子。'leader' のときだけボタンを描画する。 */
  roleProfileId: string;
  /** カードタイトル (handoff content の表示用)。 */
  title: string;
  /** ロール表示ラベル (handoff summary の表示用)。 */
  visualLabel: string;
  /** 解決済み cwd (handoff 保存先 projectRoot の第一候補)。 */
  cwd: string;
  /** TerminalOverlay と共有する terminal handle (PTY 注入 / バッファ取得)。 */
  termRef: RefObject<TerminalViewHandle | null>;
  /** canvas store の setCardPayload (payload.latestHandoff 更新用)。 */
  setCardPayload: (id: string, patch: Record<string, unknown>) => void;
  showToast: ShowToastFn;
  t: TFn;
}

/**
 * Issue #735: 旧 CardFrame の Leader 専用 handoff ボタン。
 * `roleProfileId !== 'leader'` のカードでは `null` を返す。
 */
export function CardHandoff({
  cardId,
  payload,
  roleProfileId,
  title,
  visualLabel,
  cwd,
  termRef,
  setCardPayload,
  showToast,
  t
}: CardHandoffProps): JSX.Element | null {
  const [handoffBusy, setHandoffBusy] = useState(false);

  // Issue #375 / #423: createHandoff は副作用 (handoff の保存 + payload.latestHandoff 更新) のみ
  // 行い、success toast は呼び出し側 (handleCreateHandoffClick) に任せる。
  // 呼び出し側で「保存先のパス」を PTY 注入用に取り出すため、戻り値の HandoffCheckpoint は必須。
  const createHandoff = useCallback(async (): Promise<HandoffCheckpoint | null> => {
    const projectRoot = cwd || payload.cwd || '';
    if (!projectRoot) {
      showToast(t('handoff.error.noProject'), { tone: 'error', duration: 8000 });
      return null;
    }
    const snapshot = termRef.current?.getBufferText(120) ?? '';
    const kind = roleProfileId === 'leader' ? 'leader' : 'worker';
    const result = await window.api.handoffs.create({
      projectRoot,
      teamId: payload.teamId ?? null,
      kind,
      fromAgentId: payload.agentId ?? null,
      fromRole: roleProfileId,
      fromAgent: payload.agent ?? 'claude',
      fromTitle: title,
      sourceSessionId: payload.resumeSessionId ?? null,
      replacementForAgentId: payload.agentId ?? null,
      retireAfterAck: true,
      trigger: 'manual',
      content: {
        summary: `${title} (${visualLabel}) の Canvas handoff。保存時点の terminal snapshot と次アクションを含みます。`,
        decisions: ['この handoff は既存セッションを --resume せず、新しいセッションへ注入するための継続メモとして保存されました。'],
        filesTouched: [],
        openTasks: ['handoff markdown を読み、現在の作業目的・未完了タスク・次アクションを確認する。'],
        risks: ['terminal snapshot は直近の表示内容ベースのため、完全な会話履歴ではありません。必要なら旧 agent / team history を確認してください。'],
        nextActions: ['handoff を読んだら ack を返し、Next Actions に沿って作業を継続する。'],
        verification: ['handoff 作成時点では自動検証は未実行です。'],
        notes: [`Canvas card: ${cardId}`, payload.teamId ? `Team: ${payload.teamId}` : 'Standalone agent'],
        terminalSnapshot: snapshot.slice(-16_000) || null
      }
    });
    if (!result.ok || !result.handoff) {
      throw new Error(result.error ?? 'handoff create failed');
    }
    setCardPayload(cardId, { latestHandoff: handoffReferenceOf(result.handoff) });
    return result.handoff;
  }, [
    cwd,
    cardId,
    visualLabel,
    payload.agent,
    payload.agentId,
    payload.cwd,
    payload.resumeSessionId,
    payload.teamId,
    roleProfileId,
    setCardPayload,
    showToast,
    t,
    title,
    termRef
  ]);

  // Issue #423: ボタン押下時のフロー
  //   1. Rust 側 `handoffs.create` で handoff JSON / Markdown を確実に保存
  //   2. 保存先パス + MCP 手順を Leader 自身の PTY に bracketed paste で注入
  //   3. Leader (Claude/Codex) が `team_create_leader` → `team_send` → `team_switch_leader`
  //      を順に叩き、自律的に新 Leader へ交代する
  // Leader 以外のカードでは押せない (worker の引き継ぎは将来の別 issue で対応)。
  const handleCreateHandoffClick = useCallback(() => {
    if (handoffBusy) return;
    if (roleProfileId !== 'leader') {
      showToast(t('handoff.error.notLeader'), { tone: 'error', duration: 6000 });
      return;
    }
    setHandoffBusy(true);
    void createHandoff()
      .then((handoff) => {
        if (!handoff) return; // noProject 等は createHandoff 側で error toast を出している
        const fileName = basenameOf(handoff.markdownPath);
        const markdownPath = handoff.markdownPath;
        // Leader の PTY に「引き継ぎ手順」プロンプトを bracketed paste で注入。
        // sendCommand(text, submit=true) は末尾に \r を付けて送信するため、
        // 全文が 1 つの paste として確定 → Claude/Codex が読み取って MCP を叩き始める。
        try {
          const prompt = buildLeaderHandoffPrompt(markdownPath, handoff.id);
          termRef.current?.sendCommand(wrapBracketedPaste(prompt), true);
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          showToast(t('handoff.error.injectFailed', { detail }), {
            tone: 'error',
            duration: 8000
          });
          return;
        }
        showToast(t('handoff.created', { file: fileName }), {
          tone: 'success',
          duration: 8000,
          action: {
            label: t('handoff.action.reveal'),
            onClick: () => {
              void window.api.app.revealInFileManager(markdownPath).catch((err) => {
                console.warn('[handoff] reveal failed:', err);
              });
            }
          }
        });
      })
      .catch((err) => {
        console.warn('[handoff] create failed:', err);
        const detail = err instanceof Error ? err.message : String(err);
        showToast(t('handoff.error.createFailed', { detail }), {
          tone: 'error',
          duration: 8000
        });
      })
      .finally(() => setHandoffBusy(false));
  }, [createHandoff, handoffBusy, roleProfileId, showToast, t, termRef]);

  if (roleProfileId !== 'leader') return null;

  return (
    <button
      type="button"
      className="nodrag canvas-agent-card__tool"
      onClick={handleCreateHandoffClick}
      disabled={handoffBusy}
      title={t('handoff.createTooltip')}
      aria-label={t('handoff.create')}
    >
      <ClipboardCheck size={13} strokeWidth={1.9} />
    </button>
  );
}
