import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { AtSign, Paperclip, SendHorizontal, Square } from 'lucide-react';
import { CardFrame } from '../CardFrame';
import {
  API_AGENT_PROVIDER_PRESETS,
  type ApiAgentConfig,
  type ApiAgentMessage
} from '../../../../../types/shared';
import { useSettings } from '../../../lib/settings-context';
import { useCanvasStore, NODE_MIN_H, NODE_MIN_W, type CardDataOf } from '../../../stores/canvas';
import { useT } from '../../../lib/i18n';

function isApiAgentConfig(value: unknown): value is ApiAgentConfig {
  return !!value && typeof value === 'object' && (value as { runtime?: string }).runtime === 'api';
}

/** ISO 文字列 → `HH:MM:SS` (ターミナル風タイムスタンプ)。不正値は空文字。 */
function formatClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 行配列を `+---+ / | ... |` の monospace ボックスに整形する (起動バナー用)。 */
function boxify(lines: string[]): string {
  const width = lines.reduce((max, l) => Math.max(max, l.length), 0);
  const bar = `+${'-'.repeat(width + 2)}+`;
  const body = lines.map((l) => `| ${l.padEnd(width)} |`).join('\n');
  return `${bar}\n${body}\n${bar}`;
}

/** 絶対パスの HOME 部分を `~` に畳む (banner の Workspace 表示用)。 */
function tildify(path: string): string {
  return path
    .replace(/^\/Users\/[^/]+/, '~')
    .replace(/^\/home\/[^/]+/, '~')
    .replace(/^[A-Za-z]:\\Users\\[^\\]+/, '~');
}

/** コンポーザ下部のスラッシュコマンド chip。command は literal、説明は i18n。 */
const SLASH_CHIPS: Array<{ cmd: string; descKey: string }> = [
  { cmd: '/plan', descKey: 'canvas.apiChat.cmd.planDesc' },
  { cmd: '/status', descKey: 'canvas.apiChat.cmd.statusDesc' },
  { cmd: '/context', descKey: 'canvas.apiChat.cmd.contextDesc' },
  { cmd: '/clear', descKey: 'canvas.apiChat.cmd.clearDesc' }
];

