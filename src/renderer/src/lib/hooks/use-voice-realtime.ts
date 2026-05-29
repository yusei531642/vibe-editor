// Issue #825: OpenAIRealtimeClient と zustand voiceStore を React 統合する hook。
//
// VoiceControlButton から `useVoiceRealtime()` を呼び、`toggle()` で接続 ON/OFF を切替。
// connect 中の各 callback (transcript delta / function call / error) を store に流す。
//
// function call が来たら confirmationMode を見て分岐:
//   - 'always' モード で危険キーワード hit: pendingFunctionCall を立てて UI で modal 確認待ち
//   - 'always' モード で safe: 3 秒 hold (= status を 'pending' に固定し inline trail 表示)
//   - 'bypass' モード: 即実行
//
// ただし MVP の hook 側は 'always' 時の挙動を「常に pendingFunctionCall に積む」に統一し、
// UI 側 (VoiceControlButton) で safetyLevel を見て modal を出すか inline trail を出すかを
// 振り分ける。これにより hook はタイマー管理を持たなくて済み、React に閉じた UI 状態だけで
// timing を制御できる。

import { useCallback, useEffect, useRef } from 'react';
import { useVoiceStore } from '../../stores/voice';
import {
  OpenAIRealtimeClient,
  type ToolResult,
  type VoiceAvailablePreset
} from '../voice-realtime';
import { assessVoiceSafety } from '../voice-safety';
import type {
  VoiceConfirmationMode,
  VoicePendingFunctionCall
} from '../../../../types/shared';

export interface UseVoiceRealtimeOptions {
  enabled: boolean;
  hasApiKey: boolean;
  model?: string;
  language?: string;
  voice?: string;
  inputDeviceId?: string;
  outputDeviceId?: string;
  confirmationMode?: VoiceConfirmationMode;
  /** AI が `spawn_team_preset` で選べる preset 一覧。空配列なら tool 自体が登録されない。 */
  availablePresets?: VoiceAvailablePreset[];
}

export interface UseVoiceRealtimeApi {
  /** 接続 ON/OFF を切り替える。 */
  toggle: () => Promise<void>;
  /** 強制切断 (unmount cleanup 用)。 */
  disconnect: () => void;
  /** pending function call をユーザー確定で実行する (`confirmationMode='always'` で UI から呼ぶ)。 */
  approvePending: () => Promise<void>;
  /** pending function call をユーザーキャンセル (AI に "canceled" を返す)。 */
  cancelPending: () => void;
}

