// tauri-api/api-agents.ts — API-driven Canvas Chat agents (Issue #994)

import { subscribeEventReady } from '../subscribe-event';
import { invokeCommand } from './command-error';
import type {
  ApiAgentDoneEvent,
  ApiAgentErrorEvent,
  ApiAgentImportableSkill,
  ApiAgentSendRequest,
  ApiAgentSendResult,
  ApiAgentSession,
  ApiAgentSessionCreateRequest,
  ApiAgentSkillMeta,
  ApiAgentSkillSource,
  ApiAgentStreamEvent,
  ApiAgentToolEvent
} from '../../../../types/shared';

export const apiAgents = {
  setProviderKey: (providerId: string, key: string): Promise<void> =>
    invokeCommand('api_agent_provider_set_key', { providerId, key }),
  clearProviderKey: (providerId: string): Promise<void> =>
    invokeCommand('api_agent_provider_clear_key', { providerId }),
  hasProviderKey: (providerId: string): Promise<boolean> =>
    invokeCommand('api_agent_provider_has_key', { providerId }),
  createSession: (req: ApiAgentSessionCreateRequest): Promise<ApiAgentSession> =>
    invokeCommand('api_agent_session_create', { req }),
  loadSession: (sessionId: string): Promise<ApiAgentSession | null> =>
    invokeCommand('api_agent_session_load', { sessionId }),
  deleteSession: (sessionId: string): Promise<void> =>
    invokeCommand('api_agent_session_delete', { sessionId }),
  send: (req: ApiAgentSendRequest): Promise<ApiAgentSendResult> =>
    invokeCommand('api_agent_send', { req }),
  cancel: (sessionId: string, generationId: string): Promise<void> =>
    invokeCommand('api_agent_cancel', { sessionId, generationId }),
  listSkills: (): Promise<ApiAgentSkillMeta[]> => invokeCommand('api_agent_skill_list', {}),
  listSkillSources: (): Promise<ApiAgentImportableSkill[]> =>
    invokeCommand('api_agent_skill_sources_list', {}),
  importSkill: (source: ApiAgentSkillSource, id: string): Promise<ApiAgentSkillMeta> =>
    invokeCommand('api_agent_skill_import', { req: { source, id } }),
  removeSkill: (id: string): Promise<void> => invokeCommand('api_agent_skill_remove', { id }),
  events: (sessionId: string) => ({
    onDeltaReady: (cb: (event: ApiAgentStreamEvent) => void): Promise<() => void> =>
      subscribeEventReady<ApiAgentStreamEvent>(`api-agent:delta:${sessionId}`, cb),
    onToolReady: (cb: (event: ApiAgentToolEvent) => void): Promise<() => void> =>
      subscribeEventReady<ApiAgentToolEvent>(`api-agent:tool:${sessionId}`, cb),
    onDoneReady: (cb: (event: ApiAgentDoneEvent) => void): Promise<() => void> =>
      subscribeEventReady<ApiAgentDoneEvent>(`api-agent:done:${sessionId}`, cb),
    onErrorReady: (cb: (event: ApiAgentErrorEvent) => void): Promise<() => void> =>
      subscribeEventReady<ApiAgentErrorEvent>(`api-agent:error:${sessionId}`, cb)
  })
};
