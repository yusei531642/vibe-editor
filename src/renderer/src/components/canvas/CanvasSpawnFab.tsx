import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, History, Sparkles } from 'lucide-react';
import type {
  AgentConfig,
  TeamHistoryEntry,
  TeamPreset
} from '../../../../types/shared';
import {
  BuiltinPresetItem,
  CustomAgentLeaderPresetItem,
  RecentItem,
  SavedPresetItem,
  TabBtn
} from './CanvasSpawnItems';
import {
  BUILTIN_PRESETS,
  DEFAULT_SPAWN_PRESET,
  presetMemberCount,
  presetOrganizationCount,
  type WorkspacePreset
} from '../../lib/workspace-presets';
import { useSettings } from '../../lib/settings-context';
import { useT } from '../../lib/i18n';
import {
  localeOf,
  formatOrganizationAgentCount
} from '../../lib/canvas-layout-helpers';

interface CanvasSpawnFabProps {
  /** canvasState 付きの直近チーム (use-canvas-spawn の closeRecent) */
  closeRecent: TeamHistoryEntry[];
  applyPreset: (preset: WorkspacePreset) => Promise<void>;
  applySavedPreset: (preset: TeamPreset) => Promise<void>;
  applyCustomAgentLeaderPreset: (agent: AgentConfig) => Promise<void>;
  restoreRecent: (entry: TeamHistoryEntry) => Promise<void>;
}

/**
 * Canvas 右上に固定で配置するチーム起動 FAB。split button: 本体クリックで
 * 既定プリセットを 1-click 起動、caret でプリセット/最近使ったチームの
 * popover を開く。canvas-header 撤廃 (#709) で消えていたのを復活。
 *
 * Issue #1032: CanvasLayout の god-file 分割で切り出し。ポップオーバーの
 * 開閉 / タブ / 保存済みプリセットの取得はこのコンポーネントが所有し、
 * チーム起動の実体 (spawnTeam 経路) は use-canvas-spawn 側の callback に委譲する。
 */
