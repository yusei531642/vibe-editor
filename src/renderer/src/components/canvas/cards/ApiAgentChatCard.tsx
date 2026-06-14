import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { Send, Square } from 'lucide-react';
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

  const title = data.title || apiAgent?.name || t('settings.customAgents.untitled');
  const configured = !!apiAgent && !!sessionId;

  return (
    <>
      <Handle type="target" position={Position.Left} style={{ background: '#d97757' }} />
      <CardFrame id={id} title={title} accent={apiAgent?.color ?? '#d97757'} minWidth={NODE_MIN_W} minHeight={NODE_MIN_H}>
        <div className="api-agent-card">
          <div className="api-agent-card__meta">
            <span>{provider?.label ?? apiAgent?.providerId ?? 'API'}</span>
            <span>{apiAgent?.model ?? 'unconfigured'}</span>
            {apiAgent?.toolMode === 'readOnly' || provider?.supportsTools === false ? (
              <span>read-only</span>
            ) : null}
          </div>
          {payload?.teamId && (
            <label className="api-agent-card__team-role">
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
          <div className="api-agent-card__messages" ref={bodyRef}>
            {!configured && (
              <div className="api-agent-card__empty">
                Configure this API agent in Settings.
              </div>
            )}
            {messages.map((m) => (
              <div key={m.id} className={`api-agent-card__msg api-agent-card__msg--${m.role}`}>
                <span className="api-agent-card__role">{m.role}</span>
                <div>{m.content}</div>
              </div>
            ))}
          </div>
          {status && <div className="api-agent-card__status">{status}</div>}
          <form
            className="api-agent-card__composer"
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              disabled={!configured}
              rows={2}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <button type="button" className="canvas-btn" onClick={streaming ? cancel : send} disabled={!configured}>
              {streaming ? <Square size={14} /> : <Send size={14} />}
            </button>
          </form>
        </div>
      </CardFrame>
      <Handle type="source" position={Position.Right} style={{ background: '#d97757' }} />
    </>
  );
}

export default memo(ApiAgentChatCardImpl);
