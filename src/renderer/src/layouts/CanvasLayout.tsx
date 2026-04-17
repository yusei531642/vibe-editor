/**
 * CanvasLayout — Canvas モードのトップレベルレイアウト。
 *
 * Phase 3:
 *   - Workspace Preset セレクタ (BUILTIN_PRESETS から 1 クリックでチーム配置)
 *   - Card 数表示 + Clear
 *   - IDE モードへ戻るボタン
 *
 * Phase 5:
 *   - Preset 起動時に teamHistory に自動保存 (canvasState 込み)
 *   - "Recent Teams" タブで過去チームを再開 (Card 配置完全復元)
 */
import { useEffect, useMemo, useState } from 'react';
import {
  Bot,
  FilePlus,
  FolderTree,
  GitBranch,
  Layout,
  MonitorSmartphone,
  Plus,
  Sparkles,
  Users,
  History
} from 'lucide-react';
import type { CardType } from '../stores/canvas';
import type {
  Team,
  TeamHistoryEntry,
  TeamMember,
  TeamPreset,
  TeamRole,
  TerminalAgent
} from '../../../types/shared';
import { Canvas } from '../components/canvas/Canvas';
import { CanvasSidebar } from '../components/canvas/CanvasSidebar';
import { SettingsModal } from '../components/SettingsModal';
import { TeamCreateModal } from '../components/TeamCreateModal';
import { useUiStore } from '../stores/ui';
import { useCanvasStore } from '../stores/canvas';
import {
  BUILTIN_PRESETS,
  presetPosition,
  type WorkspacePreset
} from '../lib/workspace-presets';
import { ROLE_META } from '../lib/team-roles';
import { useSettings } from '../lib/settings-context';

type Tab = 'preset' | 'recent';

