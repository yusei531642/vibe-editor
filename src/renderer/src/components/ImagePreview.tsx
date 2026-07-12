/**
 * ImagePreview — Canvas / IDE で画像ファイルをプレビューするコンポーネント。
 *
 * Issue #325: ファイルツリーから png/jpg/gif/webp 等を開いたとき、Monaco の
 * binary プレースホルダではなく実際の画像を表示する。global `asset://` scopeにはproject rootを
 * 追加せず、backendのfiles認可を通して取得したdata URLだけを <img> に渡す。
 *
 * dev:vite 直接アクセス (Tauri ランタイム不在) ではbackend読込が機能しないため、
 * その場合は静的なフォールバックメッセージを出す。
 */
import { useEffect, useState } from 'react';
import { useT } from '../lib/i18n';
import { isTauri } from '../lib/tauri-api';

interface ImagePreviewProps {
  /** backend files authzへ渡すproject root */
  projectRoot: string;
  /** ヘッダ表示用 (相対パス想定だが実装側で自由に決めて良い) */
  relativePath: string;
}

export function ImagePreview({ projectRoot, relativePath }: ImagePreviewProps): JSX.Element {
  const t = useT();
  const [errored, setErrored] = useState(false);
  const [url, setUrl] = useState('');
  const tauri = isTauri();

  useEffect(() => {
    if (!tauri) return;
    let cancelled = false;
    setErrored(false);
    setUrl('');
    void window.api.files
      .readImage(projectRoot, relativePath)
      .then((result) => {
        if (cancelled) return;
        if (result.ok && result.dataUrl) setUrl(result.dataUrl);
        else setErrored(true);
      })
      .catch(() => {
        if (!cancelled) setErrored(true);
      });
    return () => {
      cancelled = true;
    };
  }, [projectRoot, relativePath, tauri]);

  if (!tauri) {
    return (
      <div className="image-preview">
        <div className="image-preview__error">{t('imagePreview.devUnavailable')}</div>
      </div>
    );
  }

  if (errored || !url) {
    return (
      <div className="image-preview">
        <div className="image-preview__error">
          {t('imagePreview.loadError', { path: relativePath })}
        </div>
      </div>
    );
  }

  return (
    <div className="image-preview">
      <img
        className="image-preview__img"
        src={url}
        alt={relativePath}
        onError={() => setErrored(true)}
        draggable={false}
      />
    </div>
  );
}
