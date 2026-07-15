import React, { type ReactElement, type ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  renderedTree: null as unknown,
  canvasChildMounts: 0,
  canvasChildUnmounts: 0,
  providerSequence: 0,
  tabsSequence: 0,
  teamSequence: 0
}));

vi.mock('react-dom/client', () => ({
  default: {
    createRoot: () => ({
      render: (tree: unknown) => {
        harness.renderedTree = tree;
      }
    })
  }
}));

vi.mock('../lib/tauri-api', () => ({}));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => vi.fn()) }));

vi.mock('../components/AppErrorBoundary', () => ({
  AppErrorBoundary: ({ children }: { children: ReactNode }) => children
}));

vi.mock('../lib/settings-context', () => {
  const settings = {
    language: 'ja',
    mcpAutoSetup: false,
    customAgents: [],
    recentProjects: []
  };
  return {
    SettingsProvider: ({ children }: { children: ReactNode }) => children,
    useSettings: () => ({ settings, update: vi.fn(), reset: vi.fn() })
  };
});

vi.mock('../lib/toast-context', () => ({
  ToastProvider: ({ children }: { children: ReactNode }) => children,
  useToast: () => ({ showToast: vi.fn(), dismissToast: vi.fn() })
}));

vi.mock('../lib/role-profiles-context', () => ({
  RoleProfilesProvider: ({ children }: { children: ReactNode }) => children
}));

vi.mock('../lib/filetree-state-context', () => ({
  FileTreeStateProvider: ({ children }: { children: ReactNode }) => children
}));

vi.mock('../lib/i18n', () => ({
  resolveBootstrapLanguage: () => 'ja',
  translate: (_language: string, key: string) => key,
  useT: () => (key: string) => key
}));

vi.mock('../lib/webview-zoom', () => ({
  webviewZoom: { in: vi.fn(), out: vi.fn(), reset: vi.fn() }
}));

vi.mock('../lib/use-window-frame-insets', () => ({ useWindowFrameInsets: vi.fn() }));

vi.mock('../lib/hooks/use-project-loader', async () => {
  const ReactModule = await import('react');
  return {
    useProjectLoader: (options: { onProjectSwitched: (root: string) => void }) => {
      const marker = ReactModule.useRef<string | null>(null);
      if (marker.current === null) {
        marker.current = `project-provider-${++harness.providerSequence}`;
      }
      const [projectRoot, setProjectRoot] = ReactModule.useState('C:\\project-a');
      const loadProject = async (root: string): Promise<boolean> => {
        setProjectRoot(root);
        options.onProjectSwitched(root);
        return true;
      };
      return {
        instanceMarker: marker.current,
        projectRoot,
        loadProject,
        refreshGit: vi.fn(async () => undefined),
        gitStatus: null,
        gitLoading: false,
        workspaceFolders: [],
        handleNewProject: vi.fn(async () => undefined),
        handleOpenFolder: vi.fn(async () => undefined),
        handleOpenFile: vi.fn(async () => undefined),
        handleOpenRecent: loadProject,
        handleClearRecent: vi.fn(),
        handleAddWorkspaceFolder: vi.fn(async () => undefined),
        handleRemoveWorkspaceFolder: vi.fn(async () => undefined)
      };
    }
  };
});

vi.mock('../lib/hooks/use-file-tabs', async () => {
  const ReactModule = await import('react');
  return {
    useFileTabs: ({ projectRoot }: { projectRoot: string }) => {
      const marker = ReactModule.useRef<string | null>(null);
      if (marker.current === null) marker.current = `tabs-provider-${++harness.tabsSequence}`;
      return {
        instanceMarker: marker.current,
        projectMarker: projectRoot,
        editorTabs: [],
        setEditorTabs: vi.fn(),
        diffTabs: [],
        refreshDiffTabsForPath: vi.fn(async () => undefined),
        confirmDiscardEditorTabs: vi.fn(async () => true),
        resetForProjectSwitch: vi.fn()
      };
    }
  };
});

vi.mock('../lib/hooks/use-terminal-tabs', async () => {
  const ReactModule = await import('react');
  return {
    useTerminalTabs: () => ({
      terminalTabs: [],
      setTerminalTabs: vi.fn(),
      activeTerminalTabId: null,
      setActiveTerminalTabId: vi.fn(),
      addTerminalTab: vi.fn(),
      doCloseTab: vi.fn(),
      nextTerminalIdRef: ReactModule.useRef(1),
      resetForProjectSwitch: vi.fn()
    })
  };
});

