// Issue #825: OpenAI Realtime API (WebRTC) クライアントを React 非依存で閉じ込めた class。
//
// 役割:
// 1. Rust から ephemeral key を取得 (`window.api.voice.createSession`)
// 2. `getUserMedia({audio})` で local stream を取得 (input device 指定可能)
// 3. RTCPeerConnection を作成し、local track を addTrack、remote track を audio element に attach
// 4. DataChannel "oai-events" で双方向 JSON event を送受信
// 5. SDP exchange: `POST https://api.openai.com/v1/realtime/calls`
// 6. DataChannel から `response.audio_transcript.delta` / `conversation.item.input_audio_transcription.completed` /
//    `response.function_call_arguments.done` 等を取り出して callback で caller に渡す
//
// 1 セッション = 1 instance。トグルで終了 (`disconnect`)、再起動で新規 instantiate。
//
// 注意: OpenAI Realtime API は GA 直後で wire format が動きうる。本実装は 2026 年 5 月時点で
// 公開されている `/v1/realtime/calls` (WebRTC) + `client_secrets` (REST) を前提に書いてある。
// イベント名や payload 形が変わったら `handleDataChannelMessage` を更新するだけで済む形に
// 局所化してある。

import { applyOutputDevice } from './voice-audio-devices';

/** AI に提示する利用可能な team preset 1 件分の summary。 */
export interface VoiceAvailablePreset {
  /** workspace-presets の id (例: 'leader-claude')。AI はこの値を spawn_team_preset 引数に渡す。 */
  id: string;
  /** UI 表示名 (英訳 / ja 訳のどちらでも可、AI が認識できる人間語)。 */
  label: string;
  /** 簡単な説明 (AI が選定に使う)。 */
  description: string;
}

/** Realtime function call の正規化形 (renderer 側で name 分岐するため un-typed args を Record で持つ)。 */
export interface VoiceFunctionCall {
  callId: string;
  name: 'send_to_leader' | 'spawn_team_preset' | string;
  /** OpenAI から来た JSON arguments を parse 済み。 */
  args: Record<string, unknown>;
}

export interface OpenAIRealtimeClientOptions {
  model?: string;
  language?: string;
  /** AI の voice preset ('alloy' 等)。 */
  voice?: string;
  /** マイクの `MediaDeviceInfo.deviceId` (空 / undefined はシステム既定)。 */
  inputDeviceId?: string;
  /** スピーカーの `MediaDeviceInfo.deviceId` (setSinkId 非対応環境では無視)。 */
  outputDeviceId?: string;
  /** confirmationMode === 'bypass' のとき true。 */
  bypassConfirmation?: boolean;
  /** AI が `spawn_team_preset` で選べる preset 一覧。空配列なら tool は登録しない。 */
  availablePresets?: VoiceAvailablePreset[];

  // ---- callbacks (caller で zustand store 等へ流す) ----
  onUserTranscriptDelta?: (delta: string) => void;
  onUserTranscriptCompleted?: (final: string) => void;
  onAiTranscriptDelta?: (delta: string) => void;
  /**
   * AI が tool を call した時に呼ばれる。caller は name で分岐し、結果を `notifyToolResult` で AI に戻す。
   */
  onFunctionCall?: (call: VoiceFunctionCall) => void;
  onError?: (message: string) => void;
}

/** Realtime API への function call 結果を返すための SSOT。 */
export interface ToolResult {
  callId: string;
  ok: boolean;
  message: string;
}

interface CreateSessionResponse {
  ephemeralKey: string;
  /** epoch ms。Rust 側で OpenAI の epoch seconds を ×1000 して返す (`VoiceRealtimeSession`)。 */
  expiresAt: number;
  model: string;
  sessionId: string;
  instructions: string;
}

/** OpenAI Realtime API の SDP exchange endpoint (model パラメータ付き)。 */
const OPENAI_REALTIME_CALLS_URL = 'https://api.openai.com/v1/realtime/calls';

export class OpenAIRealtimeClient {
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private localStream: MediaStream | null = null;
  private audioElement: HTMLAudioElement | null = null;
  private disposed = false;

  constructor(private readonly opts: OpenAIRealtimeClientOptions) {}

