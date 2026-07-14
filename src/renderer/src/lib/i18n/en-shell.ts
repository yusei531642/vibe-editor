import type { Dict } from './types';

/**
 * English辞書 — シェル / エディタ / ターミナル等の共通 UI。
 * Issue #1032: i18n.ts の god-file 分割で領域別サブ辞書に分離。
 * 追加キーは領域の合うファイルへ。merge は index.ts 側で行う。
 */
export const enShell: Dict = {
  // ---------- Common ----------
  'common.close': 'Close',
  'common.cancel': 'Cancel',


  // ---------- Toolbar ----------
  'toolbar.restart.title': 'Restart app',
  'toolbar.palette.title': 'Command palette (Ctrl+Shift+P)',
  'toolbar.settings.title': 'Settings (Ctrl+,)',


  // ---------- Window controls (Issue #260 PR-2: custom titlebar) ----------
  'windowControls.minimize': 'Minimize',
  'windowControls.maximize': 'Maximize',
  'windowControls.restore': 'Restore',
  'windowControls.close': 'Close',
  'windowControls.group': 'Window controls',


  // ---------- Topbar (redesign shell) ----------
  'topbar.mode.canvas': 'Canvas',


  // ---------- Status bar ----------
  'status.branch': 'branch',
  'status.changes': 'changes',
  'status.lang': 'lang',
  'status.theme': 'theme',
  'status.mascot.idle': 'Idle',
  'status.mascot.sleep': 'Sleeping…',
  'status.mascot.working': 'Agent working',
  'status.mascot.thinking': 'Waiting for response',
  'status.mascot.done': 'Done!',
  'status.mascot.error': 'Needs attention',
  'status.mascot.excited': 'Yeah!',


  // ---------- AppMenu ----------
  'appMenu.title': 'Project menu',
  'appMenu.new': 'New project…',
  'appMenu.newHint': 'Create or select empty folder',
  'appMenu.openFolder': 'Open folder…',
  'appMenu.openFolderHint': 'Existing project',
  'appMenu.openFile': 'Open file…',
  'appMenu.newDialogTitle': 'New project',
  'appMenu.openFolderDialogTitle': 'Open folder',
  'appMenu.openFileDialogTitle': 'Open file',
  'project.newDialogTitle': 'New project: choose or create an empty folder',
  'project.openExistingDialogTitle': 'Open existing project',
  'project.loading': 'Loading project…',
  'project.loadError': 'Load error: {error}',
  'project.initError': 'Initialization error: {error}',
  'project.newFolderNotEmpty': 'Folder is not empty. Opening it as an existing project.',
  'project.created': 'Created new project',
  'project.fileParentLoaded': 'Loaded the parent folder of {file} as the project',
  'project.recentCleared': 'Cleared recent project history',
  'appMenu.addWorkspaceDialogTitle': 'Add to workspace',
  'appMenu.openFileHint': 'Single file',
  'appMenu.addToWorkspace': 'Add folder to workspace…',
  'appMenu.addToWorkspaceHint': 'Show another root in the sidebar',
  'appMenu.recent': 'Recent projects',
  'appMenu.recentCount': '{count} recent',
  'appMenu.workspace': 'Workspace',
  'appMenu.clear': 'Clear',
  'appMenu.empty': 'No history',
  'menubar.file': 'File',
  'menubar.view': 'View',
  'menubar.help': 'Help',
  'menubar.toggleSidebar': 'Toggle sidebar',
  'menubar.toggleCanvas': 'Toggle IDE / Canvas',
  'menubar.openPalette': 'Command palette',
  'menubar.openSettings': 'Settings…',
  'menubar.openGithub': 'Open on GitHub',
  'menubar.restart': 'Restart',

  // ---------- UserMenu (sidebar footer) ----------
  'userMenu.settings': 'Settings',
  'userMenu.language': 'Language',
  'userMenu.theme': 'Theme',
  'userMenu.releases': 'View releases on GitHub',

  // ---------- Workspace (Issue #4) ----------
  'workspace.roots': 'Workspace',
  'workspace.add': 'Add folder',
  'workspace.remove': 'Remove from workspace',
  'workspace.removePrimaryConfirm': 'Remove {name} from the current workspace?',
  'workspace.removed': 'Removed {name} from the workspace',
  'workspace.added': 'Added {name} to the workspace',
  'workspace.alreadyAdded': '{name} is already in the workspace',


  // ---------- Sidebar ----------
  'sidebar.files': 'Files',
  'sidebar.changes': 'Changes',
  'sidebar.history': 'History',
  'sidebar.loading': 'Loading…',
  'sidebar.notGitRepo': 'Not a git repository',
  'sidebar.noChanges': 'No changes',
  'sidebar.noSessions': 'No session history for this project yet',
  'sidebar.filesChanged': '{count} changed',
  'sidebar.sessionCount': '{count} sessions',
  'sidebar.refresh': 'Refresh',
  'sidebar.teams': 'Teams',
  'sidebar.singleSessions': 'Single sessions',
  'sidebar.notes': 'Notes',
  'rail.primaryNav': 'Primary navigation',


  // ---------- Notes (Issue #17) ----------
  'notes.title': 'Notes',
  'notes.placeholder': 'Jot down anything you want to hand off between terminals…\nSaved automatically.',
  'notes.copy': 'Copy to clipboard',
  'notes.clear': 'Clear notes',
  'notes.copied': 'Copied notes',
  'notes.copyFailed': 'Failed to copy',
  'notes.confirmClear': 'Clear notes?',
  'notes.autoSaved': 'Saved automatically',
  'notes.chars': 'chars',


  // ---------- File tree / Editor ----------
  'filetree.refresh': 'Reload',
  'filetree.treeLabel': 'File tree',
  'diff.loading': 'Loading diff…',
  'diff.selectFile': 'Select a file to view its diff',
  'diff.error': 'Error: {error}',
  'diff.binary': 'Binary files cannot be shown as diffs: {path}',
  'diff.new': '(new)',
  'diff.deleted': '(deleted)',
  'diff.toggleMode': 'Toggle diff display mode',
  'diff.toggleInline': 'Switch to inline',
  'diff.toggleSideBySide': 'Switch to side by side',
  'editor.loading': 'Loading file…',
  'editor.save': 'Save (Ctrl+S)',
  'editor.save.ariaLabel': 'Save',
  'editor.viewPreview': 'Show preview',
  'editor.viewSource': 'Show source',
  'editor.binaryNotice': 'Binary file cannot be edited: {path}',
  'editor.nonUtf8Warning':
    'Opened with lossy encoding ({path}) — saving would lose the original encoding so editing is disabled.',
  'editor.nonUtf8SaveBlocked': 'Save is disabled (non-UTF-8): {path}',
  'editor.nonUtf8ReadOnly': 'read-only (non-UTF-8)',
  'editor.externalChangeConfirm':
    '{path} has been modified on disk since you opened it. Save anyway and overwrite external changes?',
  'editor.saveAborted': 'Save aborted: {path}',
  'editor.saved': 'Saved: {path}',
  'editor.saveFailed': 'Save failed: {error}',
  'editor.discardSingle': 'This file has unsaved changes. Close it anyway?\n\n{path}',
  'editor.discardMultiple': 'There are unsaved changes. Switching now will discard {count} file(s). Continue?',
  'editor.restartConfirm': 'There are unsaved changes. Restarting the app will discard them. Continue?',
  // Issue #595: Confirmation shown when closing a Canvas EditorCard with unsaved edits via × / Clear.
  'editor.confirmDiscardChanges':
    'This card has unsaved changes that will be lost if you close it. Continue?\n\n{path}',
  'editor.confirmDiscardChangesPlural':
    '{count} cards have unsaved changes that will be lost if you close them. Continue?\n\n{paths}',


  // ---------- Welcome ----------
  'welcome.subtitle': 'vibe coding with Claude Code',
  'welcome.hint1Key': 'Right',
  'welcome.hint1Text': "talk to Claude Code in the terminal",
  'welcome.hint2Key': 'Changes',
  'welcome.hint2Text': "tab: review diffs of files Claude touched",
  'welcome.hint3Key': 'History',
  'welcome.hint3Text': 'tab: resume past sessions',
  'welcome.hint4Text': 'for the command palette',


  // ---------- Context menu ----------
  'ctxMenu.openDiff': 'Open diff',
  'ctxMenu.reviewDiff': 'Ask Claude Code to review this diff',
  'ctxMenu.copyPath': 'Copy path',
  // Issue #251: file tree right-click menu
  'ctxMenu.copyAbsolutePath': 'Copy absolute path',
  'ctxMenu.copyRelativePath': 'Copy relative path',
  'ctxMenu.copyFileName': 'Copy file name',
  'ctxMenu.revealInFolder': 'Reveal in File Explorer',
  // Issue #592: VS Code-style file/folder operations
  'ctxMenu.newFile': 'New File',
  'ctxMenu.newFolder': 'New Folder',
  'ctxMenu.rename': 'Rename',
  'ctxMenu.delete': 'Delete',
  'ctxMenu.cut': 'Cut',
  'ctxMenu.copy': 'Copy',
  'ctxMenu.paste': 'Paste',
  'ctxMenu.duplicate': 'Duplicate',
  'filetree.prompt.newFileName': 'New file name',
  'filetree.prompt.newFolderName': 'New folder name',
  'filetree.prompt.renameTo': 'New name',
  'filetree.confirmDeleteFile': 'Move "{name}" to the trash?',
  'filetree.confirmDeleteFolder': 'Move "{name}" and all of its contents to the trash?',
  'filetree.confirmDeletePermanent': 'Permanently delete "{name}"? This action cannot be undone.',
  'filetree.preloadRestartRequired': 'Restart the app to apply the preload update',
  'canvasMenu.lockTeam': 'Move team together',
  'canvasMenu.unlockTeam': 'Unlock team movement',
  'canvasMenu.deleteCard': 'Delete card',
  'canvasMenu.addClaudeHere': 'Add Claude here',
  'canvasMenu.addCodexHere': 'Add Codex here',
  'canvasMenu.addCustomAgentHere': 'Add {name} here',
  'canvasMenu.addFileTreeHere': 'Add file tree here',
  'canvasMenu.addChangesHere': 'Add Git changes here',
  'canvasMenu.addEditorHere': 'Add empty editor here',
  'canvasMenu.spawnDefaultTeam': 'Spawn default team',


  // ---------- Claude Code panel ----------
  'claudePanel.title': 'IDE Mode',
  'claudePanel.notFound.title': 'Claude Code not found',
  'claudePanel.notFound.body':
    'The `claude` command was not found on your PATH. Install Claude Code, or specify the launch command in Settings.',
  'claudePanel.notFound.step1Title': 'Install the CLI',
  'claudePanel.notFound.step1Desc': 'Make sure the `claude` command is available from your terminal.',
  'claudePanel.notFound.step2Title': 'Check settings',
  'claudePanel.notFound.step2Desc': 'If using a custom command, review the launch command in Settings.',
  'claudePanel.notFound.installLink': 'Install Claude Code',
  'claudePanel.notFound.retry': 'Retry detection',
  'claudePanel.notFound.settings': 'Open settings',
  'claudePanel.checking': 'Checking…',
  'claudePanel.newTab': 'New terminal tab',
  'claudePanel.addClaude': 'Add Claude Code',
  'claudePanel.addCodex': 'Add Codex',


  // ---------- Sessions ----------
  'sessions.resume': 'Resume session {id}',
  'sessions.messages': '{count} msgs',
  // Issue #837: "N+" rendering when messageCount reaches the scan limit.
  'sessions.messagesCapped': '{count}+ msgs',
  'sessions.loadMore': 'Load {remaining} more',


  // ---------- Tab ----------
  'tab.pinned': 'Pinned',
  'tab.newOutput': 'New output',
  'tab.pin': 'Pin tab',
  'tab.unpin': 'Unpin',
  'tab.close': 'Close tab',
  'tab.closeWithShortcut': 'Close (Ctrl+W)',
  'fonts.family': 'Font family',
  'fonts.custom': '(custom)',
  'fonts.size': 'Size (px)',
  'fonts.customCss': 'Custom CSS font-family',


  // ---------- Roles ----------


  // ---------- Toast ----------
  'toast.reviewRequested': 'Review requested: {path}',
  'toast.sessionResumed': 'Resumed session: {title}',
  'toast.pathCopied': 'Path copied to clipboard',
  'toast.copyFailed': 'Failed to copy to clipboard',
  'toast.revealFailed': 'Failed to reveal in file manager',
  // Issue #592: file operation feedback
  'toast.fileCreated': 'Created "{name}"',
  'toast.folderCreated': 'Created folder "{name}"',
  'toast.fileRenamed': 'Renamed "{from}" to "{to}"',
  'toast.fileDeleted': 'Deleted "{name}"',
  'toast.fileCopied': 'Copied "{name}"',
  'toast.fileMoved': 'Moved "{name}"',
  'toast.fileOpFailed': 'File operation failed: {error}',
  'toast.fileOpClipboardEmpty': 'Nothing to paste',
  'toast.terminalNotReady': 'Terminal is not ready',
  'toast.settings.loadFailed':
    'Failed to load settings, so automatic settings saves are disabled for this launch: {error}',
  'toast.settings.saveBlocked':
    'Settings were not loaded, so saving settings is disabled. Please restart the app.',
  'toast.settings.saveFailed': 'Failed to save settings: {error}',
  'toast.settings.projectRootFailed': 'Failed to apply project root: {error}',
  // Issue #578: Warn when recruits ran while canvas was hidden
  'toast.recruitWhileHidden':
    '{count} recruit(s) ran while Canvas was hidden. Re-run any that may have failed',
  'toast.recruitRescued': 'Recruit rescued after timeout ({ms}ms late)',


  // ---------- Status ----------

  // ---------- Terminal (paste errors) ----------
  'terminal.pasteImageFailed': 'Paste image failed',
  'terminal.pasteException': 'Paste exception',


  // ---------- Terminal cwd warning (Issue #818) ----------
  // Rust side `resolve_valid_cwd` returns a structured warning (i18n key + params)
  // when the requested cwd is invalid and falls back to project root / process cwd.
  // Previously Rust hardcoded a Japanese string which leaked through to EN users
  // (Issue #729 leftover).
  // - `{requested}`: the originally requested cwd (empty → use `*.unsetLabel`)
  // - `{fallback}` : where we actually started (project root or process default)
  'terminal.cwd.warningPrefix': '[warning]',
  'terminal.cwd.unsetLabel': '(unset)',
  'terminal.cwd.invalidFallbackToHome':
    'The requested working directory is invalid: {requested} → starting in {fallback} instead',
  'terminal.cwd.invalidFallbackToProcessDefault':
    'Working directory is invalid: {requested} → starting in the process default {fallback} instead',


  // ---------- Terminal context menu (Issue #356) ----------
  'terminal.ctxMenu.paste': 'Paste',
  'terminal.ctxMenu.copySelection': 'Copy selection',
  'terminal.ctxMenu.clear': 'Clear terminal',


  // ---------- Command palette (Issue #39) ----------
  'palette.ariaLabel': 'Command palette',
  'palette.placeholder': 'Search commands…',
  'palette.hint': '↑↓ to select · Enter to run · Esc to close',
  'palette.count': '{count}',
  'palette.empty': 'No matching commands',


  // ---------- Canvas QuickNav (Issue #58) ----------
  'quicknav.placeholder': 'Jump to agent / card …',
  'quicknav.empty': 'No matching cards.',
  'quicknav.hintNavigate': '↑↓ navigate',
  'quicknav.hintJump': 'Enter jump',
  'quicknav.hintClose': 'Esc close',


  // ---------- Command palette entries (Issue #57) ----------
  'cmd.cat.project': 'Project',
  'cmd.cat.workspace': 'Workspace',
  'cmd.cat.view': 'View',
  'cmd.cat.tab': 'Tab',
  'cmd.cat.git': 'Git',
  'cmd.cat.sessions': 'Sessions',
  'cmd.cat.terminal': 'Terminal',
  'cmd.cat.settings': 'Settings',
  'cmd.cat.theme': 'Theme',
  'cmd.project.new': 'New project…',
  'cmd.project.openFolder': 'Open folder…',
  'cmd.project.openFile': 'Open file…',
  'cmd.workspace.addFolder': 'Add folder to workspace…',
  'cmd.project.recent': 'Recent: {name}',
  'cmd.view.sidebarChanges': 'Sidebar: Changes',
  'cmd.view.sidebarSessions': 'Sidebar: History',
  'cmd.view.nextTab': 'Next tab',
  'cmd.view.prevTab': 'Previous tab',
  'cmd.tab.close': 'Close active tab',
  'cmd.tab.reopen': 'Reopen last closed tab',
  'cmd.tab.togglePin': 'Toggle pin on active tab',
  'cmd.git.refresh': 'Refresh changed files',
  'cmd.sessions.refresh': 'Refresh session history',
  'cmd.terminal.addClaude': 'Add Claude Code tab',
  'cmd.terminal.addCodex': 'Add Codex tab',
  'cmd.terminal.closeTab': 'Close active terminal tab',
  'cmd.terminal.restart': 'Restart terminal',


  // ---------- Terminal pane (exit handling) ----------
  'terminal.exited': 'exited',
  'terminal.exitedTitle': 'Process has exited',
  'terminal.exitedBanner': 'Process exited ({status})',
  'customAgent.warn.args': 'Custom agent args have parse warnings (unterminated quote / special dash). Please check the settings.',
  'customAgent.warn.modelOverride': 'Launching with explicit model ({model}); if it is unavailable on your plan, claude may loop on API errors.',
  'terminal.apiErrorHint': 'Repeated API errors detected. The launched model may be unavailable on your plan — switch to a standard model with /model.',
  'terminal.status.starting': 'Starting {command}…',
  'terminal.status.running': 'Running: {command}',
  'terminal.status.exited': 'Exited (exitCode={exitCode})',
  'terminal.status.spawnFailed': 'Start failed: {error}',
  'terminal.status.reconnect': 'Reconnected: {command}',
  'terminal.status.reconnectRestored': 'Reconnected (restored output): {command}',
  'terminal.status.exception': 'Exception: {error}',
  'terminal.limitReached': 'Terminal limit reached ({max})',
  'terminal.limitWarning': 'Terminal count reached {threshold} (limit {max})',
  'terminal.restart': 'Restart',
  'terminal.closeTab': 'Close',
  'layout.sidebarResizeTitle': 'Drag to resize the sidebar / double-click to reset',
  'layout.idePanelResizeTitle': 'Drag to resize the IDE mode panel',
  'cmd.settings.open': 'Open settings',
  'cmd.settings.cycleDensity': 'Cycle density',
  'cmd.settings.cycleDensitySub': 'Current: {density}',
  'cmd.theme.title': 'Theme: {name}',
  'cmd.theme.current': '✓ current theme',
  'cmd.cat.app': 'App',
  'cmd.app.restart': 'Restart vibe-editor',


  // ---------- Updater (Issue #59) ----------
  'updater.confirm': 'vibe-editor v{version} is available. Install it now?',
  'updater.upToDate': 'You are on the latest version',
  'updater.checkFailed': 'Failed to check for updates: {error}',
  'updater.dialogFailed': 'Failed to show update dialog: {error}',
  'updater.downloading': 'Downloading update…',
  'updater.downloadProgress': 'Downloading… {pct}%',
  'updater.installing': 'Installing… The app will restart when finished',
  'updater.downloadFailed': 'Download failed: {error}',
  'updater.relaunchFailed': 'Relaunch failed ({error}). Please restart manually',
  'updater.runningTasksWarning': '{count} agent(s) are still running and will be interrupted',
  'updater.checkNow': 'Check for updates',
  'updater.button.label': 'Update v{version}',
  'updater.button.title': 'A new version v{version} is available. Click to install',
  // Issue #609: minisign signature failure warning (shown at most once per 24h)
  'updater.signatureFailed':
    'Update signature verification failed. The download may have been tampered with or routed through a faulty mirror. Please wait for the next update.',


  // ---------- Toast tone labels (Issue #80) ----------
  'toast.tone.info': 'Info',
  'toast.tone.success': 'Success',
  'toast.tone.warning': 'Warning',
  'toast.tone.error': 'Error',


  // ---------- Terminal tab restore (Issue #857) ----------
  'terminalTabs.restore.transcriptMissing':
    "Couldn't find past transcripts; restarted {count} tab(s) as new conversations.",
  'terminalTabs.saveFailed': 'Stopped saving terminal tabs: {error}',

  'status.noProject': 'No project selected',


  // ---------- Image preview ----------
  'imagePreview.devUnavailable': 'Image preview is unavailable in dev:vite mode.',
  'imagePreview.loadError': 'Unable to display image: {path}',

};
