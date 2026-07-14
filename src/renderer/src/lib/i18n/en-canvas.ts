import type { Dict } from './types';

/**
 * English辞書 — Canvas / チーム / エージェント関連。
 * Issue #1032: i18n.ts の god-file 分割で領域別サブ辞書に分離。
 * 追加キーは領域の合うファイルへ。merge は index.ts 側で行う。
 */
export const enCanvas: Dict = {
  // ---------- Canvas HUD ----------
  'canvas.apiAgent.teamRole': 'Team role',
  'canvas.apiAgent.teamRolePlaceholder': 'e.g. reviewer',
  'canvas.apiChat.placeholder': 'Type an instruction (/ for commands, @ to pick an agent)',
  'canvas.apiChat.typing': '{name} is typing…',
  'canvas.apiChat.ready': 'Ready. Enter your instruction.',
  'canvas.apiChat.loadingPrompt': 'Loading system prompt…',
  'canvas.apiChat.configure': 'Configure this API agent in Settings.',
  'canvas.apiChat.mention': 'Mention an agent (@)',
  'canvas.apiChat.attach': 'Attach file (coming soon)',
  'canvas.apiChat.send': 'Send',
  'canvas.apiChat.stop': 'Stop',
  'canvas.apiChat.cmd.planDesc': 'Make a plan',
  'canvas.apiChat.cmd.statusDesc': 'Check status',
  'canvas.apiChat.cmd.contextDesc': 'Show context',
  'canvas.apiChat.cmd.clearDesc': 'Clear history',
  'canvas.hud.stage': 'Stage',
  'canvas.hud.list': 'List',
  'canvas.hud.focus': 'Focus',
  'canvas.hud.fit': 'Fit',
  'canvas.hud.zoomIn': 'Zoom in',
  'canvas.hud.zoomOut': 'Zoom out',
  'canvas.hud.arrange.open': 'Arrange',
  // Issue #368: hover tooltips (Label — purpose)
  'canvas.hud.stage.tooltip': 'Stage — Switch to a radial layout of agents',
  'canvas.hud.list.tooltip': 'List — Show agents stacked vertically',
  'canvas.hud.focus.tooltip': 'Focus — Highlight only the selected agent',
  'canvas.hud.fit.tooltip': 'Fit — Auto-zoom so every card on the canvas fits the viewport',
  'canvas.hud.zoomIn.tooltip': 'Zoom in — Enlarge the canvas',
  'canvas.hud.zoomOut.tooltip': 'Zoom out — Shrink the canvas',
  'canvas.hud.arrange.open.tooltip': 'Arrange — Tidy cards, unify size, and adjust spacing',
  'canvas.hud.arrange.tidy': 'Tidy up',
  'canvas.hud.arrange.unifySize': 'Unify size',
  'canvas.hud.arrange.gap.label': 'Gap',
  'canvas.hud.arrange.gap.tight': 'Tight',
  'canvas.hud.arrange.gap.normal': 'Normal',
  'canvas.hud.arrange.gap.wide': 'Wide',


  // ---------- Team history ----------
  'teamHistory.resume': 'Resume team "{name}"',
  'teamHistory.resumed': 'Resumed team "{name}"',
  'teamHistory.alreadyOpen': 'Team "{name}" is already open on the Canvas',
  'teamHistory.delete': 'Remove from history',


  // ---------- Team ----------
  'team.closeTeamConfirm': 'This is the team leader. Close entire team?',
  'team.closeTeam': 'Close Team',
  'team.closeLeaderOnly': 'Close Leader Only',


  // ---------- Canvas ----------
  'canvas.spawnTeam': 'Spawn Team',
  'canvas.spawnTeam.tooltip': 'Spawn Team — Launch leader and members in one click using the default preset',
  'canvas.spawnTeamMore': 'More team options…',
  'canvas.spawnTeamMore.tooltip': 'Pick a preset — Choose another built-in preset or a recently used team',
  'canvas.preset': 'Preset',
  'canvas.preset.leaderClaude': 'Leader only (Claude Code)',
  'canvas.preset.leaderCodex': 'Leader only (Codex)',
  'canvas.preset.leaderClaude.description':
    'Starts with only a Claude Code leader. The leader recruits members as needed.',
  'canvas.preset.leaderCodex.description':
    'Starts with only a Codex leader. The leader recruits members as needed.',
  'canvas.preset.builtinHeader': 'Built-in',
  'canvas.preset.savedHeader': 'Saved',
  'canvas.preset.leaderCustom': 'Leader only ({name})',
  'canvas.recent': 'Recent',
  'canvas.noRecentTeams': 'No recent teams. Start one from a preset.',
  'canvas.clear': 'Clear',
  'canvas.clear.tooltip': 'Clear — Remove every card from the canvas',
  'canvas.clearConfirm': 'Clear every card on the canvas?',
  // Issue #595: Shown when Clear is invoked while one or more EditorCards have unsaved edits.
  'canvas.clearConfirmWithDirtyEditors':
    'Clearing the canvas will discard {count} unsaved edit(s). Continue?\n\n{paths}',
  'canvas.switchToIde': 'Switch to IDE mode',
  'canvas.switchToIde.tooltip': 'IDE — Return to the editor + terminal IDE mode',
  'canvas.modeToggle': 'Switch to Canvas mode',
  'canvas.card.editor': 'Editor',
  'canvas.list.title': 'Team',
  'canvas.list.empty': 'No agents have been placed yet',


  // ---------- Agent Card ----------
  'agentCard.close': 'Close card',
  'agentCard.confirmCloseTeam':
    'Closing this card will also close all {count} members of team "{name}" (including the Leader). Continue?',
  'handoff.create': 'Hand off',
  'handoff.createTooltip':
    'Save a handoff document and ask the leader to recruit a successor and switch over via MCP',
  'handoff.created': 'Handoff saved ({file}); MCP instructions sent to the leader PTY',
  'handoff.action.reveal': 'Reveal saved file',
  'handoff.error.noProject':
    'Project root is not set. Open a folder from the sidebar, then try again.',
  'handoff.error.createFailed': 'Failed to create handoff: {detail}',
  'handoff.error.notLeader': 'Handoff can only be initiated from a Leader card',
  'handoff.error.injectFailed': 'Failed to inject the MCP instructions into the leader PTY: {detail}',
  // Issue #511: PTY inject failure warning + manual retry
  'injectFailure.title': 'Delivery failed ({code}): {message}',
  'injectFailure.retry': 'Retry',
  'injectFailure.retryBusy': 'Retrying…',
  'injectFailure.retrySuccess': 'Message re-delivered successfully',
  'injectFailure.retryFailed': 'Retry failed ({reason})',
  'injectFailure.retryError': 'Error during retry: {detail}',
  'injectFailure.dismiss': 'Dismiss',
  // Issue #509: delivered-but-not-read message indicator
  'inboxUnread.label': '{count} unread ({ageSec}s elapsed)',
  'inboxUnread.tooltip':
    'This agent has {count} delivered message(s) that have not been confirmed via team_read for {ageSec} seconds. Consider nudging if it exceeds 60s.',
  'agentStatus.idle': 'Idle',
  'agentStatus.thinking': 'Thinking',
  'agentStatus.typing': 'Typing',

  // Issue #521: Agent card 3-line summary
  'agentCard.summary.region': 'Agent status summary',
  'agentCard.summary.noTask': 'No task assigned',
  'agentCard.summary.needsLeader': 'Awaiting leader input',
  'agentCard.summary.ago.unobserved': 'No output observed yet',
  'agentCard.summary.ago.now': 'Output just now',
  'agentCard.summary.ago.sec': 'Last output {value}s ago',
  'agentCard.summary.ago.min': 'Last output {value}m ago',
  'agentCard.summary.ago.hour': 'Last output {value}h ago',
  'agentCard.summary.ago.day': 'Last output {value}d ago',

  // Issue #510: Agent card health badge (sourced from TeamHub diagnostics)
  'agentCard.summary.health.state.alive': 'Alive',
  'agentCard.summary.health.state.stale': 'Stale',
  'agentCard.summary.health.state.dead': 'Unresponsive',
  'agentCard.summary.health.state.unknown': 'Unknown',
  'agentCard.summary.health.silent.sec': '{state} (silent for {value}s)',
  'agentCard.summary.health.silent.min': '{state} (silent for {value}m)',
  'agentCard.summary.health.tooltip': 'Health: {state} · last self-status: {status}',
  'agentCard.summary.health.noStatus': 'no self-reported status',

  // Issue #521: Canvas-wide summary HUD
  'canvas.hud.summary.label': 'Canvas team summary',
  'canvas.hud.summary.active': 'Active',
  'canvas.hud.summary.active.tooltip': 'Active — agents with recent output',
  'canvas.hud.summary.blocked': 'Awaiting leader',
  'canvas.hud.summary.blocked.tooltip':
    'Awaiting leader — agents waiting for leader input or handoff ack',
  'canvas.hud.summary.stale': 'Stale',
  'canvas.hud.summary.stale.tooltip': 'Stale — agents with no output for 5+ minutes',
  'canvas.hud.summary.completed': 'Completed',
  'canvas.hud.summary.completed.tooltip':
    'Completed — agents with acked handoff or retired sessions',
  'canvas.hud.summary.dead': 'Unresponsive',
  'canvas.hud.summary.dead.tooltip':
    'Unresponsive — agents with no PTY output for 15+ minutes (sourced from hub diagnostics)',

  // Issue #522: Team Presets panel
  'preset.title': 'Team Presets',
  'preset.button.tooltip': 'Presets — save and reapply team formations',
  'preset.saveCurrent': 'Save current team',
  'preset.saveCurrent.tooltip': 'Save the agent cards currently on the canvas as a preset',
  'preset.save': 'Save',
  'preset.name': 'Name',
  'preset.namePlaceholder': 'e.g. Plan + Build + Review team',
  'preset.description': 'Description',
  'preset.descriptionPlaceholder': 'Optional notes (what kind of work this team is suited for)',
  'preset.apply': 'Apply',
  'preset.apply.tooltip': 'Spawn this preset onto the canvas',
  'preset.delete': 'Delete',
  'preset.delete.tooltip': 'Delete this preset from disk',
  'preset.empty': 'No saved presets yet',
  'preset.loading': 'Loading…',
  'preset.roleCount': '{count} roles',
  'preset.saved': 'Preset "{name}" saved',
  'preset.applied': 'Added {count} members from "{name}" to the canvas',
  'preset.deleted': 'Preset "{name}" deleted',
  'preset.error.empty': 'No agent cards on the canvas. Build a team first, then save it as a preset.',
  'preset.error.noName': 'Please enter a preset name',
  'preset.error.listFailed': 'Failed to load preset list',
  'preset.error.saveFailed': 'Failed to save preset: {detail}',
  'preset.error.deleteFailed': 'Failed to delete preset: {detail}',

  // Issue #514: Team Dashboard
  'dashboard.title': 'Team Dashboard',
  'dashboard.button.tooltip':
    'Team dashboard — overview of every member with state, task, and last activity',
  'dashboard.count': '{count} members',
  'dashboard.col.member': 'Member',
  'dashboard.col.state': 'State',
  'dashboard.col.task': 'Task',
  'dashboard.col.lastSeen': 'Last seen',
  'dashboard.state.active': 'Active',
  'dashboard.state.blocked': 'Awaiting leader',
  'dashboard.state.stale': 'Stale',
  'dashboard.state.completed': 'Completed',
  'dashboard.state.idle': 'Idle',
  'dashboard.task.unassigned': 'No task assigned',
  'dashboard.lastSeen.never': 'never',
  'dashboard.empty.noTeam':
    'No agent team on this canvas. Add at least one agent card to use the dashboard.',
  'dashboard.empty.noMembers':
    'This team has no members yet. Recruit members from the Leader using `team_recruit`.',
  'dashboard.banner.humanGate': 'Human gate blocked: waiting for leader decision',
  'dashboard.alert.leaderInput': 'Awaiting Leader input',
  'dashboard.alert.staleOutput': 'No output for 5+ minutes',
  // Issue #615: dual / multi preset support for team section heading
  'dashboard.team.label': 'Team {index}',


  // ---------- Team history ----------
  'teamHistory.resume.emptyMembers': 'Cannot resume because team member information is empty',
  'teamHistory.resume.otherProject':
    'This team history belongs to another project ({project})',
  'teamHistory.resume.terminalLimit':
    'Cannot resume because it would exceed the terminal limit ({max})',

};