export function CanvasLayout(): JSX.Element {
  const setViewMode = useUiStore((s) => s.setViewMode);
  const cardCount = useCanvasStore((s) => s.nodes.length);
  const nodes = useCanvasStore((s) => s.nodes);
  const viewport = useCanvasStore((s) => s.viewport);
  const clear = useCanvasStore((s) => s.clear);
  const addCards = useCanvasStore((s) => s.addCards);
  const { settings, update: updateSettings, reset: resetSettings } = useSettings();
  // プロジェクトルート: runtime の lastOpenedRoot を優先。ユーザー設定の
  // claudeCwd (明示指定された作業ディレクトリ) は互換フォールバックとして扱う。
  const projectRoot = settings.lastOpenedRoot || settings.claudeCwd || '';
  const settingsOpen = useUiStore((s) => s.settingsOpen);
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen);
  const [spawnOpen, setSpawnOpen] = useState(false);
  const [addCardOpen, setAddCardOpen] = useState(false);
  const [tab, setTab] = useState<Tab>('preset');
  const [recent, setRecent] = useState<TeamHistoryEntry[]>([]);
  const [teamModalOpen, setTeamModalOpen] = useState(false);

  // Recent ロード
  const loadRecent = async (): Promise<void> => {
    if (!projectRoot) return;
    try {
      const list = await window.api.teamHistory.list(projectRoot);
      setRecent(list);
    } catch (err) {
      console.warn('[recent] load failed:', err);
    }
  };
  useEffect(() => {
    void loadRecent();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectRoot]);

  // Phase 5: Canvas state が変わったら、active な team について team-history へ自動保存
  useEffect(() => {
    if (nodes.length === 0) return;
    // 同 teamId で agentId を持つ node 群を集約
    const byTeam = new Map<string, { name: string; entries: typeof nodes }>();
    for (const n of nodes) {
      const payload = (n.data?.payload ?? {}) as { teamId?: string; agentId?: string; role?: string };
      if (!payload.teamId || !payload.agentId) continue;
      const ex = byTeam.get(payload.teamId);
      if (ex) {
        ex.entries.push(n);
      } else {
        byTeam.set(payload.teamId, {
          name: String(n.data?.title ?? 'Team'),
          entries: [n]
        });
      }
    }
    // debounce 800ms
    const handle = window.setTimeout(() => {
      for (const [teamId, info] of byTeam) {
        const members = info.entries.map((n) => {
          const p = n.data?.payload as { role?: string; agent?: string; agentId?: string } | undefined;
          return {
            role: (p?.role ?? 'leader') as TeamRole,
            agent: (p?.agent ?? 'claude') as TerminalAgent,
            sessionId: null
          };
        });
        const canvasNodes = info.entries.map((n) => {
          const p = n.data?.payload as { agentId?: string } | undefined;
          return {
            agentId: p?.agentId ?? n.id,
            x: n.position.x,
            y: n.position.y,
            width: typeof n.style?.width === 'number' ? (n.style.width as number) : undefined,
            height: typeof n.style?.height === 'number' ? (n.style.height as number) : undefined
          };
        });
        const entry: TeamHistoryEntry = {
          id: teamId,
          name: info.entries[0]?.data?.title ? `${info.entries[0].data.title} (${members.length})` : 'Team',
          projectRoot,
          createdAt: new Date().toISOString(),
          lastUsedAt: new Date().toISOString(),
          members,
          canvasState: { nodes: canvasNodes, viewport }
        };
        void window.api.teamHistory.save(entry).catch((err) => {
          console.warn('[recent] save failed:', err);
        });
      }
    }, 800);
    return () => window.clearTimeout(handle);
  }, [nodes, viewport, projectRoot]);

  // ----- カスタムチーム作成 (TeamCreateModal からのコールバック) -----
  const handleCreateCustomTeam = (
    teamName: string,
    leader: { agent: TerminalAgent },
    members: TeamMember[]
  ): void => {
    const teamId = `team-${Date.now().toString(36)}`;
    const cwd = projectRoot;
    // leader を含む全メンバー
    const all: { role: TeamRole; agent: TerminalAgent }[] = [
      { role: 'leader', agent: leader.agent },
      ...members.map((m) => ({ role: m.role, agent: m.agent }))
    ];
    const cards = all.map((m, i) => {
      const agentId = `${m.role}-${i}-${teamId}`;
      const col = i % 3;
      const row = Math.floor(i / 3);
      return {
        type: 'agent' as const,
        title: ROLE_META[m.role].label,
        position: presetPosition(col, row),
        payload: { agent: m.agent, role: m.role, teamId, agentId, cwd }
      };
    });
    addCards(cards);
    void window.api.app
      .setupTeamMcp(
        cwd,
        teamId,
        teamName,
        all.map((m, i) => ({
          agentId: `${m.role}-${i}-${teamId}`,
          role: m.role,
          agent: m.agent
        }))
      )
      .catch((err) => console.warn('[custom-team] setupTeamMcp failed:', err));
    void loadRecent();
  };

  const handleSaveTeamPreset = (preset: TeamPreset): void => {
    const prev = settings.teamPresets ?? [];
    const idx = prev.findIndex((p) => p.id === preset.id);
    if (idx >= 0) {
      const updated = [...prev];
      updated[idx] = preset;
      void updateSettings({ teamPresets: updated });
    } else {
      void updateSettings({ teamPresets: [...prev, preset] });
    }
  };

  const handleDeleteTeamPreset = (id: string): void => {
    const prev = settings.teamPresets ?? [];
    void updateSettings({ teamPresets: prev.filter((p) => p.id !== id) });
  };

  const applyPreset = async (preset: WorkspacePreset): Promise<void> => {
    const teamId = `team-${Date.now().toString(36)}`;
    const cwd = projectRoot;
    const cards = preset.members.map((m, i) => {
      const agentId = `${m.role}-${i}-${teamId}`;
      const meta = ROLE_META[m.role];
      return {
        type: 'agent' as const,
        title: meta.label,
        position: presetPosition(m.col, m.row),
        payload: {
          agent: m.agent,
          role: m.role,
          teamId,
          agentId,
          cwd
        }
      };
    });
    addCards(cards);
    try {
      await window.api.app.setupTeamMcp(
        cwd,
        teamId,
        preset.name,
        preset.members.map((m, i) => ({
          agentId: `${m.role}-${i}-${teamId}`,
          role: m.role,
          agent: m.agent
        }))
      );
    } catch (err) {
      console.warn('[preset] setupTeamMcp failed:', err);
    }
    setSpawnOpen(false);
    void loadRecent();
  };

  const restoreRecent = async (entry: TeamHistoryEntry): Promise<void> => {
    const cwd = projectRoot || entry.projectRoot;
    const cards = entry.members.map((m, i) => {
      const meta = ROLE_META[m.role];
      const agentId = `${m.role}-${i}-${entry.id}`;
      const saved = entry.canvasState?.nodes.find((s) => s.agentId === agentId);
      const pos = saved
        ? { x: saved.x, y: saved.y }
        : presetPosition(i % 3, Math.floor(i / 3));
      return {
        type: 'agent' as const,
        title: meta.label,
        position: pos,
        payload: {
          agent: m.agent,
          role: m.role,
          teamId: entry.id,
          agentId,
          cwd
        }
      };
    });
    addCards(cards);
    try {
      await window.api.app.setupTeamMcp(
        cwd,
        entry.id,
        entry.name,
        entry.members.map((m, i) => ({
          agentId: `${m.role}-${i}-${entry.id}`,
          role: m.role,
          agent: m.agent
        }))
      );
    } catch (err) {
      console.warn('[restore] setupTeamMcp failed:', err);
    }
    setSpawnOpen(false);
  };

  const closeRecent = useMemo(
    () => recent.filter((r) => r.canvasState && r.canvasState.nodes.length > 0).slice(0, 6),
    [recent]
  );

  const cardCounter = (t: CardType): number => nodes.filter((n) => n.type === t).length + 1;

  const addAgent = (agent: 'claude' | 'codex'): void => {
    const cwd = projectRoot;
    const n = cardCounter('agent');
    addCards([
      {
        type: 'agent',
        title: agent === 'codex' ? `Codex #${n}` : `Claude #${n}`,
        position: { x: Date.now() % 600, y: 0 },
        payload: { agent, role: 'leader', cwd }
      }
    ]);
    setAddCardOpen(false);
  };

  const addByType = (type: Exclude<CardType, 'terminal' | 'agent'>): void => {
    const cwd = projectRoot;
    const titles: Record<typeof type, string> = {
      editor: 'Editor',
      diff: 'Diff',
      fileTree: 'Files',
      changes: 'Changes'
    };
    const payload =
      type === 'fileTree' || type === 'changes'
        ? { projectRoot: cwd }
        : { projectRoot: cwd, relPath: '' };
    addCards([{ type, title: titles[type], position: { x: Date.now() % 600, y: 0 }, payload }]);
    setAddCardOpen(false);
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--bg-deep, #0a0a0d)',
        color: 'var(--fg, #e6e6e6)'
      }}
    >
      <header
        style={{
          height: 56,
          display: 'flex',
          alignItems: 'center',
          padding: '0 16px',
          gap: 12,
          background: 'var(--bg-elevated, #16161c)',
          borderBottom: '1px solid var(--border, #2a2a35)',
          zIndex: 5
        }}
      >
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            fontWeight: 600,
            fontSize: 14
          }}
        >
          <MonitorSmartphone size={16} />
          Canvas
        </span>
        <span style={{ fontSize: 12, color: 'var(--fg-muted, #8a8aa3)' }}>
          {cardCount} card{cardCount === 1 ? '' : 's'}
        </span>
        <div style={{ flex: 1 }} />

        <div style={{ position: 'relative' }}>
          <button
            type="button"
            onClick={() => setAddCardOpen((v) => !v)}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '6px 12px',
              background: 'transparent',
              color: 'var(--fg, #e6e6e6)',
              border: '1px solid var(--border, #2a2a35)',
              borderRadius: 6,
              cursor: 'pointer',
              fontSize: 12
            }}
          >
            <Plus size={14} />
            <Bot size={14} />
            AI Agent
          </button>
          {addCardOpen && (
            <div
              style={{
                position: 'absolute',
                right: 0,
                top: 'calc(100% + 8px)',
                width: 220,
                background: 'var(--bg-deep, #0d0d12)',
                border: '1px solid var(--border, #2a2a35)',
                borderRadius: 8,
                boxShadow: '0 12px 32px rgba(0,0,0,0.6)',
                zIndex: 20,
                overflow: 'hidden'
              }}
            >
              <AddItem
                icon={<AgentBadge label="C" color="#5c5cff" />}
                label="Claude Code"
                onClick={() => addAgent('claude')}
              />
              <AddItem
                icon={<AgentBadge label="X" color="#10b981" />}
                label="Codex"
                onClick={() => addAgent('codex')}
              />
              <div style={{ height: 1, background: 'var(--border, #2a2a35)' }} />
              <AddItem icon={<FolderTree size={14} />} label="File Tree" onClick={() => addByType('fileTree')} />
              <AddItem icon={<GitBranch size={14} />} label="Git Changes" onClick={() => addByType('changes')} />
              <AddItem icon={<FilePlus size={14} />} label="Editor (empty)" onClick={() => addByType('editor')} />
            </div>
          )}
        </div>

        <div style={{ position: 'relative' }}>
          <button
            type="button"
            onClick={() => setSpawnOpen((v) => !v)}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '6px 12px',
              background: '#5c5cff',
              color: '#fff',
              border: 0,
              borderRadius: 6,
              cursor: 'pointer',
              fontSize: 12,
              fontWeight: 500
            }}
          >
            <Sparkles size={14} />
            Spawn Team
          </button>
          {spawnOpen && (
            <div
              style={{
                position: 'absolute',
                right: 0,
                top: 'calc(100% + 8px)',
                width: 360,
                background: 'var(--bg-deep, #0d0d12)',
                border: '1px solid var(--border, #2a2a35)',
                borderRadius: 8,
                boxShadow: '0 12px 32px rgba(0,0,0,0.6)',
                zIndex: 20,
                overflow: 'hidden'
              }}
            >
              <div
                style={{
                  display: 'flex',
                  borderBottom: '1px solid var(--border, #2a2a35)'
                }}
              >
                <TabBtn active={tab === 'preset'} onClick={() => setTab('preset')}>
                  <Sparkles size={12} /> Preset
                </TabBtn>
                <TabBtn active={tab === 'recent'} onClick={() => setTab('recent')}>
                  <History size={12} /> Recent
                  {closeRecent.length > 0 && (
                    <span
                      style={{
                        marginLeft: 4,
                        fontSize: 9,
                        color: 'var(--fg-muted, #8a8aa3)'
                      }}
                    >
                      {closeRecent.length}
                    </span>
                  )}
                </TabBtn>
              </div>
              {tab === 'preset' && (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      setSpawnOpen(false);
                      setTeamModalOpen(true);
                    }}
                    style={{
                      width: '100%',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '12px 14px',
                      background: 'rgba(92,92,255,0.10)',
                      color: 'var(--fg, #e6e6e6)',
                      border: 0,
                      borderBottom: '1px solid var(--border, #2a2a35)',
                      cursor: 'pointer',
                      textAlign: 'left',
                      fontSize: 13,
                      fontWeight: 600
                    }}
                    onMouseEnter={(e) =>
                      ((e.currentTarget as HTMLElement).style.background = 'rgba(92,92,255,0.18)')
                    }
                    onMouseLeave={(e) =>
                      ((e.currentTarget as HTMLElement).style.background = 'rgba(92,92,255,0.10)')
                    }
                  >
                    <Plus size={14} />
                    カスタムチームを作成…
                  </button>
                  {BUILTIN_PRESETS.map((p) => (
                    <PresetItem key={p.id} preset={p} onClick={() => void applyPreset(p)} />
                  ))}
                  {(settings.teamPresets ?? []).length > 0 && (
                    <div
                      style={{
                        padding: '6px 14px',
                        fontSize: 10,
                        color: 'var(--fg-muted, #8a8aa3)',
                        textTransform: 'uppercase',
                        letterSpacing: 0.5,
                        background: 'rgba(255,255,255,0.02)'
                      }}
                    >
                      保存済みプリセット
                    </div>
                  )}
                  {(settings.teamPresets ?? []).map((sp) => (
                    <SavedPresetItem
                      key={sp.id}
                      preset={sp}
                      onClick={() => {
                        const leaderM = sp.members.find((m) => m.role === 'leader');
                        const others = sp.members.filter((m) => m.role !== 'leader');
                        handleCreateCustomTeam(
                          sp.name,
                          { agent: leaderM?.agent ?? 'claude' },
                          others
                        );
                        setSpawnOpen(false);
                      }}
                      onDelete={() => handleDeleteTeamPreset(sp.id)}
                    />
                  ))}
                </>
              )}
              {tab === 'recent' && (
                <>
                  {closeRecent.length === 0 && (
                    <div
                      style={{
                        padding: 16,
                        fontSize: 12,
                        color: 'var(--fg-muted, #8a8aa3)'
                      }}
                    >
                      まだ保存されたチームがありません。Preset から起動してください。
                    </div>
                  )}
                  {closeRecent.map((entry) => (
                    <RecentItem
                      key={entry.id}
                      entry={entry}
                      onClick={() => void restoreRecent(entry)}
                    />
                  ))}
                </>
              )}
            </div>
          )}
        </div>

        {cardCount > 0 && (
          <button
            type="button"
            onClick={() => {
              if (window.confirm('Canvas 上のカードを全て削除しますか?')) clear();
            }}
            style={{
              padding: '6px 10px',
              background: 'transparent',
              color: 'var(--fg-muted, #a8a8b8)',
              border: '1px solid var(--border, #2a2a35)',
              borderRadius: 6,
              cursor: 'pointer',
              fontSize: 12
            }}
          >
            Clear
          </button>
        )}
        <button
          type="button"
          onClick={() => setViewMode('ide')}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '6px 12px',
            background: 'var(--bg-deep, #0d0d12)',
            color: 'var(--fg, #e6e6e6)',
            border: '1px solid var(--border, #2a2a35)',
            borderRadius: 6,
            cursor: 'pointer',
            fontSize: 12
          }}
          title="Switch to IDE mode"
        >
          <Layout size={14} />
          IDE
        </button>
      </header>
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        <CanvasSidebar />
        <div style={{ flex: 1, position: 'relative', minWidth: 0 }}>
          <Canvas />
        </div>
      </div>

      <SettingsModal
        open={settingsOpen}
        initial={settings}
        onClose={() => setSettingsOpen(false)}
        onApply={(next) => {
          void updateSettings(next);
        }}
        onReset={() => {
          void resetSettings();
        }}
      />

      <TeamCreateModal
        open={teamModalOpen}
        onClose={() => setTeamModalOpen(false)}
        onCreate={handleCreateCustomTeam}
        savedPresets={settings.teamPresets ?? []}
        onSavePreset={handleSaveTeamPreset}
        onDeletePreset={handleDeleteTeamPreset}
        maxTerminals={20}
        currentTabCount={nodes.filter((n) => n.type === 'agent').length}
        existingTeams={[] as Team[]}
      />
    </div>
  );
}

