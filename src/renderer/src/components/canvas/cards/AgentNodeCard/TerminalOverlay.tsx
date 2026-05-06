/**
 * AgentNodeCard / TerminalOverlay
 *
 * Issue #487: AgentNodeCard 単一ファイルから「PTY / xterm との配線」を切り出し
 * たもの。CardFrame は枠 / role visual / handoff UI を担当し、本ファイルは
 *   - TerminalView の mount + props 配線
 *   - 出力アクティビティ → AgentStatus 'typing/idle' の自動遷移 (idle timer)
 *   - ユーザー入力バッファ → 入力確定時に auto-summary をカードタイトルへ反映
 *   - sessionId 検出 → payload.resumeSessionId への書き戻し
 *   - Canvas zoom 下での論理 px ベース fit (useCanvasTerminalFit)
 *   - NodeResizer 縮小→拡大時の xterm scroll-to-bottom 補正
 *   - recruit 経路の spawn 失敗 ack (useRecruitSpawnAck)
 * を担当する。挙動は元 AgentNodeCard.tsx と完全一致。構造のみ整理。
 */
import { useCallback, useEffect, useRef } from 'react';
import { TerminalView, type TerminalViewHandle } from '../../../TerminalView';
import { useSettings } from '../../../../lib/settings-context';
import { useCanvasStore } from '../../../../stores/canvas';
import { useCanvasTerminalFit } from '../../../../lib/use-canvas-terminal-fit';
import { useXtermScrollToBottomOnResize } from '../../../../lib/use-xterm-scroll-on-resize';
import { useRecruitSpawnAck } from '../../../../lib/use-terminal-spawn';
import type { AgentPayload, AgentStatus } from './types';

/**
 * デフォルト (auto-summary 上書き対象) のタイトルかを判定。
 * "Claude #1" / "Codex #2" / "Leader" 等は上書き OK、ユーザーが手で付けた名前は守る。
 */
function isAutoTitle(t: string): boolean {
  return /^(Claude|Codex|Agent|Leader|Planner|Programmer|Researcher|Reviewer)( #\d+)?$/i.test(
    t.trim()
  );
}

/** ユーザー入力テキストから「機能追加」のような短いタイトルを抽出 */
function summarizeInput(text: string): string {
  const cleaned = text
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length === 0) return '';
  // 30 文字で切り詰め、句読点で更に切る
  const cut = cleaned.slice(0, 30);
  const punct = cut.search(/[。．、,]/);
  return punct > 4 ? cut.slice(0, punct) : cut;
}

export interface TerminalOverlayProps {
  /** Canvas store のノード id。setCardTitle / setCardPayload 用 */
  cardId: string;
  /** TerminalView へ渡す ref。CardFrame 側で handoff 注入のため共有する */
  termRef: React.MutableRefObject<TerminalViewHandle | null>;
  payload: AgentPayload;
  title: string;
  /** 表示用ロール (roleProfileId 不在時のフォールバック含む解決済み値) */
  roleProfileId: string;
  /** 解決済み起動引数。CardFrame 側で sysPrompt / customInstructions 含めて組み立て済み */
  cwd: string;
  command: string;
  args?: string[];
  codexInstructions?: string;
  /** Issue #359: 新セッション起動時に初手で送るプロンプト */
  initialMessage?: string;
  /** ヘッダー行に表示する pty 状態文字列を CardFrame に上げる */
  onStatus: (status: string) => void;
  /** 出力アクティビティ → CardFrame の StatusBadge に反映。
   *  React の setState (Dispatch<SetStateAction<AgentStatus>>) を直接渡し、
   *  既存実装どおり関数形 updater で 'idle' 復帰時の不要 re-render を抑止する。 */
  onActivity: React.Dispatch<React.SetStateAction<AgentStatus>>;
}