export function CanvasSpawnFab({
  closeRecent,
  applyPreset,
  applySavedPreset,
  applyCustomAgentLeaderPreset,
  restoreRecent
}: CanvasSpawnFabProps): JSX.Element {
  const { settings } = useSettings();
  const t = useT();
  const [spawnOpen, setSpawnOpen] = useState(false);
  const [tab, setTab] = useState<'preset' | 'recent'>('preset');
  // Issue #1023: 🔖 (TeamPresetsPanel) で保存したカスタムプリセットを spawn ポップオーバーの
  // [プリセット] タブにも併記する。保存系 (TeamPresetsPanel) とは別ポップオーバーなので、
  // popover を開くたびに list を取り直して新規保存を即反映する。
  const [savedPresets, setSavedPresets] = useState<TeamPreset[]>([]);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Issue #1025: 設定で作成した custom agent を「チーム起動」プリセットに自動追加する。
  // settings.customAgents を購読しているので、追加/削除でプリセットも即出入りする。
  const customAgents = settings.customAgents ?? [];

  const dateTimeFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(localeOf(settings.language), {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      }),
    [settings.language]
  );

  useEffect(() => {
    if (!spawnOpen) return;
    const handlePointerDown = (event: MouseEvent): void => {
      const target = event.target as globalThis.Node | null;
      if (popoverRef.current && target && !popoverRef.current.contains(target)) {
        setSpawnOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setSpawnOpen(false);
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [spawnOpen]);

  // Issue #1023: spawn ポップオーバーを開くたびに保存済みプリセットを取り直す。
  // 🔖 側で保存した直後に ▼ を開いても最新が出るよう、open 遷移を依存に入れる。
  useEffect(() => {
    if (!spawnOpen) return;
    let cancelled = false;
    void window.api.teamPresets
      .list()
      .then((list) => {
        if (!cancelled) setSavedPresets(list);
      })
      .catch((err) => {
        console.warn('[team-presets] list failed:', err);
      });
    return () => {
      cancelled = true;
    };
  }, [spawnOpen]);

  // 起動系 callback は完了後に popover を閉じる (失敗時は開いたままにして再試行可能に保つ)。
  const runThenClose = (task: Promise<void>): void => {
    void task.then(() => setSpawnOpen(false));
  };

  return (
    <div className="canvas-spawn-fab" ref={popoverRef}>
      <div className="canvas-btn-split">
        <button
          type="button"
          className="canvas-btn canvas-btn--primary canvas-btn-split__main"
          onClick={() => void applyPreset(DEFAULT_SPAWN_PRESET)}
          aria-label={t('canvas.spawnTeam.tooltip')}
          title={t('canvas.spawnTeam.tooltip')}
        >
          <Sparkles size={13} strokeWidth={1.8} />
          {t('canvas.spawnTeam')}
        </button>
        <button
          type="button"
          className="canvas-btn canvas-btn--primary canvas-btn-split__caret"
          onClick={() => setSpawnOpen((v) => !v)}
          aria-label={t('canvas.spawnTeamMore.tooltip')}
          title={t('canvas.spawnTeamMore.tooltip')}
          aria-expanded={spawnOpen}
        >
          <ChevronDown size={12} strokeWidth={2} />
        </button>
      </div>
      {spawnOpen && (
        <div className="canvas-popover canvas-popover--wide">
          <div className="canvas-popover__tabs">
            <TabBtn active={tab === 'preset'} onClick={() => setTab('preset')}>
              <Sparkles size={11} /> {t('canvas.preset')}
            </TabBtn>
            <TabBtn active={tab === 'recent'} onClick={() => setTab('recent')}>
              <History size={11} /> {t('canvas.recent')}
              {closeRecent.length > 0 && (
                <span className="canvas-popover__tab-badge">{closeRecent.length}</span>
              )}
            </TabBtn>
          </div>
          {tab === 'preset' && (
            <>
              {savedPresets.length > 0 && (
                <div className="canvas-popover__section">
                  {t('canvas.preset.builtinHeader')}
                </div>
              )}
              {BUILTIN_PRESETS.map((preset) => (
                <BuiltinPresetItem
                  key={preset.id}
                  preset={preset}
                  label={t(preset.i18nKey)}
                  agentCountLabel={formatOrganizationAgentCount(
                    presetOrganizationCount(preset),
                    presetMemberCount(preset),
                    settings.language
                  )}
                  onClick={() => runThenClose(applyPreset(preset))}
                />
              ))}
              {/* Issue #1025: custom agent ごとに「Leader のみで起動 (agent名)」を自動追加 */}
              {customAgents.map((agent) => (
                <CustomAgentLeaderPresetItem
                  key={agent.id}
                  label={t('canvas.preset.leaderCustom', {
                    name: agent.name || agent.id
                  })}
                  agentCountLabel={formatOrganizationAgentCount(
                    0,
                    1,
                    settings.language
                  )}
                  color={agent.color ?? '#d97757'}
                  onClick={() => runThenClose(applyCustomAgentLeaderPreset(agent))}
                />
              ))}
              {savedPresets.length > 0 && (
                <>
                  <div className="canvas-popover__section">
                    {t('canvas.preset.savedHeader')}
                  </div>
                  {savedPresets.map((preset) => (
                    <SavedPresetItem
                      key={preset.id}
                      preset={preset}
                      agentCountLabel={formatOrganizationAgentCount(
                        0,
                        preset.roles.length,
                        settings.language
                      )}
                      onClick={() => runThenClose(applySavedPreset(preset))}
                    />
                  ))}
                </>
              )}
            </>
          )}
          {tab === 'recent' && (
            <>
              {closeRecent.length === 0 && (
                <div className="canvas-popover__empty">{t('canvas.noRecentTeams')}</div>
              )}
              {closeRecent.map((entry) => (
                <RecentItem
                  key={entry.id}
                  entry={entry}
                  fallbackName={entry.name || entry.id.slice(0, 8)}
                  agentCountLabel={formatOrganizationAgentCount(
                    entry.organization ? 1 : 0,
                    entry.members.length,
                    settings.language
                  )}
                  lastUsedLabel={dateTimeFormatter.format(new Date(entry.lastUsedAt))}
                  onClick={() => runThenClose(restoreRecent(entry))}
                />
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