  /**
   * セッション接続。`connect()` 中に `disconnect()` が呼ばれた場合は途中で abort する。
   */
  async connect(api: {
    createSession: (args: {
      model?: string;
      language?: string;
      voice?: string;
      bypassConfirmation?: boolean;
    }) => Promise<CreateSessionResponse>;
  }): Promise<void> {
    if (this.disposed) {
      throw new Error('client is disposed');
    }

    // 1. ephemeral key を Rust 経由で発行
    const session = await api.createSession({
      model: this.opts.model,
      language: this.opts.language,
      voice: this.opts.voice,
      bypassConfirmation: this.opts.bypassConfirmation
    });

    if (this.disposed) return;

    // 2. local mic stream
    const constraints: MediaStreamConstraints = {
      audio: this.opts.inputDeviceId
        ? { deviceId: { exact: this.opts.inputDeviceId } }
        : true
    };
    this.localStream = await navigator.mediaDevices.getUserMedia(constraints);

    if (this.disposed) {
      this.cleanup();
      return;
    }

    // 3. peer connection
    const pc = new RTCPeerConnection();
    this.pc = pc;

    // remote audio (AI 応答)
    const audioElement = new Audio();
    audioElement.autoplay = true;
    this.audioElement = audioElement;
    pc.ontrack = (event) => {
      if (event.streams[0]) {
        audioElement.srcObject = event.streams[0];
      }
    };
    // 出力デバイスを設定 (setSinkId 非対応環境では default に fall back)
    void applyOutputDevice(audioElement, this.opts.outputDeviceId).catch(() => {
      // 失敗しても再生自体は default device に流れるので致命的ではない
    });

    // local track を送信
    for (const track of this.localStream.getTracks()) {
      pc.addTrack(track, this.localStream);
    }

    // 4. data channel (双方向 JSON events)
    const dc = pc.createDataChannel('oai-events');
    this.dc = dc;
    dc.addEventListener('open', () => {
      this.sendSessionConfig(session);
    });
    dc.addEventListener('message', (event) => {
      try {
        const parsed = JSON.parse(event.data) as unknown;
        this.handleDataChannelMessage(parsed);
      } catch (err) {
        this.opts.onError?.(
          `Failed to parse Realtime event: ${(err as Error).message}`
        );
      }
    });
    dc.addEventListener('error', () => {
      this.opts.onError?.('Realtime data channel error');
    });

    // 5. SDP exchange
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    const sdpResponse = await fetch(
      `${OPENAI_REALTIME_CALLS_URL}?model=${encodeURIComponent(session.model)}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.ephemeralKey}`,
          'Content-Type': 'application/sdp'
        },
        body: offer.sdp ?? ''
      }
    );
    if (!sdpResponse.ok) {
      const body = await sdpResponse.text().catch(() => '');
      throw new Error(
        `OpenAI Realtime SDP exchange failed: ${sdpResponse.status} ${body.slice(0, 200)}`
      );
    }
    const answerSdp = await sdpResponse.text();
    if (this.disposed) {
      this.cleanup();
      return;
    }
    await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
  }

  /**
   * function call の結果を AI に伝える。AI 側は `Sent.` 等で音声 ack を返してくる想定。
   */
  notifyToolResult(result: ToolResult): void {
    if (!this.dc || this.dc.readyState !== 'open') return;
    // OpenAI Realtime API: conversation.item.create で function_call_output を投入し、
    // response.create で AI に応答を促すのが標準シーケンス。
    const itemEvent = {
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: result.callId,
        output: JSON.stringify({ ok: result.ok, message: result.message })
      }
    };
    this.dc.send(JSON.stringify(itemEvent));
    this.dc.send(JSON.stringify({ type: 'response.create' }));
  }

  /**
   * クライアントを完全終了。RTC / mic / audio element を片付け、再利用不可状態にする。
   */
  disconnect(): void {
    this.disposed = true;
    this.cleanup();
  }

  /** internal: 各種リソース解放。disconnect / connect 失敗時に呼ぶ。 */
  private cleanup(): void {
    try {
      this.dc?.close();
    } catch {
      // ignore
    }
    this.dc = null;
    try {
      this.pc?.close();
    } catch {
      // ignore
    }
    this.pc = null;
    if (this.localStream) {
      for (const t of this.localStream.getTracks()) {
        try {
          t.stop();
        } catch {
          // ignore
        }
      }
      this.localStream = null;
    }
    if (this.audioElement) {
      try {
        this.audioElement.srcObject = null;
      } catch {
        // ignore
      }
      this.audioElement = null;
    }
  }

  /**
   * 接続直後に session.update を送って instructions / voice / tools を確定させる。
   * Rust 側 `create_session` の REST 呼び出しで既に initial instructions / tools を送っているが、
   * preset 一覧などの動的情報は renderer 側 (= 本関数) で session.update に乗せて上書きする。
   */
  private sendSessionConfig(session: CreateSessionResponse): void {
    if (!this.dc || this.dc.readyState !== 'open') return;
    const event = {
      type: 'session.update',
      session: {
        instructions: this.buildInstructions(session.instructions),
        modalities: ['audio', 'text'],
        voice: this.opts.voice ?? 'alloy',
        input_audio_transcription: {
          model: 'gpt-4o-mini-transcribe',
          language: this.opts.language ?? 'ja'
        },
        tools: this.buildTools(),
        tool_choice: 'auto'
      }
    };
    this.dc.send(JSON.stringify(event));
  }

  /** Rust が組み立てた base instructions に preset 一覧を append する。 */
  private buildInstructions(base: string): string {
    const presets = this.opts.availablePresets ?? [];
    if (presets.length === 0) return base;
    const lines = presets.map(
      (p) => `- ${p.id}: ${p.label}${p.description ? ` — ${p.description}` : ''}`
    );
    return `${base}\n\nAVAILABLE TEAM PRESETS (use spawn_team_preset to create a new team on the Canvas):\n${lines.join(
      '\n'
    )}\n\nUse spawn_team_preset when the user asks to "create a team" / "start a team" / "チームを作って". For other team operations (recruit / dismiss / assign task), use send_to_leader and ask the existing active Leader to perform them via its MCP tools.`;
  }

  /** Realtime session に登録する function tools。preset が無いときは send_to_leader だけ。 */
  private buildTools(): unknown[] {
    const tools: unknown[] = [
      {
        type: 'function',
        name: 'send_to_leader',
        description:
          'Send a text message to the active Leader agent. Only call this AFTER explicit user confirmation (unless bypass_confirmation mode is active).',
        parameters: {
          type: 'object',
          properties: {
            text: {
              type: 'string',
              description:
                "The message text to send to the Leader, in the user's intended language."
            }
          },
          required: ['text']
        }
      }
    ];
    const presets = this.opts.availablePresets ?? [];
    if (presets.length > 0) {
      tools.push({
        type: 'function',
        name: 'spawn_team_preset',
        description:
          'Create a new team on the Canvas by spawning a built-in preset. Call this when the user asks to start a fresh team. After spawning, the user can recruit additional members via send_to_leader.',
        parameters: {
          type: 'object',
          properties: {
            presetId: {
              type: 'string',
              description: 'One of the available preset ids (see AVAILABLE TEAM PRESETS).',
              enum: presets.map((p) => p.id)
            }
          },
          required: ['presetId']
        }
      });
    }
    return tools;
  }

  /**
   * DataChannel から流れてくる JSON event を type で分岐して callback に流す。
   *
   * OpenAI Realtime API のイベント名は安定途上のため、本関数を 1 箇所に閉じることで
   * 仕様変更時の修正範囲を局所化する。
   */
  private handleDataChannelMessage(raw: unknown): void {
    if (!raw || typeof raw !== 'object') return;
    const ev = raw as Record<string, unknown>;
    const type = typeof ev.type === 'string' ? (ev.type as string) : '';

    // ユーザー発話の transcript (delta / completed)
    if (
      type === 'conversation.item.input_audio_transcription.delta' &&
      typeof ev.delta === 'string'
    ) {
      this.opts.onUserTranscriptDelta?.(ev.delta);
      return;
    }
    if (
      type === 'conversation.item.input_audio_transcription.completed' &&
      typeof ev.transcript === 'string'
    ) {
      this.opts.onUserTranscriptCompleted?.(ev.transcript);
      return;
    }

    // AI 応答 transcript (音声と並行して text も流れてくる)
    if (type === 'response.audio_transcript.delta' && typeof ev.delta === 'string') {
      this.opts.onAiTranscriptDelta?.(ev.delta);
      return;
    }

    // function call: 引数が完成したタイミング
    if (type === 'response.function_call_arguments.done') {
      const callId = typeof ev.call_id === 'string' ? ev.call_id : '';
      const name = typeof ev.name === 'string' ? ev.name : '';
      const argumentsRaw = typeof ev.arguments === 'string' ? ev.arguments : '';
      let parsedArgs: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(argumentsRaw);
        if (parsed && typeof parsed === 'object') {
          parsedArgs = parsed as Record<string, unknown>;
        }
      } catch {
        this.opts.onError?.(`Failed to parse tool call arguments: ${argumentsRaw}`);
        return;
      }
      if (callId && name) {
        this.opts.onFunctionCall?.({ callId, name, args: parsedArgs });
      }
      return;
    }

    // error
    if (type === 'error') {
      const msg =
        (ev.error as { message?: string } | undefined)?.message ??
        'Realtime error event';
      this.opts.onError?.(msg);
    }
  }
}
