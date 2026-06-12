import type { CSSProperties, ReactNode } from 'react';
import type {
  TeamHistoryEntry,
  TeamRole,
  TerminalAgent
} from '../../../../types/shared';
import type { WorkspacePreset } from '../../lib/workspace-presets';
import { ROLE_META, roleMetaFor } from '../../lib/team-roles';

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
      style={{ ['--dot-color' as string]: meta.color } as CSSProperties}
    >
      {meta.glyph}
    </span>
  );
}

export function BuiltinPresetItem({
  preset,
  label,
  agentCountLabel,
  onClick
}: {
  preset: WorkspacePreset;
  label: string;
  agentCountLabel: string;
  onClick: () => void;
}): JSX.Element {
  return (
    <button type="button" onClick={onClick} className="canvas-popover__preset">
      <span className="canvas-popover__preset-title-row">
        <span className="canvas-popover__preset-title">{label}</span>
        <span className="canvas-popover__preset-sub">{agentCountLabel}</span>
      </span>
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

export function AgentBadge({ label, color }: { label: string; color: string }): JSX.Element {
  return (
    <span
      aria-hidden="true"
      className="canvas-role-dot"
      style={
        {
          ['--dot-color' as string]: color,
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
