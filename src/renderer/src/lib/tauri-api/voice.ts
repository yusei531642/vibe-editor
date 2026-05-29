// tauri-api/voice.ts — Issue #825: 音声指揮モード (Voice Direction Mode, Beta)
//
// Rust 側 `commands/voice.rs` の 6 IPC を `window.api.voice.*` で公開する。
// API key は OS keyring 経由で保管されるため、本 wrapper では「保存 / 削除 / 存在確認」
// しか提供しない (= 値そのものは renderer に降りない)。
//
// `invokeCommand` は reject を `CommandError` に正規化するので、呼び出し側は
// `catch (err) { if (err instanceof CommandError) ... }` で構造化エラーを扱える。

import { invokeCommand } from './command-error';
import type {
  VoiceRealtimeSession,
  VoiceSendResult,
  VoiceTarget
} from '../../../../types/shared';

export const voice = {
  /**
   * OpenAI API key を OS keyring に保管する。
   * Windows: Credential Manager / macOS: Keychain / Linux: secret-service。
   * 値そのものは IPC で返さない (Renderer に降りない)。
   */
  setApiKey: (key: string): Promise<void> =>
    invokeCommand('voice_set_api_key', { key }),

  /** 保管済みの API key を keyring から削除する (冪等)。 */
  clearApiKey: (): Promise<void> => invokeCommand('voice_clear_api_key'),

  /** API key が keyring に保管されているか (値は取得しない)。 */
  hasApiKey: (): Promise<boolean> => invokeCommand('voice_has_api_key'),

  /**
   * OpenAI に POST /v1/realtime/client_secrets してエフェメラルキー (ek_xxx, ~60s) を
   * 発行する。Renderer はこのキーを WebRTC SDP exchange の Bearer に乗せる。
   * `bypassConfirmation` を true にすると AI の system prompt が「即実行モード」に切替。
   */
  createSession: (args: {
    model?: string;
    language?: string;
    voice?: string;
    bypassConfirmation?: boolean;
  } = {}): Promise<VoiceRealtimeSession> =>
    invokeCommand('voice_realtime_create_session', { args }),

  /**
   * 現在の active leader を取得する (該当なしは null)。Draft UI の "Target" 表示と
   * AI への announce に使う。`teamId` 未指定なら最初に見つかったチームを返す。
   */
  getActiveTarget: (teamId?: string): Promise<VoiceTarget | null> =>
    invokeCommand('voice_get_active_target', {
      args: { teamId: teamId ?? null }
    }),

  /**
   * `text` を active leader の PTY に inject する。`transcript` / `aiTranscript` は
   * 監査ログ用 (Rust 側で本文は出さず char count のみ記録)。
   *
   * 失敗は `Err` ではなく `{ ok: false, reasonCode, error }` で返るので、UI で分岐する。
   * (`team_send_retry_inject` と同じ contract)。
   */
  sendToLeader: (args: {
    teamId: string;
    agentId: string;
    text: string;
    transcript?: string;
    aiTranscript?: string;
  }): Promise<VoiceSendResult> =>
    invokeCommand('voice_send_to_leader', {
      args: {
        teamId: args.teamId,
        agentId: args.agentId,
        text: args.text,
        transcript: args.transcript ?? '',
        aiTranscript: args.aiTranscript ?? ''
      }
    })
};
