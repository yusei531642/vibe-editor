import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { AppErrorBoundary } from '../AppErrorBoundary';
import { BOOTSTRAP_LANGUAGE_STORAGE_KEY } from '../../lib/i18n';

function CrashedView(): JSX.Element {
  throw new Error('render failed');
}

describe('AppErrorBoundary', () => {
  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it('保存済みの英語設定でクラッシュ復帰画面を表示する', () => {
    window.localStorage.setItem(BOOTSTRAP_LANGUAGE_STORAGE_KEY, 'en');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    render(
      <AppErrorBoundary>
        <CrashedView />
      </AppErrorBoundary>
    );

    expect(screen.getByRole('heading')).toHaveTextContent(
      'Something went wrong while rendering the screen'
    );
    expect(screen.getByText('render failed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
  });

  it('保存済みの日本語設定でクラッシュ復帰画面を表示する', () => {
    window.localStorage.setItem(BOOTSTRAP_LANGUAGE_STORAGE_KEY, 'ja');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    render(
      <AppErrorBoundary>
        <CrashedView />
      </AppErrorBoundary>
    );

    expect(screen.getByRole('heading')).toHaveTextContent('画面の描画で問題が発生しました');
    expect(screen.getByRole('button', { name: '再読み込み' })).toBeInTheDocument();
  });
});