function SavedPresetItem({
  preset,
  onClick,
  onDelete
}: {
  preset: TeamPreset;
  onClick: () => void;
  onDelete: () => void;
}): JSX.Element {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        borderBottom: '1px solid var(--border, #2a2a35)'
      }}
    >
      <button
        type="button"
        onClick={onClick}
        style={{
          flex: 1,
          padding: '10px 14px',
          background: 'transparent',
          color: 'var(--fg, #e6e6e6)',
          border: 0,
          textAlign: 'left',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: 8
        }}
        onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.background = 'rgba(92,92,255,0.08)')}
        onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.background = 'transparent')}
      >
        <Users size={14} />
        <span style={{ fontSize: 13, fontWeight: 600 }}>{preset.name}</span>
        <span style={{ fontSize: 10, color: 'var(--fg-muted, #8a8aa3)' }}>
          {preset.members.length} agents
        </span>
        <span style={{ display: 'flex', gap: 4, marginLeft: 'auto' }}>
          {preset.members.map((m, i) => (
            <span
              key={i}
              title={`${ROLE_META[m.role].label} (${m.agent})`}
              style={{
                width: 14,
                height: 14,
                borderRadius: '50%',
                background: ROLE_META[m.role].color,
                color: '#0a0a0d',
                fontSize: 9,
                fontWeight: 700,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center'
              }}
            >
              {ROLE_META[m.role].glyph}
            </span>
          ))}
        </span>
      </button>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          if (window.confirm(`プリセット「${preset.name}」を削除しますか?`)) onDelete();
        }}
        title="削除"
        style={{
          padding: '0 12px',
          height: '100%',
          background: 'transparent',
          color: 'var(--fg-muted, #8a8aa3)',
          border: 0,
          cursor: 'pointer'
        }}
      >
        ×
      </button>
    </div>
  );
}

