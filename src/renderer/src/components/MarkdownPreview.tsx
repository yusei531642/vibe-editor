/**
 * MarkdownPreview — Markdown 文字列を HTML にレンダリングして表示する。
 *
 * - parser: `marked` (軽量・GFM 対応)
 * - sanitize: `dompurify` で XSS 防止 (md 内に <script> や onclick="..." を書かれても無効化)
 * - スタイル: index.css の `.md-preview` 配下
 */
import { useEffect, useMemo, useRef } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

interface MarkdownPreviewProps {
  source: string;
}

export function MarkdownPreview({ source }: MarkdownPreviewProps): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);

  const html = useMemo(() => {
    // marked v9+ は parse が string を返す (async モードを使わない限り同期)
    const raw = marked.parse(source, { async: false, gfm: true, breaks: false }) as string;
    return DOMPurify.sanitize(raw, {
      // 既定は十分に安全。<a> の target=_blank をリンクハンドラで補足するため属性は残す。
      ADD_ATTR: ['target']
    });
  }, [source]);

  // すべての <a> を Tauri ネイティブブラウザで開くようにフック (renderer 内遷移を防ぐ)
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const onClick = (e: MouseEvent): void => {
      const a = (e.target as HTMLElement | null)?.closest('a');
      if (!a) return;
      const href = a.getAttribute('href');
      if (!href) return;
      // 内部アンカー (#section) は普通に動かす
      if (href.startsWith('#')) return;
      e.preventDefault();
      void window.api.app.openExternal(href);
    };
    root.addEventListener('click', onClick);
    return () => root.removeEventListener('click', onClick);
  }, [html]);

  return (
    <div
      ref={ref}
      className="md-preview"
      // sanitize 済みなので innerHTML は安全
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
