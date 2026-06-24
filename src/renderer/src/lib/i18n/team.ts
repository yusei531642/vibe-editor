/* eslint-disable no-restricted-syntax -- i18n辞書本体のため、日本語文字列リテラルをここに集約する */
import type { Dict } from './index';

// TeamHub / カスタムエージェント / MCP 辞書。公開キーは aggregator で既存 i18n API に統合される。

export const teamJa: Dict = {

  'teamHistory.resume': 'チーム「{name}」を復元',
  'teamHistory.resumed': 'チーム「{name}」を復元しました',
  'teamHistory.alreadyOpen': 'チーム「{name}」は既に Canvas 上にあります',
  'teamHistory.delete': '履歴から削除',

  // ---------- File tree / Editor ----------
  'team.closeTeamConfirm': 'これはチームリーダーです。チーム全体を閉じますか？',
  'team.closeTeam': 'チームを閉じる',
  'team.closeLeaderOnly': 'リーダーのみ閉じる',

  // ---------- Canvas ----------
  'handoff.create': '引き継ぎ',
  'handoff.createTooltip':
    '引き継ぎ書を保存し、Leader 自身に MCP で新 Leader 採用 → 交代を依頼します',
  'handoff.created': '引き継ぎ書 {file} を保存し、Leader に MCP 手順を伝えました',
  'handoff.action.reveal': '保存先を開く',
  'handoff.error.noProject':
    'プロジェクトルートが未設定です。サイドバーからフォルダを開いてからもう一度押してください。',
  'handoff.error.createFailed': '引き継ぎ書の作成に失敗しました: {detail}',
  'handoff.error.notLeader': '引き継ぎは Leader カードからのみ開始できます',
  'handoff.error.injectFailed': 'Leader の PTY への手順注入に失敗しました: {detail}',
  // Issue #511: PTY inject 失敗の警告 + 手動リトライ
  'injectFailure.title': '配信失敗 ({code}): {message}',
  'injectFailure.retry': '再送信',
  'injectFailure.retryBusy': '再送信中…',
  'injectFailure.retrySuccess': 'メッセージを再送信しました',
  'injectFailure.retryFailed': '再送信に失敗しました ({reason})',
  'injectFailure.retryError': '再送信中にエラーが発生しました: {detail}',
  'injectFailure.dismiss': '閉じる',
  // Issue #509: 配送済みだが team_read で確認していない message の表示
  'inboxUnread.label': '未読 {count} 件 ({ageSec}s 経過)',
  'inboxUnread.tooltip':
    'この agent は配送済みのメッセージ {count} 件を {ageSec} 秒間 team_read で確認していません。60s 超過時は督促を検討してください。',
  'agentStatus.idle': '待機中',
  'agentStatus.thinking': '思考中',
  'agentStatus.typing': '応答中',

  // Issue #521: Agent カード 3 行サマリ
  'dashboard.title': 'チームダッシュボード',
  'dashboard.button.tooltip': 'チームダッシュボード — 全メンバーの状態 / タスク / 経過を一覧',
  'dashboard.count': '{count} 名',
  'dashboard.col.member': 'メンバー',
  'dashboard.col.state': '状態',
  'dashboard.col.task': '担当タスク',
  'dashboard.col.lastSeen': '最終出力',
  'dashboard.state.active': '進行中',
  'dashboard.state.blocked': 'Leader 待ち',
  'dashboard.state.stale': '停滞',
  'dashboard.state.completed': '完了',
  'dashboard.state.idle': '待機',
  'dashboard.task.unassigned': 'タスク未割り当て',
  'dashboard.lastSeen.never': '未観測',
  'dashboard.empty.noTeam':
    '対象のチームが Canvas にありません。Agent カードを 1 枚以上配置してください',
  'dashboard.empty.noMembers':
    'このチームにはまだメンバーがいません。Leader から `team_recruit` でメンバーを招集してください',
  'dashboard.banner.humanGate': 'Human gate が blocked: Leader の判断待ちです',
  'dashboard.alert.leaderInput': 'Leader 入力待ち',
  'dashboard.alert.staleOutput': '5 分以上出力なし',
  // Issue #615: dual / multi preset 対応の team section heading
  'dashboard.team.label': 'チーム {index}',

  // ---------- Sessions ----------
  'voice.button.idle': 'クリックで会話開始',
  'voice.button.connecting': '接続中…',
  'voice.button.listening': '会話中 — クリックで終了',
  'voice.button.disabled.noKey': '設定で API キーを保存してください',
  'voice.button.disabled.notEnabled': '設定で音声指揮を有効化してください',
  'voice.confirm.title': '危険な操作の確認',
  'voice.confirm.body': '次のメッセージを Leader に送信しますか?\n\n「{text}」',
  'voice.confirm.send': '送信する',
  'voice.confirm.cancel': 'キャンセル',
  'voice.trail.sending': 'Leader へ送信中… (3 秒後に確定)',
  'voice.trail.spawningTeam': 'チームを起動中… ({preset}, 3 秒後に確定)',
  'voice.trail.cancel': 'キャンセル',
  'voice.toast.apiKeySaved': 'API キーを保存しました',
  'voice.toast.apiKeyCleared': 'API キーを削除しました',
  'voice.toast.sent': 'Leader に送信しました',
  'voice.toast.sendFailed': '送信に失敗しました ({code})',
  'voice.error.micDenied': 'マイクへのアクセスが拒否されました',
  'voice.error.openai401': 'OpenAI 認証エラー (API キーを確認してください)',
  'voice.error.keyringUnavailable': 'OS のキーリングが利用できません',
  'settings.customAgents.newName': '新しいエージェント',
  'settings.customAgents.add': '+ カスタムエージェントを追加',
  'settings.customAgents.name': '表示名',
  'settings.customAgents.remove': '削除',
  'settings.customAgents.untitled': '（無名）',
  // Issue #729: CustomAgentEditor の isJa 三項を i18n.ts に集約
  'settings.customAgents.confirmDelete': 'カスタムエージェント "{name}" を削除しますか？',
  'settings.customAgents.namePlaceholder': '例: Aider',
  'settings.customAgents.argsLabel': '引数（空白区切り、ダブルクォートで空白を含む値）',
  'settings.customAgents.cwdLabel': '作業ディレクトリ（空なら現在のプロジェクトルート）',
  'settings.customAgents.cwdUnset': '（未設定）',
  'settings.customAgents.accentColor': 'アクセントカラー（任意）',
  'settings.customAgents.runtime': '実行方式',
  'settings.customAgents.provider': 'Provider',
  'settings.customAgents.baseUrl': 'Base URL',
  'settings.customAgents.model': 'Model',
  'settings.customAgents.apiKey': 'API key',
  'settings.customAgents.apiKeySaved': '保存済み（値は表示されません）',
  'settings.customAgents.apiKeyClearConfirm': '保存済み API key を削除しますか？',
  'settings.customAgents.apiKeySaveError': 'API キーの保存に失敗しました: {detail}',
  'settings.customAgents.toolMode': 'Tool mode',
  'settings.customAgents.toolAuto': 'Auto',
  'settings.customAgents.toolReadOnly': 'Read-only chat',
  'settings.customAgents.systemPrompt': 'System prompt override',
  'settings.customAgents.apiNote': 'TeamHub tool は provider/model が対応する場合のみ有効です。',
  'settings.customAgents.readOnlyNote':
    'この provider/model は tool calling を read-only chat に degrade します。',
  'settings.customAgents.applyNote': '変更後、Canvas で該当エージェントのカードを作り直すと反映されます。',
  'settings.customAgents.skills': 'Skill (SKILL.md)',
  'settings.customAgents.skillsEmpty':
    'import 済みの skill がありません。下の「Claude / Codex から import」で追加してください。',
  'settings.customAgents.skillsAutoTeam': 'TeamHub 参加時は vibe-team skill が自動で追加されます。',
  'settings.customAgents.skillImport.title': 'Claude / Codex から skill を import',
  'settings.customAgents.skillImport.note':
    '~/.claude/skills と ~/.agents/skills (Codex) を走査し、選んだ skill を vibe-editor 専用フォルダにコピーします。',
  'settings.customAgents.skillImport.empty':
    'import 元 (~/.claude/skills・~/.agents/skills) に skill が見つかりません。',
  'settings.customAgents.skillImport.import': 'Import',
  'settings.customAgents.skillImport.remove': '削除',

  // ---------- MCP tab ----------
  'settings.mcp.autoTitle': '自動セットアップ',
  'settings.mcp.autoLabel': 'Team 起動時に vibe-team MCP を自動で登録する',
  'settings.mcp.autoHint':
    '~/.claude.json や ~/.codex/config.toml を書き換えます。書き込みに失敗する場合は OFF にして、下の手順で自分で入れてください。',
  'settings.mcp.aiTitle': 'AI エージェントに入れさせる',
  'settings.mcp.aiDesc':
    '以下のプロンプトを Claude Code / Codex に貼り付けて実行させると、vibe-team MCP がセットアップされます。',
  'settings.mcp.manualTitle': '手動で入れる',
  'settings.mcp.manualDesc': '好みのエディタで設定ファイルを開いて、以下の断片をマージしてください。',
  'settings.mcp.manualStep1': '~/.claude.json を開く (無ければ新規作成)。',
  'settings.mcp.manualStep2': '最上位の "mcpServers" オブジェクトに "vibe-team" エントリを追加。',
  'settings.mcp.manualStep3': 'Codex を使う場合は ~/.codex/config.toml に同等の [mcp_servers.vibe-team] を追加。',
  'settings.mcp.copy': 'コピー',
  'settings.mcp.copied': 'コピーしました',
  // Issue #729: McpSection の isJa 三項を i18n.ts に移管
  'settings.mcp.claudeSampleNote': '~/.claude.json のサンプル (既存の mcpServers と統合してください):',
  'settings.mcp.codexSampleNote': '~/.codex/config.toml のサンプル:',
  'settings.mcp.connInfoLabel': '接続情報 (現在値):',

  // ---------- Updater (Issue #59) ----------
  'teamHistory.resume.emptyMembers': 'チームメンバー情報が空のため復元できません',
  'teamHistory.resume.otherProject':
    'このチームは別プロジェクト({project})の履歴です',
  'teamHistory.resume.terminalLimit':
    'ターミナル上限({max})を超えるため復元できません',

  // ---------- Onboarding ----------

};

