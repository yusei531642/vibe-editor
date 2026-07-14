import React from 'react';
import { resolveBootstrapLanguage, translate } from '../lib/i18n';

export class AppErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('[renderer] uncaught render error', error, info);
  }

  render(): React.ReactNode {
    if (!this.state.error) return this.props.children;

    const language = resolveBootstrapLanguage();
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'grid',
          placeItems: 'center',
          padding: 24,
          background: 'var(--bg, #111)',
          color: 'var(--text, #f5f5f5)',
          fontFamily: 'var(--ui-font, system-ui, sans-serif)'
        }}
      >
        <section
          style={{
            width: 'min(560px, 100%)',
            border: '1px solid var(--border, rgba(255,255,255,0.14))',
            borderRadius: 8,
            padding: 20,
            background: 'var(--bg-panel, rgba(255,255,255,0.04))'
          }}
        >
          <h1 style={{ margin: '0 0 10px', fontSize: 18 }}>
            {translate(language, 'bootstrap.renderError.title')}
          </h1>
          <p style={{ margin: '0 0 14px', color: 'var(--text-dim, #bbb)', lineHeight: 1.6 }}>
            {translate(language, 'bootstrap.renderError.body')}
          </p>
          <pre
            style={{
              maxHeight: 180,
              overflow: 'auto',
              padding: 12,
              borderRadius: 6,
              background: 'rgba(0,0,0,0.28)',
              color: 'var(--text, #f5f5f5)',
              fontSize: 12,
              whiteSpace: 'pre-wrap'
            }}
          >
            {this.state.error.message}
          </pre>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{
              marginTop: 14,
              height: 32,
              padding: '0 12px',
              borderRadius: 6,
              background: 'var(--accent, #d97757)',
              color: '#fff',
              border: 0,
              cursor: 'pointer'
            }}
          >
            {translate(language, 'bootstrap.renderError.reload')}
          </button>
        </section>
      </div>
    );
  }
}
