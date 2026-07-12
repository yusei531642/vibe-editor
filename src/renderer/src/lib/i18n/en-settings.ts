import type { Dict } from './types';

/**
 * English辞書 — 設定モーダル / オンボーディング / テーマ / 音声指揮。
 * Issue #1032: i18n.ts の god-file 分割で領域別サブ辞書に分離。
 * 追加キーは領域の合うファイルへ。merge は index.ts 側で行う。
 */
export const enSettings: Dict = {
  // ---------- Mascot section (SettingsModal "Character" section) ----------
  // Issue #729: MascotSection isJa ternaries / settings-options.ts hardcode -> centralised in i18n.ts
  'settings.mascot.title': 'Character',
  'settings.mascot.pickTitle': 'Pick a mascot image',
  'settings.mascot.imageFilterName': 'Images',
  'settings.mascot.choose': 'Choose image…',
  'settings.mascot.clear': 'Clear',
  'settings.mascot.hint':
    'PNG / GIF (animated) / APNG / WebP / SVG. A small square (32–128 px) renders best.',
  'mascot.desc.vibe': 'Default tiny companion',
  'mascot.desc.spark': 'Brighter and lighter',
  'mascot.desc.mono': 'A terminal-friendly angular look',
  'mascot.desc.coder': 'A tiny companion typing at a computer',
  'mascot.desc.custom': 'Use your own raster image (PNG/GIF/WebP) as the companion',


  // ---------- Settings ----------
  'settings.title': 'Settings',
  // Issue #729: WelcomePane inline isJa moved into i18n.ts
  'welcome.title': 'Build with calm momentum.',
  'welcome.recentProjects': 'Recent projects',
  'welcome.recentProjectsTitle': 'Jump back into your flow',
  'welcome.workspaceLabel': 'Workspace',
  'welcome.quickStart': 'Quick start',
  'welcome.quickStartTitle': 'What you can do next',
  // Issue #729: canvas-layout-helpers language-based hardcode moved into i18n.ts
  'canvas.agentCount': '{count} agents',
  'canvas.orgAgentCount': '{organizationCount} orgs / {agentCount} agents',
  // Issue #729: RoleProfilesSection inline isJa moved into i18n.ts
  'settings.roles.title': 'Role profiles',
  'settings.roles.desc':
    'Define vibe-team member roles. Leaders pick from these when calling team_recruit.',
  'settings.roles.globalPreamble': 'Global preamble',
  'settings.roles.globalPreambleHint': 'Prepended to all prompts',
  'settings.roles.confirmDelete': 'Delete "{id}"?',
  'settings.roles.addCustom': 'Add custom role',
  'settings.roles.newCustomDesc': 'New custom role.',
  'settings.roles.builtin': 'built-in',
  'settings.roles.custom': 'custom',
  'settings.roles.color': 'Color',
  'settings.roles.glyph': 'Glyph',
  'settings.roles.defaultEngine': 'Default engine',
  'settings.roles.permissions': 'Permissions',
  'settings.roles.promptEn': 'System prompt (EN)',
  'settings.roles.promptJa': 'System prompt (JA)',
  'settings.roles.promptPlaceholders':
    'Available: {teamName} {selfLabel} {selfDescription} {roster} {tools} {globalPreamble}',
  'settings.roles.deleteRole': 'Delete this role',
  // Issue #729: settings-section-meta.tsx FIXED_LABELS_EN moved into i18n.ts
  'settings.section.general.label': 'General',
  'settings.section.general.title': 'General',
  'settings.section.general.desc': 'Language and density',
  'settings.section.appearance.label': 'Appearance',
  'settings.section.appearance.title': 'Appearance',
  'settings.section.appearance.desc': 'Theme, surfaces, and character',
  'settings.section.fonts.label': 'Fonts',
  'settings.section.fonts.title': 'Typography',
  'settings.section.fonts.desc': 'UI / editor / terminal fonts',
  'settings.section.claude.label': 'Claude Code',
  'settings.section.claude.title': 'Claude Code',
  'settings.section.claude.desc': 'Launch command and args',
  'settings.section.codex.label': 'Codex',
  'settings.section.codex.title': 'Codex',
  'settings.section.codex.desc': 'Launch command and args',
  // Issue #1068: codex team_send delivery method toggle
  'settings.codexDelivery.title': 'team_send delivery',
  'settings.codexDelivery.label': 'Delivery method',
  'settings.codexDelivery.optBackend': 'Backend (app-server) — falls back to PTY if unavailable',
  'settings.codexDelivery.optPty': 'PTY injection — always paste into the terminal',
  'settings.codexDelivery.hint':
    'How team_send reaches codex: via the official codex app-server (JSON-RPC) or the legacy PTY paste into the terminal. Backend keeps history and avoids input races, but automatically falls back to PTY when the app-server is unavailable. Windows always uses PTY (app-server is not supported).',
  'settings.section.roles.label': 'Role profiles',
  'settings.section.roles.title': 'Role profiles',
  'settings.section.roles.desc': 'Team member role templates',
  'settings.section.mcp.label': 'MCP',
  'settings.section.mcp.title': 'MCP',
  'settings.section.mcp.desc': 'How to install vibe-team MCP',
  // Issue #825: Voice Direction Mode (Beta)
  'settings.section.voice.label': 'Voice (Beta)',
  'settings.section.voice.title': 'Voice Direction',
  'settings.section.voice.desc':
    'Direct your Leader by talking to an AI assistant via OpenAI Realtime API.',
  'settings.voice.beta.warning':
    'This feature is in beta and has not been tested. Unexpected behavior, unstable connections, or misrecognition may occur. Please share feedback on GitHub Issues.',
  'settings.voice.enabled.label': 'Enable voice direction',
  'settings.voice.apiKey.label': 'API key',
  'settings.voice.apiKey.placeholder': 'sk-...',
  'settings.voice.apiKey.save': 'Save',
  'settings.voice.apiKey.clear': 'Clear',
  'settings.voice.apiKey.clearConfirm': 'Delete the saved API key?',
  'settings.voice.apiKey.savedNotice':
    'Your API key is encrypted and securely stored in your OS keyring (Credential Manager on Windows, Keychain on macOS, secret-service on Linux). Once saved, it cannot be viewed again. Click "Clear" to re-enter.',
  'settings.voice.model.label': 'Model',
  'settings.voice.voiceName.label': 'AI voice',
  'settings.voice.language.label': 'Language',
  'settings.voice.inputDevice.label': 'Input device (microphone)',
  'settings.voice.outputDevice.label': 'Output device (speaker)',
  'settings.voice.shortcut.label': 'Toggle shortcut',
  'settings.voice.shortcut.reset': 'Reset',
  'settings.voice.shortcut.capturing': 'Capturing… (press a key combination)',
  'settings.voice.confirmation.label': 'Send confirmation',
  'settings.voice.confirmation.always': 'Always confirm (recommended)',
  'settings.voice.confirmation.bypass': 'Bypass confirmation',
  'settings.voice.confirmation.bypassWarning':
    'When bypassed, both the AI verbal confirmation and the renderer-side final check are skipped. Misrecognized speech may be sent to the Leader immediately.',
  'settings.voice.disclaimer.title': 'Voice Direction (Beta)',
  'settings.voice.disclaimer.body':
    'This feature is in beta and has not been tested by the developers. Unexpected behavior may occur.\n\nPlease read before using:\n- It uses the OpenAI Realtime API. API charges apply.\n- Your API key is stored encrypted in your OS keyring.\n- Microphone permission is required.\n- Recognition accuracy and connection stability depend on your environment.\n- Please report issues and feedback on GitHub Issues.',
  'settings.voice.disclaimer.ack': 'I understand',
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
  'common.show': 'Show',
  'common.hide': 'Hide',
  'common.saving': 'Saving…',
  'common.systemDefault': 'System default',
  'settings.section.logs.label': 'Logs',
  'settings.section.logs.title': 'Logs',
  'settings.section.logs.desc': 'View runtime logs from the app',
  'settings.section.untitled': '(untitled)',
  'settings.section.customDesc': 'Custom agent settings',
  'settings.section.addCustom': '+ Add',
  'settings.section.group.agents': 'Agents',
  'settings.section.group.team': 'Team',
  'settings.section.group.other': 'Other',
  // Issue #729: SettingsModal inline isJa moved into i18n.ts
  'settings.dialog.label': 'Settings',
  'settings.back': 'Back',
  'settings.sections.ariaLabel': 'Settings sections',
  'settings.saveFailedSeeConsole': 'Failed to save settings. See the developer console for details.',
  'settings.search.placeholder': 'Search settings…',
  'settings.search.ariaLabel': 'Search settings',
  'settings.search.clear': 'Clear',
  'settings.search.noMatches': 'No matches',
  'settings.fonts.uiFontTitle': 'UI Font',
  'settings.fonts.editorFontTitle': 'Editor Font (Monaco)',
  'settings.launch.title': 'Launch options',
  'settings.launch.argsLabel': 'Arguments',
  'settings.launch.argsLabelSimple': 'Arguments',
  'settings.launch.cwdLabel': 'Working directory',
  'settings.launch.cwdUnset': '(unset)',
  'settings.launch.applyNote': 'Restart terminals to apply changes.',
  'settings.customAgents.newName': 'New agent',
  'settings.language': 'Language',
  'settings.language.desc':
    'Switch the UI language. Does not affect the language Claude Code responds in.',
  'settings.theme': 'Theme',
  'settings.uiFont': 'UI font',
  'settings.uiFontFamily': 'Font family',
  'settings.uiFontSize': 'Size (px)',
  'settings.editorFont': 'Editor font (Monaco)',
  'settings.editorFontFamily': 'Font family',
  'settings.editorFontSize': 'Size (px)',
  'settings.terminal': 'Terminal',
  'settings.terminalFontFamily': 'Font',
  'settings.terminalFontSize': 'Font size (px)',
  'settings.terminalNote':
    'Default is JetBrains Mono Nerd Font (bundled). Includes Powerline / Devicons / Material Icons glyphs so Starship and oh-my-posh icons no longer render as tofu. ★ marks bundled fonts that always render the same regardless of OS-installed fonts.',
  'settings.terminalForceUtf8.label': 'Force UTF-8 in Windows terminals (chcp 65001)',
  'settings.terminalForceUtf8.hint':
    'Inject `chcp 65001` when launching cmd.exe / PowerShell so console output is UTF-8. Prevents Japanese / CJK filenames and output from rendering as U+FFFD. Turn this OFF only if you intentionally want to keep the OEM code page. No-op on non-Windows OSes.',
  'settings.terminalForceUtf8.nonWindows': 'This setting only applies on Windows',
  'settings.density': 'Density',
  // Issue #729: DensitySection hardcoded JP desc moved to i18n.ts (mirrors theme.desc / mascot.desc)
  'density.desc.compact': 'For 14" or smaller screens, tighter spacing',
  'density.desc.normal': 'Default',
  'density.desc.comfortable': 'For large screens, roomier spacing',
  'settings.reset': 'Reset to defaults',
  'settings.cancel': 'Cancel',
  'settings.apply': 'Apply & save',
  'settings.custom': '(custom)',


  // ---------- Theme labels (UserMenu / OnboardingWizard) ----------
  'theme.label.claude-dark': 'Claude Dark',
  'theme.label.claude-light': 'Claude Light',
  'theme.label.dark': 'Dark',
  'theme.label.light': 'Light',
  'theme.label.midnight': 'Midnight',
  'theme.label.glass': 'Glass',


  // ---------- Theme descriptions (ThemeSection theme cards) ----------
  // Issue #729: previously hardcoded JP in settings-options.ts. Now centralised so EN users see English.
  'theme.desc.claude-dark': "Anthropic's official palette. Warm dark brown + coral #D97757 (default)",
  'theme.desc.claude-light': 'Recreates the claude.ai cream background with warm accent colors',
  'theme.desc.dark': 'Classic VS Code-style dark',
  'theme.desc.midnight': 'Deep blue-purple base with purple accents',
  'theme.desc.glass': 'Frosted-glass look — translucent panels + blur',
  'theme.desc.light': 'Bright background, dark text',


  // ---------- Language labels (UserMenu / LanguageSection) ----------
  'lang.label.ja': '日本語',
  'lang.label.ja.sub': 'Japanese',
  'lang.label.en': 'English',
  'lang.label.en.sub': 'English',


  // ---------- Settings: Logs (Issue #326) ----------
  'settings.logs.title': 'Logs',
  'settings.logs.desc':
    'Tail of the app runtime log (~/.vibe-editor/logs/vibe-editor.log). Attach this when filing a bug report.',
  'settings.logs.refresh': 'Refresh',
  'settings.logs.openDir': 'Open log folder',
  'settings.logs.levelFilter': 'Level',
  'settings.logs.level.all': 'All',
  'settings.logs.loading': 'Loading…',
  'settings.logs.empty': 'No logs yet.',
  'settings.logs.noMatch': 'No log lines match the selected level.',
  'settings.logs.truncated': 'tail only',


  // ---------- Settings helpers (Issue #76) ----------
  'settings.command': 'Command',
  'settings.argsUnterminatedQuote':
    'Unterminated double quote (") — arguments may be parsed incorrectly.',
  'settings.argsUnicodeDash':
    'Contains Unicode dashes (–, — etc.) — they will be normalized to ASCII "--" at runtime. Likely caused by paste or IME autocorrect.',


  // ---------- Custom agents ----------
  'settings.customAgents.add': '+ Add custom agent',
  'settings.agentWizard.title': 'Add an agent',
  'settings.agentWizard.typeApi': 'API model',
  'settings.agentWizard.typeApiDesc': 'Cloud models (OpenAI / Anthropic / Gemini …)',
  'settings.agentWizard.typeCli': 'CLI command',
  'settings.agentWizard.typeCliDesc': 'A CLI agent that runs in a terminal (claude/codex compatible)',
  'settings.agentWizard.apiKeyOptional': 'API key (optional — can set later)',
  'settings.agentWizard.skills': 'Skills',
  'settings.agentWizard.skillsHint':
    'Select skills to apply at launch (optional). Import more from the Skill section in settings.',
  'settings.agentWizard.reviewSummary': 'Will create with:',
  'settings.agentWizard.next': 'Next',
  'settings.agentWizard.back': 'Back',
  'settings.agentWizard.create': 'Create',
  'settings.agentWizard.cancel': 'Cancel',
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
  'settings.customAgents.engine': 'Engine (compatibility)',
  'settings.customAgents.engineClaude': 'Claude-compatible',
  'settings.customAgents.engineCodex': 'Codex-compatible',
  'settings.customAgents.icon': 'Icon (lucide name)',
  'settings.customAgents.tags': 'Tags',
  'settings.customAgents.tagsPlaceholder': 'Comma-separated',
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
  'settings.customAgents.skillSearch': 'Search skills',
  'settings.customAgents.applySkills': 'Apply to project',
  'settings.customAgents.applySkillsBusy': 'Applying…',
  'settings.customAgents.applySkillsEmpty': 'No skills selected to apply.',
  'settings.customAgents.applySkillsDone': 'Applied {count}/{total} skills to .claude/skills.',
  'settings.customAgents.applySkillsError': 'Failed to apply skills: {detail}',
  'settings.customAgents.cliSkillsNote':
    'CLI agents auto-discover .claude/skills. Check skills and Apply to place them in the project.',
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


  // ---------- Onboarding ----------
  'onboarding.back': 'Back',
  'onboarding.next': 'Next',
  'onboarding.skip': 'Skip for now',
  'onboarding.replay': 'Run setup again',
  'onboarding.ariaLabel': 'vibe-editor setup',
  'onboarding.welcome.eyebrow': 'vibe-editor',
  'onboarding.welcome.title': 'A calmer entry to deep work.',
  'onboarding.welcome.subtitle':
    'A quiet IDE tailored for Claude Code and Codex. Just a couple of steps to get going.',
  'onboarding.welcome.cta': 'Get started',
  'onboarding.appearance.eyebrow': 'Appearance',
  'onboarding.appearance.title': 'Choose your look',
  'onboarding.appearance.subtitle':
    'Language and theme can be changed anytime from settings.',
  'onboarding.appearance.language': 'Language',
  'onboarding.appearance.theme': 'Theme',
  'onboarding.workspace.eyebrow': 'Workspace',
  'onboarding.workspace.title': 'Open your first folder',
  'onboarding.workspace.subtitle':
    'Pick a project folder and we will reopen it next time. You can always add more later.',
  'onboarding.workspace.choose': 'Choose folder',
  'onboarding.workspace.change': 'Choose a different folder',
  'onboarding.workspace.clear': 'Clear selected folder',
  'onboarding.done.eyebrow': 'Ready',
  'onboarding.done.title': 'You are all set',
  'onboarding.done.subtitle': 'A calm workspace for today’s first line.',
  'onboarding.done.summaryLanguage': 'Language',
  'onboarding.done.summaryTheme': 'Theme',
  'onboarding.done.summaryFolder': 'Folder',
  'onboarding.done.summaryFolderNone': 'Open later',
  'onboarding.done.cta': 'Open editor',
};