export const teamEn: Dict = {

  'teamHistory.resume': 'Resume team "{name}"',
  'teamHistory.resumed': 'Resumed team "{name}"',
  'teamHistory.alreadyOpen': 'Team "{name}" is already open on the Canvas',
  'teamHistory.delete': 'Remove from history',

  // ---------- File tree / Editor ----------
  'team.closeTeamConfirm': 'This is the team leader. Close entire team?',
  'team.closeTeam': 'Close Team',
  'team.closeLeaderOnly': 'Close Leader Only',

  // ---------- Canvas ----------
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

  // ---------- Sessions ----------
  'voice.button.idle': 'Click to start',
  'voice.button.connecting': 'Connecting…',
  'voice.button.listening': 'Listening — click to stop',
  'voice.button.disabled.noKey': 'Save an API key in Settings',
  'voice.button.disabled.notEnabled': 'Enable voice direction in Settings',
  'voice.confirm.title': 'Confirm sensitive action',
  'voice.confirm.body': 'Send the following message to the Leader?\n\n"{text}"',
  'voice.confirm.send': 'Send',
  'voice.confirm.cancel': 'Cancel',
  'voice.trail.sending': 'Sending to Leader… (3 s before commit)',
  'voice.trail.spawningTeam': 'Spawning team… ({preset}, 3 s before commit)',
  'voice.trail.cancel': 'Cancel',
  'voice.toast.apiKeySaved': 'API key saved',
  'voice.toast.apiKeyCleared': 'API key cleared',
  'voice.toast.sent': 'Sent to Leader',
  'voice.toast.sendFailed': 'Send failed ({code})',
  'voice.error.micDenied': 'Microphone access was denied',
  'voice.error.openai401': 'OpenAI authentication error (check your API key)',
  'voice.error.keyringUnavailable': 'OS keyring is not available',
  'settings.customAgents.newName': 'New agent',
  'settings.customAgents.add': '+ Add custom agent',
  'settings.customAgents.name': 'Display name',
  'settings.customAgents.remove': 'Remove',
  'settings.customAgents.untitled': '(untitled)',
  // Issue #729: CustomAgentEditor isJa ternaries consolidated into i18n.ts
  'settings.customAgents.confirmDelete': 'Delete custom agent "{name}"?',
  'settings.customAgents.namePlaceholder': 'e.g. Aider',
  'settings.customAgents.argsLabel': 'Arguments (space-separated; use quotes for spaces)',
  'settings.customAgents.cwdLabel': 'Working directory (blank = current project root)',
  'settings.customAgents.cwdUnset': '(unset)',
  'settings.customAgents.accentColor': 'Accent color (optional)',
  'settings.customAgents.runtime': 'Runtime',
  'settings.customAgents.provider': 'Provider',
  'settings.customAgents.baseUrl': 'Base URL',
  'settings.customAgents.model': 'Model',
  'settings.customAgents.apiKey': 'API key',
  'settings.customAgents.apiKeySaved': 'Saved (value is hidden)',
  'settings.customAgents.apiKeyClearConfirm': 'Delete the saved API key?',
  'settings.customAgents.apiKeySaveError': 'Failed to save the API key: {detail}',
  'settings.customAgents.toolMode': 'Tool mode',
  'settings.customAgents.toolAuto': 'Auto',
  'settings.customAgents.toolReadOnly': 'Read-only chat',
  'settings.customAgents.systemPrompt': 'System prompt override',
  'settings.customAgents.apiNote': 'TeamHub tools are enabled only when the provider/model supports them.',
  'settings.customAgents.readOnlyNote':
    'This provider/model degrades to read-only chat because tool calling is unavailable.',
  'settings.customAgents.applyNote': 'Recreate the agent card in Canvas to apply changes.',
  'settings.customAgents.skills': 'Skills (SKILL.md)',
  'settings.customAgents.skillsEmpty':
    'No imported skills yet. Add some via “Import from Claude / Codex” below.',
  'settings.customAgents.skillsAutoTeam':
    'The vibe-team skill is added automatically when joining TeamHub.',
  'settings.customAgents.skillImport.title': 'Import skills from Claude / Codex',
  'settings.customAgents.skillImport.note':
    'Scans ~/.claude/skills and ~/.agents/skills (Codex), and copies the selected skill into the vibe-editor skills folder.',
  'settings.customAgents.skillImport.empty':
    'No skills found in the import sources (~/.claude/skills, ~/.agents/skills).',
  'settings.customAgents.skillImport.import': 'Import',
  'settings.customAgents.skillImport.remove': 'Remove',

  // ---------- MCP tab ----------
  'settings.mcp.autoTitle': 'Auto setup',
  'settings.mcp.autoLabel': 'Automatically register vibe-team MCP when a team starts',
  'settings.mcp.autoHint':
    'Rewrites ~/.claude.json and ~/.codex/config.toml. If that is unreliable, turn it off and install the server manually below.',
  'settings.mcp.aiTitle': 'Have your AI agent install it',
  'settings.mcp.aiDesc':
    'Paste the following prompt into Claude Code or Codex and let it install the vibe-team MCP for you.',
  'settings.mcp.manualTitle': 'Install manually',
  'settings.mcp.manualDesc':
    'Open the config files in your editor and merge the snippets below.',
  'settings.mcp.manualStep1': 'Open ~/.claude.json (create it if missing).',
  'settings.mcp.manualStep2': 'Add a "vibe-team" entry under the top-level "mcpServers" object.',
  'settings.mcp.manualStep3':
    'For Codex, add the equivalent [mcp_servers.vibe-team] section to ~/.codex/config.toml.',
  'settings.mcp.copy': 'Copy',
  'settings.mcp.copied': 'Copied',
  // Issue #729: McpSection inline isJa moved into i18n.ts
  'settings.mcp.claudeSampleNote': 'Sample for ~/.claude.json (merge with existing mcpServers):',
  'settings.mcp.codexSampleNote': 'Sample for ~/.codex/config.toml:',
  'settings.mcp.connInfoLabel': 'Connection info:',

  // ---------- Updater (Issue #59) ----------
  'teamHistory.resume.emptyMembers': 'Cannot resume because team member information is empty',
  'teamHistory.resume.otherProject':
    'This team history belongs to another project ({project})',
  'teamHistory.resume.terminalLimit':
    'Cannot resume because it would exceed the terminal limit ({max})',

  // ---------- Onboarding ----------

};