export function TerminalOverlay({
  cardId,
  termRef,
  payload,
  title,
  roleProfileId,
  cwd,
  command,
  args,
  codexInstructions,
  initialMessage,
  onStatus,
  onActivity
}: TerminalOverlayProps): JSX.Element {
  const { settings } = useSettings();
  const setCardTitle = useCanvasStore((s) => s.setCardTitle);
  const setCardPayload = useCanvasStore((s) => s.setCardPayload);
  // Issue #261: NodeResizer でカードを縮めたあと再度広げたとき、内部 `.xterm-viewport`
  // の scrollTop が中途半端な位置で残って「末尾が見えない」状態になることがある。
  // `.canvas-agent-card__term` 自体のサイズ変化を ResizeObserver で監視し、
  // 子の `.xterm-viewport` を末尾までスクロールし直す。
  const termContainerRef = useRef<HTMLDivElement | null>(null);
  // Issue #253: Canvas zoom 下でも論理 px ベースで cols/rows を確定させる
  const fit = useCanvasTerminalFit(settings);
  // Issue #342 Phase 1: recruit 経路の spawn 失敗を Hub に ack するためのコールバック。
  // payload.agentId / payload.teamId が揃っているとき (= 通常の AgentNode は常に揃う)
  // のみ実体化し、それ以外は no-op を返す。
  const onSpawnError = useRecruitSpawnAck(payload.agentId, payload.teamId);
  // Phase 4: ステータスバッジ。出力を最近受け取ったら typing、暫く来なければ idle。
  // Issue #125: 旧実装は 200ms 周期の setInterval を全 AgentNodeCard が常時動かしており
  // 30 カード並ぶと idle 中も毎秒 150 回 timer が起きていた。
  // → 出力イベント (handleActivity) の都度 setTimeout を立て直し、idle 復帰でクリアする。
  //   typing 状態の間しかタイマーが動かないので idle 時はゼロコスト。
  // useCallback で参照固定: TerminalView に渡す onActivity が毎レンダー新規になると、
  //   TerminalView 内部の effect (handler 再 attach) が無駄に再実行される。
  const idleTimerRef = useRef<number | null>(null);
  const handleActivity = useCallback((): void => {
    onActivity('typing');
    if (idleTimerRef.current !== null) {
      window.clearTimeout(idleTimerRef.current);
    }
    idleTimerRef.current = window.setTimeout(() => {
      idleTimerRef.current = null;
      // 関数形 updater で「既に idle」なら state を更新しない (元実装互換)。
      onActivity((prev) => (prev !== 'idle' ? 'idle' : prev));
    }, 600);
  }, [onActivity]);
  useEffect(() => {
    return () => {
      if (idleTimerRef.current !== null) {
        window.clearTimeout(idleTimerRef.current);
        idleTimerRef.current = null;
      }
    };
  }, []);

  // ----- ユーザー入力から auto-summary タイトル -----
  // 入力をバッファし、Enter (\r) を押した瞬間にバッファ内容をタイトル化する。
  // 既にユーザーが手で名付けた (auto title 形式でない) 場合は上書きしない。
  // title は user 入力で都度上書きされうるが、判定は確定タイミングだけなので ref で読む
  // → callback 自体は (cardId, setCardTitle) のみに依存させて識別子を安定化。
  const inputBufferRef = useRef('');
  const titleRef = useRef(title);
  titleRef.current = title;
  const handleUserInput = useCallback(
    (raw: string): void => {
      if (!raw) return;
      // 制御コードのうち BS, ESC, 矢印キー等は無視。Enter (\r/\n) は確定トリガ。
      for (const ch of raw) {
        const code = ch.charCodeAt(0);
        if (ch === '\r' || ch === '\n') {
          const text = inputBufferRef.current;
          inputBufferRef.current = '';
          const summary = summarizeInput(text);
          if (summary && isAutoTitle(titleRef.current)) {
            setCardTitle(cardId, summary);
          }
        } else if (code === 0x7f || code === 0x08) {
          // Backspace
          inputBufferRef.current = inputBufferRef.current.slice(0, -1);
        } else if (code === 0x1b) {
          // ESC シーケンス開始 → 同チャンク内の残りも捨てる近似
          return;
        } else if (code >= 0x20) {
          inputBufferRef.current += ch;
          // 暴走防止: 200 文字超えたらリセット
          if (inputBufferRef.current.length > 200) {
            inputBufferRef.current = inputBufferRef.current.slice(-200);
          }
        }
      }
    },
    [cardId, setCardTitle]
  );

  // Issue #261 / #272 / #272 v3: termContainer のサイズ変化時に xterm 自前の
  // scroll model 経由で末尾までスクロールし直す。NodeResizer の縮小→拡大で
  // scrollback 末尾が見切れるのを防ぐ。callback は xterm v6 の SmoothScrollableElement
  // に正しく届くよう `Terminal.scrollToBottom()` を public API 経由で叩く
  // (DOM の scrollTop 書換えは内部 scroll model と同期しないため使えない)。
  const scrollToBottom = useCallback(() => {
    termRef.current?.scrollToBottom();
  }, [termRef]);
  useXtermScrollToBottomOnResize(termContainerRef, scrollToBottom);

  // TerminalView に渡す onSessionId を useCallback 化。インライン lambda だと
  // setActivity / status の局所 setState で AgentNodeCard が再描画するたび
  // TerminalView 側の onSessionId が新規参照になり、内部 deps 経由の handler 差替えが起きる。
  const handleSessionId = useCallback(
    (sid: string): void => {
      if (sid) setCardPayload(cardId, { resumeSessionId: sid });
    },
    [cardId, setCardPayload]
  );

  return (
    <div
      className="nodrag nowheel canvas-agent-card__term"
      ref={termContainerRef}
    >
      <TerminalView
        ref={termRef}
        // Issue #271: HMR remount で同じ PTY へ再 bind するための論理キー。
        // ノード id は @xyflow/react canvas store で永続化されているので、
        // HMR を跨いでも同一カードを一意に識別できる。
        sessionKey={`canvas-agent:${cardId}`}
        cwd={cwd}
        fallbackCwd={cwd}
        command={command}
        // Issue #341: payload.args が空配列で永続化された場合に settings 由来の args が
        // 潰れないようガード (`?? args` だと `[]` でも truthy 扱いで args が無視される)。
        args={payload.args && payload.args.length > 0 ? payload.args : args}
        codexInstructions={codexInstructions}
        visible={true}
        teamId={payload.teamId}
        agentId={payload.agentId}
        role={roleProfileId}
        initialMessage={initialMessage}
        onStatus={onStatus}
        onActivity={handleActivity}
        onUserInput={handleUserInput}
        onSessionId={handleSessionId}
        // Issue #342 Phase 1: terminal_create 失敗を Hub に ack(false) する。
        // 30 秒の handshake timeout を待たず、recruit MCP に構造化エラーが即返る。
        onSpawnError={onSpawnError}
        // Canvas zoom で xterm canvas が滲むのを避けるため WebGL を切る (DOM renderer 固定)。
        // text は実 DOM になるので Chromium が親 transform に応じて再ラスタライズしシャープに描く。
        disableWebgl
        // Issue #272 v4: Canvas モードではホイールを scrollback スクロールへ強制ルーティング
        // (xterm mouse protocol が wheel を消費して scrollback が動かない問題の対策)
        forceWheelScrollback
        // Issue #253: 論理 px ベース fit + zoom 購読 + 可観測性
        unscaledFit={fit.unscaledFit}
        getCellSize={fit.getCellSize}
        zoomSubscribe={fit.zoomSubscribe}
        getZoom={fit.getZoom}
      />
    </div>
  );
}