export function useVoiceRealtime(
  opts: UseVoiceRealtimeOptions,
  io: {
    /** Rust 側 IPC を呼ぶ薄い wrapper (`window.api.voice` をそのまま渡してよい)。 */
    createSession: OpenAIRealtimeClient extends never
      ? never
      : ConstructorParameters<typeof OpenAIRealtimeClient>[0] extends never
        ? never
        : Parameters<OpenAIRealtimeClient['connect']>[0]['createSession'];
    /** active leader への inject。`window.api.voice.sendToLeader` を渡す。 */
    sendToLeader: (args: {
      teamId: string;
      agentId: string;
      text: string;
      transcript?: string;
      aiTranscript?: string;
    }) => Promise<{
      ok: boolean;
      deliveredAt?: string;
      reasonCode?: string;
      error?: string;
    }>;
    /** active target を取得 (toggle ON 時に latest を取得しに行く)。 */
    getActiveTarget: (teamId?: string) => Promise<{
      teamId: string;
      agentId: string;
      displayName: string;
      role: string;
    } | null>;
    /**
     * spawn_team_preset の実体。CanvasLayout 側で applyPreset を呼ぶ薄ラッパを渡す想定。
     * 戻り値: 起動した team 数 (0 なら preset が見つからなかった)。
     */
    spawnTeamPreset?: (presetId: string) => Promise<{ ok: boolean; message?: string }>;
  }
): UseVoiceRealtimeApi {
  const clientRef = useRef<OpenAIRealtimeClient | null>(null);
  /**
   * Pending function call は name によって引数形が違う (discriminated union)。
   * approve / cancel するときに ref から取り出すので、callId だけでなく call 全体を保持する。
   */
  const pendingRef = useRef<
    | { callId: string; name: 'send_to_leader'; args: { text: string } }
    | { callId: string; name: 'spawn_team_preset'; args: { presetId: string } }
    | null
  >(null);
  const ioRef = useRef(io);
  ioRef.current = io;

  const {
    setStatus,
    appendTranscript,
    setTranscript,
    appendAiTranscript,
    setTarget,
    setPendingFunctionCall,
    setError,
    reset
  } = useVoiceStore.getState();

  const disconnect = useCallback(() => {
    if (clientRef.current) {
      clientRef.current.disconnect();
      clientRef.current = null;
    }
    pendingRef.current = null;
    reset();
  }, [reset]);

  const executeSendToLeader = useCallback(
    async (call: { callId: string; text: string }) => {
      const store = useVoiceStore.getState();
      const target = store.target;
      if (!target) {
        clientRef.current?.notifyToolResult({
          callId: call.callId,
          ok: false,
          message: 'No active leader is registered.'
        });
        return;
      }
      try {
        const result = await ioRef.current.sendToLeader({
          teamId: target.teamId,
          agentId: target.agentId,
          text: call.text,
          transcript: store.transcript,
          aiTranscript: store.aiTranscript
        });
        clientRef.current?.notifyToolResult({
          callId: call.callId,
          ok: result.ok,
          message: result.ok
            ? `Delivered at ${result.deliveredAt ?? 'now'}.`
            : `Failed (${result.reasonCode ?? 'unknown'}): ${result.error ?? ''}`
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        clientRef.current?.notifyToolResult({
          callId: call.callId,
          ok: false,
          message: `IPC error: ${msg}`
        });
      } finally {
        pendingRef.current = null;
        setPendingFunctionCall(null);
      }
    },
    [setPendingFunctionCall]
  );

  const executeSpawnTeamPreset = useCallback(
    async (call: { callId: string; presetId: string }) => {
      const spawner = ioRef.current.spawnTeamPreset;
      if (!spawner) {
        clientRef.current?.notifyToolResult({
          callId: call.callId,
          ok: false,
          message: 'spawn_team_preset is not wired up on this Canvas.'
        });
        pendingRef.current = null;
        setPendingFunctionCall(null);
        return;
      }
      try {
        const result = await spawner(call.presetId);
        // 成功後、新規 leader が active になるはずなので target を refetch する
        if (result.ok) {
          try {
            const newTarget = await ioRef.current.getActiveTarget(undefined);
            useVoiceStore.getState().setTarget(newTarget);
          } catch {
            // target 取得失敗は致命的ではない (次の send_to_leader 時に再取得される)
          }
        }
        clientRef.current?.notifyToolResult({
          callId: call.callId,
          ok: result.ok,
          message:
            result.message ??
            (result.ok
              ? `Team preset '${call.presetId}' spawned on the Canvas.`
              : `Failed to spawn team preset '${call.presetId}'.`)
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        clientRef.current?.notifyToolResult({
          callId: call.callId,
          ok: false,
          message: `Spawn error: ${msg}`
        });
      } finally {
        pendingRef.current = null;
        setPendingFunctionCall(null);
      }
    },
    [setPendingFunctionCall]
  );

  const approvePending = useCallback(async () => {
    const current = pendingRef.current;
    if (!current) return;
    if (current.name === 'send_to_leader') {
      await executeSendToLeader({ callId: current.callId, text: current.args.text });
    } else if (current.name === 'spawn_team_preset') {
      await executeSpawnTeamPreset({
        callId: current.callId,
        presetId: current.args.presetId
      });
    }
  }, [executeSendToLeader, executeSpawnTeamPreset]);

  const cancelPending = useCallback(() => {
    const current = pendingRef.current;
    if (!current) return;
    const result: ToolResult = {
      callId: current.callId,
      ok: false,
      message: 'Canceled by user.'
    };
    clientRef.current?.notifyToolResult(result);
    pendingRef.current = null;
    setPendingFunctionCall(null);
  }, [setPendingFunctionCall]);

  const toggle = useCallback(async () => {
    if (clientRef.current) {
      disconnect();
      return;
    }
    if (!opts.enabled || !opts.hasApiKey) {
      setError('Voice mode is disabled or API key is missing.');
      setStatus('error');
      return;
    }

    setError(null);
    setStatus('connecting');
    setTranscript('');
    useVoiceStore.setState({ aiTranscript: '' });
    setPendingFunctionCall(null);

    try {
      // active target は接続前に取得 (該当なしでも接続自体は許す — AI に "no active leader" を返す)
      const target = await ioRef.current.getActiveTarget(undefined);
      setTarget(target);

      const client = new OpenAIRealtimeClient({
        model: opts.model,
        language: opts.language,
        voice: opts.voice,
        inputDeviceId: opts.inputDeviceId,
        outputDeviceId: opts.outputDeviceId,
        bypassConfirmation: opts.confirmationMode === 'bypass',
        availablePresets: opts.availablePresets,
        onUserTranscriptDelta: (delta) => appendTranscript(delta),
        onAiTranscriptDelta: (delta) => appendAiTranscript(delta),
        onUserTranscriptCompleted: (final) => {
          // delta で既に積んでいるが、最終 transcript は完成版で上書きしておく
          // (delta が部分的に欠落する race を吸収)
          setTranscript(final);
        },
        onFunctionCall: (call) => {
          if (call.name === 'send_to_leader') {
            const text = typeof call.args.text === 'string' ? call.args.text : '';
            if (!text) return;
            // confirmationMode='bypass' は即実行
            if (opts.confirmationMode === 'bypass') {
              void executeSendToLeader({ callId: call.callId, text });
              return;
            }
            // 'always' モード: safetyLevel を判定して pendingFunctionCall に積む。
            const assessment = assessVoiceSafety(text);
            const pending: VoicePendingFunctionCall = {
              name: 'send_to_leader',
              arguments: { text },
              safetyLevel: assessment.level === 'blocked' ? 'confirm' : assessment.level
            };
            pendingRef.current = { callId: call.callId, name: 'send_to_leader', args: { text } };
            setPendingFunctionCall(pending);
            return;
          }
          if (call.name === 'spawn_team_preset') {
            const presetId =
              typeof call.args.presetId === 'string' ? call.args.presetId : '';
            if (!presetId) return;
            // spawn は副作用が Canvas store だけで PTY inject ではないので always 'safe'。
            // bypass モードは即実行、それ以外も 3 秒 trail を経由する (誤起動を防ぐため)。
            if (opts.confirmationMode === 'bypass') {
              void executeSpawnTeamPreset({ callId: call.callId, presetId });
              return;
            }
            const pending: VoicePendingFunctionCall = {
              name: 'spawn_team_preset',
              arguments: { presetId },
              safetyLevel: 'safe'
            };
            pendingRef.current = {
              callId: call.callId,
              name: 'spawn_team_preset',
              args: { presetId }
            };
            setPendingFunctionCall(pending);
            return;
          }
          // 未知の tool は無視 (AI の hallucination 対策)
          // eslint-disable-next-line no-console
          console.warn(`[voice] unknown tool call: ${call.name}`);
        },
        onError: (msg) => {
          setError(msg);
          setStatus('error');
        }
      });

      clientRef.current = client;
      await client.connect({ createSession: ioRef.current.createSession });

      if (!clientRef.current) {
        // 接続中に toggle OFF された場合は disconnect 済み
        return;
      }
      setStatus('listening');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      setStatus('error');
      // 失敗したら部分的に開いたリソースを片付ける
      if (clientRef.current) {
        clientRef.current.disconnect();
        clientRef.current = null;
      }
    }
  }, [
    opts.enabled,
    opts.hasApiKey,
    opts.model,
    opts.language,
    opts.voice,
    opts.inputDeviceId,
    opts.outputDeviceId,
    opts.confirmationMode,
    opts.availablePresets,
    disconnect,
    appendTranscript,
    appendAiTranscript,
    setTranscript,
    setTarget,
    setError,
    setStatus,
    setPendingFunctionCall,
    executeSendToLeader,
    executeSpawnTeamPreset
  ]);

  useEffect(() => {
    return () => {
      // unmount 時の安全 cleanup
      if (clientRef.current) {
        clientRef.current.disconnect();
        clientRef.current = null;
      }
    };
  }, []);

  return { toggle, disconnect, approvePending, cancelPending };
}
