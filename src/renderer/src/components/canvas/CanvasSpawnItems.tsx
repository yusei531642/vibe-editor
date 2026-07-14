import type { CSSProperties, ReactNode } from 'react';
import type {
  TeamHistoryEntry,
  TeamPreset,
  TeamRole,
  TerminalAgent
} from '../../../../types/shared';
import type { WorkspacePreset } from '../../lib/workspace-presets';
import { ROLE_META, roleMetaFor } from '../../lib/team-roles';
import { readableForegroundForHex } from '../../lib/color-contrast';

function RoleDot({
  role,
  agent
}: {
  role: TeamRole;
  agent: TerminalAgent;
}): JSX.Element {
  const meta = ROLE_META[role] ?? roleMetaFor(role, 'en');
  return (
    <span
      className="canvas-role-dot"
      title={`${meta.label} (${agent})`}
      style={
        {
          ['--dot-color' as string]: meta.color,
          ['--dot-foreground' as string]: readableForegroundForHex(meta.color)
        } as CSSProperties
      }
    >
      {meta.glyph}
    </span>
  );
}

export function BuiltinPresetItem({
  preset,
  label,
  description,
  agentCountLabel,
  onClick
}: {
  preset: WorkspacePreset;
  label: string;
  description: string;
  agentCountLabel: string;
  onClick: () => void;
}): JSX.Element {
  return (
    <button type="button" onClick={onClick} className="canvas-popover__preset">
      <span className="canvas-popover__preset-title-row">
        <span className="canvas-popover__preset-title">{label}</span>
        <span className="canvas-popover__preset-sub">{agentCountLabel}</span>
      </span>
      <span className="canvas-popover__preset-desc">{description}</span>
      <span className="canvas-popover__preset-roles">
        {(preset.organizations ?? [{ id: 'primary', color: '', members: preset.members }]).map(
          (org, orgIndex) => (
            <span
              key={org.id}
              className="canvas-popover__preset-org"
              style={
                org.color
                  ? ({ ['--org-color' as string]: org.color } as CSSProperties)
                  : undefined
              }
            >
              {org.members.map((m, i) => (
                <RoleDot key={`${orgIndex}-${i}`} role={m.role} agent={m.agent} />
              ))}
            </span>
          )
        )}
      </span>
    </button>
  );
}

/**
 * Issue #1023: 🔖 (TeamPresetsPanel) で保存したカスタムプリセットを、
 * 「チーム起動」スプリットボタンの [プリセット] タブにも併記するための item。
 * 組み込みプリセット (BuiltinPresetItem) と見た目を揃えつつ、TeamPreset の
 * roles[].roleProfileId / agent から RoleDot を描画する。
 */
export function SavedPresetItem({
  preset,
  agentCountLabel,
  onClick
}: {
  preset: TeamPreset;
  agentCountLabel: string;
  onClick: () => void;
}): JSX.Element {
  return (
    <button type="button" onClick={onClick} className="canvas-popover__preset">
      <span className="canvas-popover__preset-title-row">
        <span className="canvas-popover__preset-title">{preset.name}</span>
        <span className="canvas-popover__preset-sub">{agentCountLabel}</span>
      </span>
      {preset.description ? (
        <span className="canvas-popover__preset-desc">{preset.description}</span>
      ) : null}
      <span className="canvas-popover__preset-roles">
        {preset.roles.map((role, i) => (
          <RoleDot key={`${role.roleProfileId}-${i}`} role={role.roleProfileId} agent={role.agent} />
        ))}
      </span>
    </button>
  );
}

/**
 * Issue #1025: 設定で作成した custom agent を「チーム起動」プリセットに自動追加する item。
 * 表示は組み込みの「Leader のみで起動 (...)」に倣い、leader バッジ + agent 色で描画する。
 * 起動の中身 (API/CLI 分岐 + leader ロール) は CanvasLayout 側のハンドラが担当する。
 */
export function CustomAgentLeaderPresetItem({
  label,
  agentCountLabel,
  color,
  onClick
}: {
  label: string;
  agentCountLabel: string;
  color: string;
  onClick: () => void;
}): JSX.Element {
  return (
    <button type="button" onClick={onClick} className="canvas-popover__preset">
      <span className="canvas-popover__preset-title-row">
        <span className="canvas-popover__preset-title">{label}</span>
        <span className="canvas-popover__preset-sub">{agentCountLabel}</span>
      </span>
      <span className="canvas-popover__preset-roles">
        <AgentBadge label="L" color={color} />
      </span>
    </button>
  );
}

export function AgentBadge({ label, color }: { label: string; color: string }): JSX.Element {
  return (
    <span
      aria-hidden="true"
      className="canvas-role-dot"
      style={
        {
          ['--dot-color' as string]: color,
          ['--dot-foreground' as string]: readableForegroundForHex(color),
          width: 18,
          height: 18,
          borderRadius: 4,
          fontSize: 10
        } as CSSProperties
      }
    >
      {label}
    </span>
  );
}

export function TabBtn({
  active,
  onClick,
  children
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`canvas-popover__tab${active ? ' canvas-popover__tab--active' : ''}`}
      aria-pressed={active}
    >
      {children}
    </button>
  );
}

export function AddItem({
  icon,
  label,
  onClick
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
}): JSX.Element {
  return (
    <button type="button" onClick={onClick} className="canvas-popover__item">
      {icon}
      {label}
    </button>
  );
}

export function RecentItem({
  entry,
  fallbackName,
  agentCountLabel,
  lastUsedLabel,
  onClick
}: {
  entry: TeamHistoryEntry;
  fallbackName: string;
  agentCountLabel: string;
  lastUsedLabel: string;
  onClick: () => void;
}): JSX.Element {
  const orchestration = entry.orchestration;
  const stateLabel = orchestration?.blockedByHumanGate
    ? `blocked_by_human_gate: ${
        orchestration.requiredHumanDecision ?? orchestration.blockedReason ?? ''
      }`
    : orchestration?.latestHandoffStatus
      ? `handoff: ${orchestration.latestHandoffStatus}`
      : '';
  return (
    <button type="button" onClick={onClick} className="canvas-popover__preset">
      <span className="canvas-popover__preset-title-row">
        <span className="canvas-popover__preset-title">{entry.name || fallbackName}</span>
        <span className="canvas-popover__preset-sub">{agentCountLabel}</span>
      </span>
      <span className="canvas-popover__preset-sub">{lastUsedLabel}</span>
      {entry.organization && (
        <span
          className="canvas-popover__org-badge"
          style={{ ['--org-color' as string]: entry.organization.color } as CSSProperties}
        >
          {entry.organization.name}
        </span>
      )}
      {stateLabel && (
        <span
          className={`canvas-popover__preset-state ${
            orchestration?.blockedByHumanGate ? 'is-blocked' : ''
          }`}
        >
          {stateLabel}
        </span>
      )}
      <span className="canvas-popover__preset-roles">
        {entry.members.map((m, i) => (
          <RoleDot key={i} role={m.role} agent={m.agent} />
        ))}
      </span>
    </button>
  );
}
