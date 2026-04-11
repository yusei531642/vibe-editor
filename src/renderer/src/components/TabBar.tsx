import { Pin, X } from 'lucide-react';

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
  return (
    <div className="tabbar" role="tablist">
      {tabs.map((tab) => (
        <div
          key={tab.id}
          className={`tabbar__tab ${tab.id === activeId ? 'is-active' : ''} ${tab.pinned ? 'is-pinned' : ''}`}
          onClick={() => onSelect(tab.id)}
          onAuxClick={(e) => {
            if (e.button === 1 && tab.closable && !tab.pinned && onClose) {
              e.preventDefault();
              onClose(tab.id);
            }
          }}
          role="tab"
          aria-selected={tab.id === activeId}
          tabIndex={tab.id === activeId ? 0 : -1}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onSelect(tab.id);
            }
          }}
        >
          {tab.pinned && (
            <Pin
              size={12}
              strokeWidth={2}
              className="tabbar__pin"
              aria-label="ピン留め中"
            />
          )}
          {tab.busy && <span className="tabbar__spinner" aria-hidden="true" />}
          <span className="tabbar__title">{tab.title}</span>
          {tab.hasActivity && !tab.busy && (
            <span className="tabbar__activity" title="新しい出力" />
          )}
          {tab.dirty && <span className="tabbar__dirty" title="未保存" />}
          {onTogglePin && tab.closable && (
            <button
              type="button"
              className="tabbar__pin-btn"
              onClick={(e) => {
                e.stopPropagation();
                onTogglePin(tab.id);
              }}
              title={tab.pinned ? 'ピンを外す' : 'ピン留め'}
              aria-label={tab.pinned ? 'ピンを外す' : 'ピン留め'}
            >
              <Pin size={12} strokeWidth={2} />
            </button>
          )}
          {tab.closable && !tab.pinned && onClose && (
            <button
              type="button"
              className="tabbar__close"
              onClick={(e) => {
                e.stopPropagation();
                onClose(tab.id);
              }}
              aria-label="タブを閉じる"
              title="閉じる (Ctrl+W)"
            >
              <X size={13} strokeWidth={2} />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
