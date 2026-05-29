// Issue #825: 音声指揮モードのセッション中状態を保持する zustand store。
//
// セッションをまたいで永続化する必要はないので persist は使わない (API key 等の永続値は
// settings.json / OS keyring 側で管理)。

import { create } from 'zustand';
import type {
  VoiceCommandStatus,
  VoicePendingFunctionCall,
  VoiceTarget
} from '../../../types/shared';

interface VoiceState {
  /** Voice control button の状態。 */
  status: VoiceCommandStatus;
  /** ユーザー発話の live transcript (delta が来るたびに更新)。 */
  transcript: string;
  /** AI 応答 text (delta が来るたびに更新)。音声は track で別途流れる。 */
  aiTranscript: string;
  /** 直近の active leader 取得結果。 null なら未取得 / 該当なし。 */
  target: VoiceTarget | null;
  /** AI が tool call を発火した直後の pending state (confirmation hold / modal 表示用)。 */
  pendingFunctionCall: VoicePendingFunctionCall | null;
  /** error state のときの人間可読メッセージ。 */
  errorMessage: string | null;

  setStatus: (s: VoiceCommandStatus) => void;
  setTranscript: (t: string) => void;
  appendTranscript: (delta: string) => void;
  setAiTranscript: (t: string) => void;
  appendAiTranscript: (delta: string) => void;
  setTarget: (t: VoiceTarget | null) => void;
  setPendingFunctionCall: (c: VoicePendingFunctionCall | null) => void;
  setError: (msg: string | null) => void;
  /** session 終了時に live state を一括 reset (status は idle に戻す)。 */
  reset: () => void;
}

export const useVoiceStore = create<VoiceState>((set) => ({
  status: 'idle',
  transcript: '',
  aiTranscript: '',
  target: null,
  pendingFunctionCall: null,
  errorMessage: null,

  setStatus: (s) => set({ status: s }),
  setTranscript: (t) => set({ transcript: t }),
  appendTranscript: (delta) =>
    set((prev) => ({ transcript: prev.transcript + delta })),
  setAiTranscript: (t) => set({ aiTranscript: t }),
  appendAiTranscript: (delta) =>
    set((prev) => ({ aiTranscript: prev.aiTranscript + delta })),
  setTarget: (t) => set({ target: t }),
  setPendingFunctionCall: (c) => set({ pendingFunctionCall: c }),
  setError: (msg) => set({ errorMessage: msg }),

  reset: () =>
    set({
      status: 'idle',
      transcript: '',
      aiTranscript: '',
      pendingFunctionCall: null,
      errorMessage: null
    })
}));