function ApiAgentChatCardImpl({
  id,
  data
}: NodeProps<Node<CardDataOf<'apiAgent'>>>): JSX.Element {
  const t = useT();
  const { settings } = useSettings();
  const payload = data.payload;
  const setCardPayload = useCanvasStore((s) => s.setCardPayload);
  const [messages, setMessages] = useState<ApiAgentMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [status, setStatus] = useState('');
  const generationRef = useRef<string | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  // team recruit 生成カードは agentId に Hub の instance id が入るため、設定解決は
  // agentConfigId を優先する (通常カードは agentConfigId 未設定で従来どおり agentId, Issue #1021)。
  const configAgentId = payload?.agentConfigId ?? payload?.agentId;
  const agent = useMemo(
    () => (settings.customAgents ?? []).find((a) => a.id === configAgentId),
    [configAgentId, settings.customAgents]
  );
  const apiAgent = isApiAgentConfig(agent) ? agent : null;
  const provider = API_AGENT_PROVIDER_PRESETS.find((p) => p.id === apiAgent?.providerId);
  const sessionId = payload?.sessionId;
  const agentName = data.title || apiAgent?.name || t('settings.customAgents.untitled');
  const configured = !!apiAgent && !!sessionId;

  // 起動バナー (実データから生成)。Agent / Model / Provider / Workspace / Mode / Tools。
  const workspace = settings.lastOpenedRoot || settings.claudeCwd || '';
  const bannerText = useMemo(() => {
    if (!apiAgent) return '';
    const toolMode = apiAgent.toolMode ?? (provider?.supportsTools ? 'auto' : 'readOnly');
    const lines = [
      'vibe-editor API Agent',
      `Agent: ${agentName}`,
      `Model: ${apiAgent.model}`,
      `Provider: ${provider?.label ?? apiAgent.providerId}`,
      `Workspace: ${tildify(workspace) || '—'}`,
      `Mode: ${toolMode === 'auto' ? 'autonomous' : 'read-only'}`
    ];
    if (payload?.teamId) lines.push('Team tools: team_read, team_send, team_info');
    return boxify(lines);
  }, [apiAgent, provider, agentName, workspace, payload?.teamId]);

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight });
  }, [messages, streaming]);

  useEffect(() => {
    let disposed = false;
    if (!apiAgent) return;
    const currentAgent = apiAgent;
    async function load(): Promise<void> {
      let sid = sessionId;
      if (!sid) {
        const created = await window.api.apiAgents.createSession({
          agentId: currentAgent.id,
          providerId: currentAgent.providerId,
          model: currentAgent.model,
          title: currentAgent.name,
          toolMode: currentAgent.toolMode ?? (provider?.supportsTools ? 'auto' : 'readOnly')
        });
        sid = created.sessionId;
        setCardPayload(id, {
          sessionId: sid,
          providerId: currentAgent.providerId,
          model: currentAgent.model,
          toolMode: created.toolMode,
          configured: true
        });
        if (!disposed) setMessages(created.messages);
        return;
      }
      const loaded = await window.api.apiAgents.loadSession(sid);
      if (!disposed && loaded) setMessages(loaded.messages);
    }
    void load().catch((err) => {
      if (!disposed) setStatus(String(err));
    });
    return () => {
      disposed = true;
    };
  }, [apiAgent, id, provider?.supportsTools, sessionId, setCardPayload]);

  useEffect(() => {
    if (!sessionId) return;
    let disposed = false;
    const unsubs: Array<() => void> = [];
    const addUnsub = (unsub: () => void): void => {
      if (disposed) {
        unsub();
        return;
      }
      unsubs.push(unsub);
    };
    const accept = (cardInstanceId: string, generationId: string): boolean =>
      cardInstanceId === id && generationRef.current === generationId;
    void (async () => {
      const events = window.api.apiAgents.events(sessionId);
      addUnsub(
        await events.onDeltaReady((event) => {
          if (disposed || !accept(event.cardInstanceId, event.generationId)) return;
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (last?.id === event.generationId) {
              return [
                ...prev.slice(0, -1),
                { ...last, content: last.content + event.delta }
              ];
            }
            return [
              ...prev,
              {
                id: event.generationId,
                role: 'assistant',
                content: event.delta,
                createdAt: new Date().toISOString()
              }
            ];
          });
        })
      );
      addUnsub(
        await events.onToolReady((event) => {
          if (disposed || !accept(event.cardInstanceId, event.generationId)) return;
          setStatus(`${event.name}: ${event.status}`);
        })
      );
      addUnsub(
        await events.onDoneReady((event) => {
          if (disposed || !accept(event.cardInstanceId, event.generationId)) return;
          generationRef.current = null;
          setStreaming(false);
          setStatus(event.stopReason);
          void window.api.apiAgents.loadSession(sessionId).then((loaded) => {
            if (!disposed && loaded) setMessages(loaded.messages);
          });
        })
      );
      addUnsub(
        await events.onErrorReady((event) => {
          if (disposed || !accept(event.cardInstanceId, event.generationId)) return;
          generationRef.current = null;
          setStreaming(false);
          setStatus(event.message);
        })
      );
    })().catch((err) => {
      if (!disposed) setStatus(String(err));
    });
    return () => {
      disposed = true;
      for (const unsub of unsubs) unsub();
    };
  }, [id, sessionId]);

  const send = useCallback(async () => {
    if (!apiAgent || !sessionId || streaming || !draft.trim()) return;
    const text = draft.trim();
    const generationId = crypto.randomUUID();
    generationRef.current = generationId;
    setDraft('');
    setStreaming(true);
    setStatus('');
    setMessages((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        role: 'user',
        content: text,
        createdAt: new Date().toISOString()
      }
    ]);
    try {
      // team 参加 (Issue #1004): teamId + teamRole が揃うと team tool が有効になる。
      // agentId はカードごとに安定な TeamHub 識別子としてノード id を使う。
      const teamId = payload?.teamId;
      const teamRole = payload?.teamRole?.trim();
      const team =
        teamId && teamRole ? { teamId, agentId: id, role: teamRole } : undefined;
      const result = await window.api.apiAgents.send({
        sessionId,
        cardInstanceId: id,
        generationId,
        agent: apiAgent,
        message: text,
        systemPrompt: apiAgent.systemPrompt,
        team,
        depth: 0,
        turnBudget: 6
      });
      if (!result.ok) {
        generationRef.current = null;
        setStreaming(false);
        setStatus(result.error ?? 'send failed');
      }
    } catch (err) {
      generationRef.current = null;
      setStreaming(false);
      setStatus(err instanceof Error ? err.message : String(err));
    }
  }, [apiAgent, draft, id, payload?.teamId, payload?.teamRole, sessionId, streaming]);

  const cancel = useCallback(() => {
    const generationId = generationRef.current;
    if (!sessionId || !generationId) return;
    generationRef.current = null;
    setStreaming(false);
    void window.api.apiAgents.cancel(sessionId, generationId);
  }, [sessionId]);

  // chip / @ ボタンは破壊的でない: 入力欄にテキストを差し込んでフォーカスするだけ。
  // 例外: /clear はローカル表示履歴をクリアする (server session は消さない)。
  const insertCommand = useCallback((cmd: string) => {
    if (cmd === '/clear') {
      setMessages([]);
      setStatus('');
      return;
    }
    setDraft((d) => (d.trim() ? `${d.trimEnd()} ${cmd} ` : `${cmd} `));
    inputRef.current?.focus();
  }, []);

  const insertMention = useCallback(() => {
    setDraft((d) => `${d}@`);
    inputRef.current?.focus();
  }, []);

  return (
    <>
      <Handle type="target" position={Position.Left} style={{ background: '#d97757' }} />
      <CardFrame
        id={id}
        title={agentName}
        accent={apiAgent?.color ?? '#d97757'}
        minWidth={NODE_MIN_W}
        minHeight={NODE_MIN_H}
      >
        <div className="api-chat">
          {payload?.teamId && (
            <label className="api-chat__team-role">
              <span>{t('canvas.apiAgent.teamRole')}</span>
              <input
                type="text"
                value={payload.teamRole ?? ''}
                onChange={(e) => setCardPayload(id, { teamRole: e.target.value })}
                placeholder={t('canvas.apiAgent.teamRolePlaceholder')}
                spellCheck={false}
              />
            </label>
          )}

          <div className="api-chat__body" ref={bodyRef}>
            {!configured ? (
              <div className="api-chat__empty">{t('canvas.apiChat.configure')}</div>
            ) : (
              <div className="api-chat__intro">
                <pre className="api-chat__banner">{bannerText}</pre>
                <div className="api-chat__sys">
                  {sessionId ? t('canvas.apiChat.ready') : t('canvas.apiChat.loadingPrompt')}
                </div>
              </div>
            )}

            {messages.map((m) => (
              <div key={m.id} className="api-chat__msg" data-role={m.role}>
                <div className="api-chat__msg-head">
                  <span className="api-chat__time">{formatClock(m.createdAt)}</span>
                  <span className="api-chat__who">
                    {m.role === 'user' ? 'user' : agentName}
                  </span>
                </div>
                <div className="api-chat__msg-body">
                  <span className="api-chat__marker" aria-hidden="true">
                    &gt;
                  </span>
                  <span className="api-chat__content">{m.content}</span>
                </div>
              </div>
            ))}

            {streaming && (
              <div className="api-chat__typing">
                <span className="api-chat__dots" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
                {t('canvas.apiChat.typing', { name: agentName })}
              </div>
            )}
          </div>

          {status && <div className="api-chat__status">{status}</div>}

          <form
            className="api-chat__composer"
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <span className="api-chat__prompt" aria-hidden="true">
              ›
            </span>
            <textarea
              ref={inputRef}
              className="api-chat__input"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              disabled={!configured}
              rows={1}
              placeholder={t('canvas.apiChat.placeholder')}
              onKeyDown={(e) => {
                // Enter 送信 / Shift+Enter 改行。IME 変換確定中の Enter は送信しない。
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <div className="api-chat__actions">
              <button
                type="button"
                className="api-chat__icon"
                onClick={insertMention}
                disabled={!configured}
                title={t('canvas.apiChat.mention')}
                aria-label={t('canvas.apiChat.mention')}
              >
                <AtSign size={15} strokeWidth={1.75} />
              </button>
              <button
                type="button"
                className="api-chat__icon"
                disabled
                title={t('canvas.apiChat.attach')}
                aria-label={t('canvas.apiChat.attach')}
              >
                <Paperclip size={15} strokeWidth={1.75} />
              </button>
              <button
                type="button"
                className="api-chat__send"
                onClick={streaming ? cancel : () => void send()}
                disabled={!configured}
                title={streaming ? t('canvas.apiChat.stop') : t('canvas.apiChat.send')}
                aria-label={streaming ? t('canvas.apiChat.stop') : t('canvas.apiChat.send')}
              >
                {streaming ? (
                  <Square size={14} strokeWidth={2} />
                ) : (
                  <SendHorizontal size={16} strokeWidth={1.9} />
                )}
              </button>
            </div>
          </form>

          <div className="api-chat__chips">
            {SLASH_CHIPS.map((c) => (
              <button
                key={c.cmd}
                type="button"
                className="api-chat__chip"
                onClick={() => insertCommand(c.cmd)}
                disabled={!configured && c.cmd !== '/clear'}
              >
                <b>{c.cmd}</b>
                <span>{t(c.descKey)}</span>
              </button>
            ))}
          </div>
        </div>
      </CardFrame>
      <Handle type="source" position={Position.Right} style={{ background: '#d97757' }} />
    </>
  );
}

export default memo(ApiAgentChatCardImpl);