function AgentBadge({ label, color }: { label: string; color: string }): JSX.Element {
  return (
    <span
      aria-hidden="true"
      style={{
        width: 18,
        height: 18,
        borderRadius: 4,
        background: color,
        color: '#0a0a0d',
        fontSize: 11,
        fontWeight: 700,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center'
      }}
    >
      {label}
    </span>
  );
}

function AddItem({
  icon,
  label,
  onClick
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        width: '100%',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '10px 12px',
        background: 'transparent',
        color: 'var(--fg, #e6e6e6)',
        border: 0,
        borderBottom: '1px solid var(--border, #2a2a35)',
        cursor: 'pointer',
        fontSize: 12,
        textAlign: 'left'
      }}
      onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.background = 'rgba(92,92,255,0.08)')}
      onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.background = 'transparent')}
    >
      {icon}
      {label}
    </button>
  );
}

function TabBtn({
  active,
  onClick,
  children
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        flex: 1,
        padding: '8px 12px',
        background: active ? 'rgba(92,92,255,0.12)' : 'transparent',
        color: active ? 'var(--fg, #e6e6e6)' : 'var(--fg-muted, #8a8aa3)',
        border: 0,
        borderBottom: active ? '2px solid #5c5cff' : '2px solid transparent',
        cursor: 'pointer',
        fontSize: 12,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 4
      }}
    >
      {children}
    </button>
  );
}

