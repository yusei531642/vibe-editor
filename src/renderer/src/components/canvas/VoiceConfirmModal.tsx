// Issue #825: 危険キーワード hit 時に「Leader に送信しますか?」を UI で明示確認させる
// 最終 fail-safe modal。`confirmationMode === 'always'` で safetyLevel === 'confirm' のみ表示。

import { AlertTriangle } from 'lucide-react';
import { useT } from '../../lib/i18n';
import { useModalA11y } from '../../lib/hooks/use-modal-a11y';

interface Props {
  text: string;
  onApprove: () => void;
  onCancel: () => void;
}

export function VoiceConfirmModal({ text, onApprove, onCancel }: Props): JSX.Element {
  const t = useT();
  const modal = useModalA11y(onCancel);
  return (
    <div className="voice-confirm-backdrop" onClick={onCancel} role="presentation">
      <div
        ref={modal.dialogRef}
        className="voice-confirm-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="voice-confirm-title"
        tabIndex={-1}
        data-modal-escape-owner="true"
        onKeyDown={modal.onKeyDown}
      >
        <h3 id="voice-confirm-title" className="voice-confirm-modal__title">
          <AlertTriangle
            size={16}
            strokeWidth={1.75}
            style={{ color: 'var(--warning, #d4a27f)' }}
          />
          {t('voice.confirm.title')}
        </h3>
        <p className="voice-confirm-modal__body">
          {t('voice.confirm.body', { text })}
        </p>
        <div className="voice-confirm-modal__footer">
          <button type="button" className="voice-btn" onClick={onCancel}>
            {t('voice.confirm.cancel')}
          </button>
          <button
            type="button"
            className="voice-btn voice-btn--primary voice-confirm-modal__send"
            onClick={onApprove}
          >
            {t('voice.confirm.send')}
          </button>
        </div>
      </div>
    </div>
  );
}
