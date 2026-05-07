/**
 * AgentNodeCard の振る舞いテスト。
 *
 * Issue #495 / PR #489: 単一ファイルだった AgentNodeCard を CardFrame.tsx (枠 + handoff UI)
 * と TerminalOverlay.tsx (PTY 配線) に分割した。
 *
 * 検証範囲:
 *   1. props (NodeProps) で渡された agent 情報がヘッダに描画される
 *   2. roleProfileId='leader' のときだけ handoff ボタンが描画される
 *   3. handoff ボタン押下で window.api.handoffs.create が呼ばれる
 *
 * `@xyflow/react` の Handle / NodeResizer は ReactFlowProvider 不在では使えないので
 * vi.mock() でプレーン div に差し替える。TerminalOverlay も PTY/xterm 全体を引きずるので
 * 同様にスタブ化する (テスト対象は CardFrame の振る舞いに絞る)。
 * RoleProfiles / Settings / Toast はテスト用のプロバイダ最小実装をモックして提供する。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('@xyflow/react', () => ({
  Handle: () => null,
  NodeResizer: () => null,
  Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' },
  useReactFlow: () => ({})
}));

vi.mock('../AgentNodeCard/TerminalOverlay', () => ({
  TerminalOverlay: () => <div data-testid="terminal-overlay-stub" />
}));

// useRoleProfiles / renderSystemPrompt を最小スタブ化。leader / programmer の 2 件だけを
// 持つ profilesById を返し、AgentNodeCard が visual 解決に使う場面を満たす。
vi.mock('../../../../lib/role-profiles-context', () => {
  type RoleProfile = {
    id: string;
    visual: { color: string; glyph: string };
    i18n: {
      ja: { label: string; description: string };
      en: { label: string; description: string };
    };
  };
  const profiles: Record<string, RoleProfile> = {
    leader: {
      id: 'leader',
      visual: { color: '#7a7afd', glyph: '★' },
      i18n: {
        ja: { label: 'リーダー', description: 'チームを統括する' },
        en: { label: 'Leader', description: 'Team lead' }
      }
    },
    programmer: {
      id: 'programmer',
      visual: { color: '#5cffba', glyph: '⌥' },
      i18n: {
        ja: { label: 'プログラマー', description: '実装担当' },
        en: { label: 'Programmer', description: 'Implements code' }
      }
    }
  };
  return {
    useRoleProfiles: () => ({
      byId: profiles,
      ordered: Object.values(profiles),
      file: { schemaVersion: 1, overrides: {}, custom: [], globalPreamble: '' },
      saveFile: vi.fn(),
      upsertOverride: vi.fn(),
      addCustom: vi.fn(),
      removeCustom: vi.fn(),
      registerDynamicRole: vi.fn(),
      error: null
    }),
    renderSystemPrompt: () => 'mocked system prompt',
    fallbackProfile: (id: string) => profiles[id] ?? profiles.leader,
    profileText: (p: RoleProfile, _lang: 'ja' | 'en') => p.i18n.ja
  };
});

import AgentNodeCard from '../AgentNodeCard';
import { SettingsProvider } from '../../../../lib/settings-context';
import { ToastProvider } from '../../../../lib/toast-context';
import type { ReactNode } from 'react';
import { DEFAULT_SETTINGS } from '../../../../../../types/shared';

type TestWindow = Window &
  typeof globalThis & {
    api?: unknown;
  };

function installApi(): {
  load: ReturnType<typeof vi.fn>;
  save: ReturnType<typeof vi.fn>;
  handoffsCreate: ReturnType<typeof vi.fn>;
} {
  const load = vi.fn(async () => DEFAULT_SETTINGS);
  const save = vi.fn(async () => undefined);
  const handoffsCreate = vi.fn(async () => ({
    ok: true,
    handoff: {
      id: 'handoff-1',
      kind: 'leader',
      status: 'pending',
      createdAt: '2026-05-07T00:00:00Z',
      updatedAt: '2026-05-07T00:00:00Z',
      jsonPath: '/tmp/handoff.json',
      markdownPath: '/tmp/handoff.md',
      fromAgentId: 'leader-agent-1',
      toAgentId: null,
      replacementForAgentId: 'leader-agent-1'
    }
  }));

  (window as TestWindow).api = {
    settings: { load, save },
    app: {
      setProjectRoot: vi.fn(async () => undefined),
      setZoomLevel: vi.fn(async () => undefined),
      revealInFileManager: vi.fn(async () => undefined)
    },
    handoffs: { create: handoffsCreate }
  };

  return { load, save, handoffsCreate };
}

function Wrapper({ children }: { children: ReactNode }): JSX.Element {
  return (
    <SettingsProvider>
      <ToastProvider>{children}</ToastProvider>
    </SettingsProvider>
  );
}

function renderCard(overrides: { id?: string; data?: Record<string, unknown> }) {
  const props = {
    id: overrides.id ?? 'agent-1',
    data: overrides.data ?? {},
    selected: false,
    type: 'agent',
    dragging: false,
    isConnectable: true,
    zIndex: 0,
    xPos: 0,
    yPos: 0,
    targetPosition: 'left',
    sourcePosition: 'right'
  } as unknown as Parameters<typeof AgentNodeCard>[0];
  return render(
    <Wrapper>
      <AgentNodeCard {...props} />
    </Wrapper>
  );
}

describe('AgentNodeCard', () => {
  let originalApi: unknown;

  beforeEach(() => {
    originalApi = (window as TestWindow).api;
  });

  afterEach(() => {
    cleanup();
    if (originalApi === undefined) {
      delete (window as TestWindow).api;
    } else {
      (window as TestWindow).api = originalApi;
    }
    vi.restoreAllMocks();
  });

  it('Leader カードはタイトルと handoff ボタンが描画される', async () => {
    installApi();

    renderCard({
      id: 'leader-1',
      data: {
        title: 'My Leader',
        payload: {
          agent: 'claude',
          agentId: 'leader-agent-1',
          teamId: 'team-1',
          roleProfileId: 'leader'
        }
      }
    });

    expect(await screen.findByText('My Leader')).toBeInTheDocument();
    // handoff ボタンは aria-label でアクセス可能 (i18n: 'handoff.create' 経由)
    expect(screen.getByRole('button', { name: /引き継ぎ|Hand[- ]?off/i })).toBeInTheDocument();
  });

  it('Worker カード (roleProfileId !== leader) では handoff ボタンが出ない', async () => {
    installApi();

    renderCard({
      id: 'worker-1',
      data: {
        title: 'Programmer #1',
        payload: {
          agent: 'claude',
          agentId: 'worker-agent-1',
          teamId: 'team-1',
          roleProfileId: 'programmer'
        }
      }
    });

    expect(await screen.findByText('Programmer #1')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /引き継ぎ|Hand[- ]?off/i })).toBeNull();
  });

  it('Leader の handoff ボタンクリックで window.api.handoffs.create が呼ばれる', async () => {
    const api = installApi();

    renderCard({
      id: 'leader-1',
      data: {
        title: 'My Leader',
        payload: {
          agent: 'claude',
          agentId: 'leader-agent-1',
          teamId: 'team-1',
          roleProfileId: 'leader',
          // cwd を含めて noProject error を回避 (lastOpenedRoot は default の '' のため)
          cwd: '/tmp/work'
        }
      }
    });

    const btn = await screen.findByRole('button', { name: /引き継ぎ|Hand[- ]?off/i });
    fireEvent.click(btn);

    // SettingsProvider の load が完了してから render 内で title が出るので、findByText で同期。
    await screen.findByText('My Leader');
    expect(api.handoffsCreate).toHaveBeenCalledTimes(1);
    const arg = api.handoffsCreate.mock.calls[0][0];
    expect(arg).toMatchObject({
      projectRoot: '/tmp/work',
      teamId: 'team-1',
      kind: 'leader',
      fromAgentId: 'leader-agent-1'
    });
  });
});