function PresetItem({
  preset,
  onClick
}: {
  preset: WorkspacePreset;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        width: '100%',
        padding: '12px 14px',
        background: 'transparent',
        color: 'var(--fg, #e6e6e6)',
        border: 0,
        borderBottom: '1px solid var(--border, #2a2a35)',
        textAlign: 'left',
        cursor: 'pointer',
        display: 'flex',
        flexDirection: 'column',
        gap: 4
      }}
      onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.background = 'rgba(92,92,255,0.08)')}
      onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.background = 'transparent')}
    >
      <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Users size={14} />
        <span style={{ fontSize: 13, fontWeight: 600 }}>{preset.name}</span>
        <span style={{ fontSize: 10, color: 'var(--fg-muted, #8a8aa3)' }}>
          {preset.members.length} agents
        </span>
      </span>
      <span style={{ fontSize: 11, color: 'var(--fg-muted, #a8a8b8)' }}>{preset.description}</span>
      <span style={{ display: 'flex', gap: 4, marginTop: 2 }}>
        {preset.members.map((m, i) => (
          <span
            key={i}
            title={`${ROLE_META[m.role].label} (${m.agent})`}
            style={{
              width: 14,
              height: 14,
              borderRadius: '50%',
              background: ROLE_META[m.role].color,
              color: '#0a0a0d',
              fontSize: 9,
              fontWeight: 700,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}
          >
            {ROLE_META[m.role].glyph}
          </span>
        ))}
      </span>
    </button>
  );
}