vi.mock('../lib/hooks/use-terminal-tabs-persistence', () => ({
  useTerminalTabsPersistence: () => ({ reportSize: vi.fn() })
}));

vi.mock('../lib/hooks/use-team-management', async () => {
  const ReactModule = await import('react');
  return {
    useTeamManagement: ({ projectRoot }: { projectRoot: string }) => {
      const marker = ReactModule.useRef<string | null>(null);
      if (marker.current === null) marker.current = `team-provider-${++harness.teamSequence}`;
      return {
        instanceMarker: marker.current,
        projectMarker: projectRoot,
        doCloseTeam: vi.fn(),
        resetForProjectSwitch: vi.fn()
      };
    }
  };
});

vi.mock('../lib/hooks/use-claude-check', () => ({
  useClaudeCheck: () => ({
    claudeCheck: { state: 'ok' },
    runClaudeCheck: vi.fn(async () => undefined)
  })
}));

vi.mock('../components/AppShell', async () => {
  const ReactModule = await import('react');
  const context = await import('../lib/app-state-context');
  return {
    AppShell: () => {
      const project = context.useProject() as ReturnType<typeof context.useProject> & {
        instanceMarker: string;
      };
      const tabs = context.useTabs() as ReturnType<typeof context.useTabs> & {
        instanceMarker: string;
        projectMarker: string;
      };
      const team = context.useTeam() as ReturnType<typeof context.useTeam> & {
        instanceMarker: string;
        projectMarker: string;
      };
      return ReactModule.createElement(
        'section',
        {
          'data-testid': 'app-shell-probe',
          'data-project-instance': project.instanceMarker,
          'data-tabs-instance': tabs.instanceMarker,
          'data-team-instance': team.instanceMarker,
          'data-project-root': project.projectRoot,
          'data-tabs-project': tabs.projectMarker,
          'data-team-project': team.projectMarker
        },
        ReactModule.createElement(
          'button',
          {
            type: 'button',
            onClick: () => void project.loadProject('C:\\project-b')
          },
          'switch project'
        )
      );
    }
  };
});

vi.mock('../stores/canvas', () => {
  const state = { nodes: [] };
  const useCanvasStore = Object.assign(
    (selector: (value: typeof state) => unknown) => selector(state),
    {
      getState: () => state,
      subscribe: () => vi.fn()
    }
  );
  return { useCanvasStore };
});

vi.mock('../stores/canvas-selectors', () => ({
  useCanvasViewport: () => ({ x: 0, y: 0, zoom: 1 })
}));

vi.mock('../stores/canvas-persistence', () => ({ takeCanvasRecoveryNotice: () => null }));

vi.mock('../lib/hooks/use-canvas-add-card', () => ({
  useCanvasAddCard: () => ({
    stagger: vi.fn(() => ({ x: 0, y: 0 })),
    addAgent: vi.fn(),
    addCustomAgent: vi.fn(),
    addApiAgent: vi.fn(),
    addByType: vi.fn()
  })
}));

vi.mock('../lib/hooks/use-canvas-spawn', () => ({
  useCanvasSpawn: () => ({
    recent: [],
    setRecent: vi.fn(),
    closeRecent: vi.fn(),
    applyPreset: vi.fn(async () => undefined),
    applySavedPreset: vi.fn(async () => undefined),
    applyCustomAgentLeaderPreset: vi.fn(async () => undefined),
    restoreRecent: vi.fn(async () => undefined),
    spawnTeamPresetById: vi.fn(async () => undefined)
  })
}));

vi.mock('../lib/hooks/use-canvas-menu-actions', () => ({
  useCanvasMenuActions: () => ({
    handleClickUpdate: vi.fn(),
    handleNewProject: vi.fn(),
    handleOpenFolder: vi.fn(),
    handleOpenFile: vi.fn(),
    handleAddWorkspaceFolder: vi.fn(),
    handleOpenRecent: vi.fn(),
    handleRestart: vi.fn(),
    handleCheckUpdate: vi.fn(),
    handleOpenGithub: vi.fn(),
    clearCanvas: vi.fn()
  })
}));

vi.mock('../lib/hooks/use-canvas-team-restore', () => ({ useCanvasTeamRestore: vi.fn() }));
vi.mock('../lib/hooks/use-canvas-auto-save', () => ({ useCanvasAutoSave: vi.fn() }));
vi.mock('../lib/hooks/use-layout-resize', () => ({
  useLayoutResize: () => ({
    onSidebarResizeStart: vi.fn(),
    onSidebarResizeDouble: vi.fn()
  })
}));

