// Issue #825: Voice 指揮モードのトグルボタン (Canvas 右下、glass-surface)。
//
// 表示条件は **caller (CanvasLayout) 側で** Canvas モード + voice.enabled で gate される。
// 本コンポーネント内部では `hasApiKey` を fetch して未設定なら disabled state にする。
//
// 状態遷移:
//   idle → クリックで `useVoiceRealtime.toggle()` を呼んで会話開始
//   listening 中はボタン中央が録音色に変わり、周囲に VoiceVisualizer が出る
//   listening 中に再クリックで disconnect → idle に戻る
//   危険キーワード hit (pendingFunctionCall.safetyLevel === 'confirm') → VoiceConfirmModal
//   それ以外の pendingFunctionCall (safe) → 3 秒 hold の inline trail (キャンセル可能)
//   bypass モードでは pendingFunctionCall が立たない (即実行) のでここでの分岐は走らない

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Mic, MicOff } from 'lucide-react';
import { useT } from '../../lib/i18n';
import { useSettings } from '../../lib/settings-context';
import { useVoiceStore } from '../../stores/voice';
import { useVoiceRealtime } from '../../lib/hooks/use-voice-realtime';
import { BUILTIN_PRESETS } from '../../lib/workspace-presets';
import type { VoiceAvailablePreset } from '../../lib/voice-realtime';
import { VoiceVisualizer } from './VoiceVisualizer';
import { VoiceConfirmModal } from './VoiceConfirmModal';

const INLINE_TRAIL_HOLD_MS = 3000;

export interface VoiceControlButtonProps {
  /**
   * spawn_team_preset を実体化する関数。CanvasLayout 側で applyPreset を呼ぶ薄ラッパを渡す。
   * 未指定なら spawn_team_preset tool は AI に登録されない。
   */
  onSpawnTeamPreset?: (presetId: string) => Promise<{ ok: boolean; message?: string }>;
}