function RecentItem({
  entry,
  onClick
}: {
  entry: TeamHistoryEntry;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        width: '100%',
        padding: '10px 14px',
        background: 'transparent',
        color: 'var(--fg, #e6e6e6)',
        border: 0,
        borderBottom: '1px solid var(--border, #2a2a35)',
        textAlign: 'left',
        cursor: 'pointer',
        display: 'flex',
        flexDirection: 'column',
        gap: 4
      }}
      onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.background = 'rgba(92,92,255,0.08)')}
      onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.background = 'transparent')}
    >
      <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 600 }}>{entry.name || 'Team'}</span>
        <span style={{ fontSize: 10, color: 'var(--fg-muted, #8a8aa3)' }}>
          {entry.members.length} agents
        </span>
      </span>
      <span style={{ fontSize: 10, color: 'var(--fg-muted, #8a8aa3)' }}>
        last used {new Date(entry.lastUsedAt).toLocaleString()}
      </span>
      <span style={{ display: 'flex', gap: 4, marginTop: 2 }}>
        {entry.members.map((m, i) => (
          <span
            key={i}
            title={`${ROLE_META[m.role].label} (${m.agent})`}
            style={{
              width: 14,
              height: 14,
              borderRadius: '50%',
              background: ROLE_META[m.role].color,
              color: '#0a0a0d',
              fontSize: 9,
              fontWeight: 700,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}
          >
            {ROLE_META[m.role].glyph}
          </span>
        ))}
      </span>
    </button>
  );
}
