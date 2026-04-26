/**
 * QuickNav (Ctrl+Shift+K) — Canvas 上の Card を fuzzy 検索 → fitView でズームジャンプ。
 *
 * Phase 4 のキー UX。CommandPalette とは別に Canvas 専用の軽量パレットとして実装。
 * Phase 4 後半で CommandPalette 側に統合検討。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useReactFlow } from '@xyflow/react';
import { useCanvasStore } from '../../stores/canvas';
import { useT } from '../../lib/i18n';
import { metaOf } from '../../lib/team-roles';

interface QuickNavProps {
  open: boolean;
  onClose: () => void;
}

export function QuickNav({ open, onClose }: QuickNavProps): JSX.Element | null {
  const t = useT();
  const nodes = useCanvasStore((s) => s.nodes);
  const rf = useReactFlow();
  const [query, setQuery] = useState('');
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // open 切替で reset + focus
  // Issue #181: open を高速トグル/Escape 連打したときに setTimeout が複数積まれて
  // unmount 後にも focus を奪う余地があったため、cleanup で clearTimeout を返す。
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActiveIdx(0);
    const handle = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(handle);
  }, [open]);

  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    return nodes
      .map((n) => {
        const data = n.data ?? {};
        const title = String(data.title ?? n.id);
        const cardType = String(data.cardType ?? n.type ?? '');
        // Issue #194: canvas store v2 マイグレーションで legacy `role` は基本 undefined になり、
        // 全カードがデフォルト紫 + 汎用 glyph で表示されて QuickNav が機能ほぼ無価値だった。
        // AgentNodeCard と同じく roleProfileId を優先し、無ければ legacy role を fallback。
        const payload = data.payload as
          | { roleProfileId?: string; role?: string }
          | undefined;
        const roleId = payload?.roleProfileId ?? payload?.role;
        const meta = metaOf(roleId);
        const subtitle = meta ? meta.label : cardType;
        const haystack = `${title} ${subtitle} ${roleId ?? ''}`.toLowerCase();
        return { node: n, title, subtitle, role: roleId, haystack };
      })
      .filter((i) => !q || i.haystack.includes(q));
  }, [nodes, query]);

  useEffect(() => {
    if (activeIdx >= items.length) setActiveIdx(0);
  }, [items.length, activeIdx]);

  const jumpTo = (id: string): void => {
    const node = nodes.find((n) => n.id === id);
    if (!node) return;
    rf.fitView({ nodes: [{ id }], padding: 0.4, duration: 400, maxZoom: 1.4 });
    onClose();
  };

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIdx((i) => Math.min(items.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const item = items[activeIdx];
      if (item) jumpTo(item.node.id);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  if (!open) return null;
  return (
    <div
      onMouseDown={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.55)',
        zIndex: 100,
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        paddingTop: 120
      }}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          width: 520,
          maxWidth: '90vw',
          background: 'var(--bg-elevated, #16161c)',
          border: '1px solid var(--border, #2a2a35)',
          borderRadius: 10,
          boxShadow: '0 24px 64px rgba(0,0,0,0.6)',
          overflow: 'hidden'
        }}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKey}
          placeholder={t('quicknav.placeholder')}
          style={{
            width: '100%',
            padding: '12px 16px',
            background: 'transparent',
            color: 'var(--fg, #e6e6e6)',
            border: 0,
            borderBottom: '1px solid var(--border, #2a2a35)',
            fontSize: 14,
            outline: 'none'
          }}
        />
        <ul
          style={{
            listStyle: 'none',
            margin: 0,
            padding: 4,
            maxHeight: 360,
            overflowY: 'auto'
          }}
        >
          {items.length === 0 && (
            <li style={{ padding: 16, color: 'var(--fg-muted, #8a8aa3)', fontSize: 12 }}>
              {t('quicknav.empty')}
            </li>
          )}
          {items.map((item, i) => {
            const meta = metaOf(item.role);
            const accent = meta?.color ?? '#7a7afd';
            const active = i === activeIdx;
            return (
              <li key={item.node.id}>
                <button
                  type="button"
                  onClick={() => jumpTo(item.node.id)}
                  onMouseEnter={() => setActiveIdx(i)}
                  style={{
                    width: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '8px 12px',
                    background: active ? 'rgba(92,92,255,0.12)' : 'transparent',
                    color: 'var(--fg, #e6e6e6)',
                    border: 0,
                    borderRadius: 6,
                    cursor: 'pointer',
                    textAlign: 'left',
                    fontSize: 13
                  }}
                >
                  <span
                    aria-hidden="true"
                    style={{
                      width: 18,
                      height: 18,
                      borderRadius: '50%',
                      background: accent,
                      color: '#0a0a0d',
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: 10,
                      fontWeight: 700
                    }}
                  >
                    {meta?.glyph ?? '·'}
                  </span>
                  <span style={{ flex: 1, fontWeight: 500 }}>{item.title}</span>
                  <span style={{ fontSize: 10, color: 'var(--fg-muted, #8a8aa3)' }}>
                    {item.subtitle}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        <footer
          style={{
            padding: '6px 12px',
            borderTop: '1px solid var(--border, #2a2a35)',
            display: 'flex',
            gap: 12,
            fontSize: 10,
            color: 'var(--fg-muted, #8a8aa3)'
          }}
        >
          <span>{t('quicknav.hintNavigate')}</span>
          <span>{t('quicknav.hintJump')}</span>
          <span>{t('quicknav.hintClose')}</span>
        </footer>
      </div>
    </div>
  );
}