export function VoiceControlButton({
  onSpawnTeamPreset
}: VoiceControlButtonProps = {}): JSX.Element | null {
  const t = useT();
  const { settings } = useSettings();
  const voice = settings.voice ?? {};
  const enabled = voice.enabled === true;

  // API key 存在チェック (mount で 1 度、Settings 反映を意識して再 fetch する経路は voice 設定変更時に re-mount される設計)
  const [hasApiKey, setHasApiKey] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    window.api.voice
      .hasApiKey()
      .then((v) => {
        if (!cancelled) setHasApiKey(v);
      })
      .catch(() => {
        if (!cancelled) setHasApiKey(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // settings 変更で voice.enabled が flip したときに hasApiKey を再 check (Settings → Canvas 即時反映)
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    window.api.voice
      .hasApiKey()
      .then((v) => {
        if (!cancelled) setHasApiKey(v);
      })
      .catch(() => {
        if (!cancelled) setHasApiKey(false);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  const status = useVoiceStore((s) => s.status);
  const errorMessage = useVoiceStore((s) => s.errorMessage);
  const pendingFunctionCall = useVoiceStore((s) => s.pendingFunctionCall);

  // BUILTIN_PRESETS から AI に見せる summary を組み立てる。i18n には依存させず id ベース。
  // (AI には id を渡すだけで OK で、ユーザー向けラベルは spawn 時に CanvasLayout 側で解決される)
  const availablePresets = useMemo<VoiceAvailablePreset[]>(
    () =>
      BUILTIN_PRESETS.map((p) => ({
        id: p.id,
        label: p.id,
        description: p.description
      })),
    []
  );

  const { toggle, approvePending, cancelPending, disconnect } = useVoiceRealtime(
    {
      enabled: enabled && hasApiKey === true,
      hasApiKey: hasApiKey === true,
      model: voice.model,
      language: voice.language,
      voice: voice.voiceName,
      inputDeviceId: voice.inputDeviceId,
      outputDeviceId: voice.outputDeviceId,
      confirmationMode: voice.confirmationMode,
      availablePresets
    },
    {
      createSession: (args) => window.api.voice.createSession(args),
      sendToLeader: (args) => window.api.voice.sendToLeader(args),
      getActiveTarget: (teamId) => window.api.voice.getActiveTarget(teamId),
      spawnTeamPreset: onSpawnTeamPreset
    }
  );

  // ---- pending function call (always モード) の inline trail / modal ----
  const [trailRemainingMs, setTrailRemainingMs] = useState<number | null>(null);
  const trailTimerRef = useRef<ReturnType<typeof window.setInterval> | null>(null);
  const trailDeadlineRef = useRef<number | null>(null);

  // safe 系: 3 秒カウントダウンで自動 approve。confirm 系: modal 表示で待機 (trail なし)。
  useEffect(() => {
    if (trailTimerRef.current !== null) {
      window.clearInterval(trailTimerRef.current);
      trailTimerRef.current = null;
    }
    trailDeadlineRef.current = null;
    if (!pendingFunctionCall) {
      setTrailRemainingMs(null);
      return;
    }
    if (pendingFunctionCall.safetyLevel === 'confirm') {
      // modal で確認するので timer は使わない
      setTrailRemainingMs(null);
      return;
    }
    // safe 系: 3 秒 hold
    const deadline = Date.now() + INLINE_TRAIL_HOLD_MS;
    trailDeadlineRef.current = deadline;
    setTrailRemainingMs(INLINE_TRAIL_HOLD_MS);
    trailTimerRef.current = window.setInterval(() => {
      const remaining = (trailDeadlineRef.current ?? 0) - Date.now();
      if (remaining <= 0) {
        if (trailTimerRef.current !== null) {
          window.clearInterval(trailTimerRef.current);
          trailTimerRef.current = null;
        }
        setTrailRemainingMs(0);
        void approvePending();
      } else {
        setTrailRemainingMs(remaining);
      }
    }, 100);
    return () => {
      if (trailTimerRef.current !== null) {
        window.clearInterval(trailTimerRef.current);
        trailTimerRef.current = null;
      }
    };
  }, [pendingFunctionCall, approvePending]);

  // unmount で必ず disconnect
  useEffect(() => {
    return () => disconnect();
  }, [disconnect]);

  const onButtonClick = useCallback(() => {
    if (hasApiKey !== true) return;
    void toggle();
  }, [toggle, hasApiKey]);

  if (!enabled) return null;

  const apiKeyMissing = hasApiKey === false;
  const buttonLabel = apiKeyMissing
    ? t('voice.button.disabled.noKey')
    : status === 'connecting'
      ? t('voice.button.connecting')
      : status === 'listening'
        ? t('voice.button.listening')
        : t('voice.button.idle');

  // pendingFunctionCall の modal 表示判定 (send_to_leader でのみ confirm が立つ)
  const showConfirmModal =
    pendingFunctionCall !== null &&
    pendingFunctionCall.name === 'send_to_leader' &&
    pendingFunctionCall.safetyLevel === 'confirm';

  return (
    <>
      <div className="voice-control-root" data-status={status}>
        <VoiceVisualizer status={status} />
        <button
          type="button"
          className={`voice-control-button glass-surface${
            status === 'listening' ? ' is-listening' : ''
          }`}
          data-status={status}
          onClick={onButtonClick}
          disabled={apiKeyMissing || status === 'connecting'}
          aria-label={buttonLabel}
          title={buttonLabel}
        >
          <span className="voice-control-button__beta">BETA</span>
          {status === 'listening' ? (
            <MicOff size={20} strokeWidth={2} />
          ) : (
            <Mic size={20} strokeWidth={2} />
          )}
        </button>
        {trailRemainingMs !== null && pendingFunctionCall?.safetyLevel === 'safe' && (
          <div className="voice-control-trail">
            <span>
              {pendingFunctionCall.name === 'spawn_team_preset'
                ? t('voice.trail.spawningTeam', {
                    preset: pendingFunctionCall.arguments.presetId
                  })
                : t('voice.trail.sending')}
            </span>
            <div className="voice-control-trail__bar">
              <div
                className="voice-control-trail__fill"
                style={{
                  width: `${Math.max(0, Math.min(100, (trailRemainingMs / INLINE_TRAIL_HOLD_MS) * 100))}%`
                }}
              />
            </div>
            <button
              type="button"
              className="toolbar__btn voice-control-trail__cancel"
              onClick={cancelPending}
            >
              {t('voice.trail.cancel')}
            </button>
          </div>
        )}
        {errorMessage && status === 'error' && (
          <div className="voice-control-error" role="alert">
            {errorMessage}
          </div>
        )}
      </div>
      {showConfirmModal &&
        pendingFunctionCall &&
        pendingFunctionCall.name === 'send_to_leader' && (
          <VoiceConfirmModal
            text={pendingFunctionCall.arguments.text}
            onApprove={() => {
              void approvePending();
            }}
            onCancel={cancelPending}
          />
        )}
    </>
  );
}