vi.mock('../components/canvas/Canvas', async () => {
  const ReactModule = await import('react');
  const context = await import('../lib/app-state-context');
  return {
    Canvas: () => {
      const project = context.useProject() as ReturnType<typeof context.useProject> & {
        instanceMarker: string;
      };
      const tabs = context.useTabs() as ReturnType<typeof context.useTabs> & {
        instanceMarker: string;
        projectMarker: string;
      };
      const team = context.useTeam() as ReturnType<typeof context.useTeam> & {
        instanceMarker: string;
        projectMarker: string;
      };
      ReactModule.useEffect(() => {
        harness.canvasChildMounts += 1;
        return () => {
          harness.canvasChildUnmounts += 1;
        };
      }, []);
      return ReactModule.createElement('div', {
        'data-testid': 'canvas-child-probe',
        'data-project-instance': project.instanceMarker,
        'data-tabs-instance': tabs.instanceMarker,
        'data-team-instance': team.instanceMarker,
        'data-project-root': project.projectRoot,
        'data-tabs-project': tabs.projectMarker,
        'data-team-project': team.projectMarker
      });
    }
  };
});

vi.mock('../components/canvas/CanvasSidebar', () => ({ CanvasSidebar: () => null }));
vi.mock('../components/canvas/CanvasSpawnFab', () => ({ CanvasSpawnFab: () => null }));
vi.mock('../components/canvas/VoiceControlButton', () => ({ VoiceControlButton: () => null }));
vi.mock('../components/shell/Rail', () => ({ Rail: () => null }));
vi.mock('../components/shell/Topbar', () => ({ Topbar: () => null }));
vi.mock('../components/shell/AppMenuBar', () => ({ AppMenuBar: () => null }));
vi.mock('../components/SettingsModal', () => ({ SettingsModal: () => null }));
vi.mock('../lib/workspace-presets', () => ({ DEFAULT_SPAWN_PRESET: {} }));
vi.mock('lucide-react', () => ({ Layout: () => null }));

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

describe('main provider boundary', () => {
  it('keeps the single real CanvasLayout inside the shared AppStateProvider across mode changes', async () => {
    document.body.innerHTML = '<div id="root"></div>';
    const { useUiStore } = await import('../stores/ui');
    useUiStore.setState({ viewMode: 'ide', sidebarCollapsed: true });

    await import('../main');
    expect(harness.renderedTree).not.toBeNull();

    const view = render(harness.renderedTree as ReactElement);
    const shell = screen.getByTestId('app-shell-probe');
    const canvas = view.container.querySelector<HTMLElement>('.canvas-layout');
    const canvasChild = screen.getByTestId('canvas-child-probe');
    expect(canvas).not.toBeNull();
    expect(view.container.querySelectorAll('.canvas-layout')).toHaveLength(1);
    expect(shell.compareDocumentPosition(canvas as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    for (const key of ['project-instance', 'tabs-instance', 'team-instance']) {
      expect(canvasChild.dataset[key]).toBe(shell.dataset[key]);
    }
    expect(canvas).toHaveStyle({ display: 'none' });
    expect(canvas).toHaveAttribute('aria-hidden', 'true');

    const initialCanvasNode = canvas;
    const baselineMounts = harness.canvasChildMounts;
    const baselineUnmounts = harness.canvasChildUnmounts;

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'switch project' }));
    });
    expect(shell).toHaveAttribute('data-project-root', 'C:\\project-b');
    expect(canvasChild).toHaveAttribute('data-project-root', 'C:\\project-b');
    expect(canvasChild).toHaveAttribute('data-tabs-project', 'C:\\project-b');
    expect(canvasChild).toHaveAttribute('data-team-project', 'C:\\project-b');

    act(() => useUiStore.getState().setViewMode('canvas'));
    expect(view.container.querySelector('.canvas-layout')).toBe(initialCanvasNode);
    expect(initialCanvasNode).not.toHaveStyle({ display: 'none' });
    expect(initialCanvasNode).toHaveAttribute('aria-hidden', 'false');

    act(() => useUiStore.getState().setViewMode('ide'));
    expect(view.container.querySelector('.canvas-layout')).toBe(initialCanvasNode);
    expect(initialCanvasNode).toHaveStyle({ display: 'none' });
    expect(initialCanvasNode).toHaveAttribute('aria-hidden', 'true');
    expect(harness.canvasChildMounts).toBe(baselineMounts);
    expect(harness.canvasChildUnmounts).toBe(baselineUnmounts);
  });
});
