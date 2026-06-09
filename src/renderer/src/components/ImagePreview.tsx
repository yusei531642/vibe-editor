/**
 * ImagePreview — Canvas / IDE で画像ファイルをプレビューするコンポーネント。
 *
 * Issue #325: ファイルツリーから png/jpg/gif/webp 等を開いたとき、Monaco の
 * binary プレースホルダではなく実際の画像を表示する。Tauri v2 の asset プロトコル
 * (convertFileSrc) で `asset://` URL を生成して <img> に渡す。
 *
 * dev:vite 直接アクセス (Tauri ランタイム不在) では convertFileSrc が機能しないため、
 * その場合は静的なフォールバックメッセージを出す。
 */
import { useMemo, useState } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { useT } from '../lib/i18n';
import { isTauri } from '../lib/tauri-api';

interface ImagePreviewProps {
  /** OS 絶対パス。convertFileSrc に渡される */
  absolutePath: string;
  /** ヘッダ表示用 (相対パス想定だが実装側で自由に決めて良い) */
  relativePath: string;
}

export function ImagePreview({ absolutePath, relativePath }: ImagePreviewProps): JSX.Element {
  const t = useT();
  const [errored, setErrored] = useState(false);
  const tauri = isTauri();
  const url = useMemo(() => {
    if (!tauri) return '';
    try {
      return convertFileSrc(absolutePath);
    } catch {
      return '';
    }
  }, [absolutePath, tauri]);

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
