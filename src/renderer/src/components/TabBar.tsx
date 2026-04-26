import { Circle, Pin, X } from 'lucide-react';
import { useT } from '../lib/i18n';

export interface TabItem {
  id: string;
  title: string;
  dirty?: boolean;
  closable?: boolean;
  pinned?: boolean;
  hasActivity?: boolean;
  busy?: boolean;
}

interface TabBarProps {
  tabs: TabItem[];
  activeId: string;
  onSelect: (id: string) => void;
  onClose?: (id: string) => void;
  onTogglePin?: (id: string) => void;
}

export function TabBar({
  tabs,
  activeId,
  onSelect,
  onClose,
  onTogglePin
}: TabBarProps): JSX.Element {
  const t = useT();
  return (
    <div className="tabbar" role="tablist">
      {tabs.map((tab) => {
        const active = tab.id === activeId;

        return (
          <div
            key={tab.id}
            className={`tabbar__tab ${active ? 'is-active' : ''} ${tab.pinned ? 'is-pinned' : ''}`}
            onClick={() => onSelect(tab.id)}
            onAuxClick={(e) => {
              if (e.button === 1 && tab.closable && !tab.pinned && onClose) {
                e.preventDefault();
                onClose(tab.id);
              }
            }}
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onSelect(tab.id);
              }
            }}
          >
            <span className="tabbar__indicators">
              {tab.pinned ? (
                <Pin size={12} strokeWidth={2} className="tabbar__pin" aria-label={t('tab.pinned')} />
              ) : null}
              {tab.busy ? <span className="tabbar__spinner" aria-hidden="true" /> : null}
              {tab.hasActivity && !tab.busy ? (
                <span className="tabbar__activity" title={t('tab.newOutput')} />
              ) : null}
              {tab.dirty ? (
                <Circle
                  size={8}
                  strokeWidth={1.6}
                  fill="currentColor"
                  aria-hidden="true"
                  style={{ color: 'var(--accent)' }}
                />
              ) : null}
            </span>

            <span className="tabbar__title">{tab.title}</span>

            {onTogglePin && tab.closable ? (
              <button
                type="button"
                className="tabbar__pin-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  onTogglePin(tab.id);
                }}
                title={tab.pinned ? t('tab.unpin') : t('tab.pin')}
                aria-label={tab.pinned ? t('tab.unpin') : t('tab.pin')}
              >
                <Pin size={12} strokeWidth={2} />
              </button>
            ) : null}

            {tab.closable && !tab.pinned && onClose ? (
              <button
                type="button"
                className="tabbar__close"
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(tab.id);
                }}
                aria-label={t('tab.close')}
                title={t('tab.closeWithShortcut')}
              >
                <X size={13} strokeWidth={2} />
              </button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
