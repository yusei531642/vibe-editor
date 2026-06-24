import type { Dict } from './index';

// 共通シェル・プロジェクト・エディタ・オンボーディング辞書。公開キーは aggregator で既存 i18n API に統合される。

export const commonJa: Dict = {

  'common.close': '閉じる',
  'common.cancel': 'キャンセル',

  // ---------- Toolbar ----------
  'toolbar.restart.title': 'アプリを再起動',
  'toolbar.palette.title': 'コマンドパレット (Ctrl+Shift+P)',
  'toolbar.settings.title': '設定 (Ctrl+,)',

  // ---------- Window controls (Issue #260 PR-2: カスタムタイトルバー) ----------
  'windowControls.minimize': '最小化',
  'windowControls.maximize': '最大化',
  'windowControls.restore': '元のサイズに戻す',
  'windowControls.close': '閉じる',
  'windowControls.group': 'ウィンドウ操作',

  // ---------- Topbar (redesign shell) ----------
  'topbar.mode.canvas': 'Canvas',

  // ---------- Status bar ----------
  'status.branch': 'ブランチ',
  'status.changes': '変更',
  'status.lang': '言語',
  'status.theme': 'テーマ',
  'status.mascot.idle': '待機中',
  'status.mascot.sleep': 'おやすみ中…',
  'status.mascot.working': 'エージェント実行中',
  'status.mascot.thinking': '応答待ち',
  'status.mascot.done': '完了!',
  'status.mascot.error': '対応が必要',
  'status.mascot.excited': 'やる気!',

  // ---------- Mascot section (SettingsModal の「キャラクター」セクション) ----------
  // Issue #729: MascotSection の isJa 三項 / settings-options.ts hardcode を i18n.ts に集約
  'appMenu.title': 'プロジェクトメニュー',
  'appMenu.new': '新規プロジェクト…',
  'appMenu.newHint': '空フォルダを作成/選択',
  'appMenu.openFolder': 'フォルダを開く…',
  'appMenu.openFolderHint': '既存のプロジェクト',
  'appMenu.openFile': 'ファイルを開く…',
  'appMenu.openFileHint': '単独ファイル',
  'appMenu.newDialogTitle': '新規プロジェクト',
  'appMenu.openFolderDialogTitle': 'フォルダを開く',
  'appMenu.openFileDialogTitle': 'ファイルを開く',
  'project.newDialogTitle': '新規プロジェクト: 空フォルダを選択/作成',
  'project.openExistingDialogTitle': '既存プロジェクトを開く',
  'project.loading': 'プロジェクト読み込み中…',
  'project.loadError': '読み込みエラー: {error}',
  'project.initError': '初期化エラー: {error}',
  'project.newFolderNotEmpty': 'フォルダが空ではありません。既存として開きます',
  'project.created': '新規プロジェクトを作成',
  'project.fileParentLoaded': '{file} の親フォルダをプロジェクトとして読み込みました',
  'project.recentCleared': '最近のプロジェクト履歴をクリアしました',
  'appMenu.addWorkspaceDialogTitle': 'ワークスペースに追加',
  'appMenu.addToWorkspace': 'フォルダをワークスペースに追加…',
  'appMenu.addToWorkspaceHint': 'サイドバーに別ルートを並べる',
  'appMenu.recent': '最近のプロジェクト',
  'appMenu.recentCount': '{count} 件の履歴',
  'appMenu.workspace': 'ワークスペース',
  'appMenu.clear': 'クリア',
  'appMenu.empty': '履歴なし',
  'menubar.file': 'ファイル',
  'menubar.view': '表示',
  'menubar.help': 'ヘルプ',
  'menubar.toggleSidebar': 'サイドバーを切替',
  'menubar.toggleCanvas': 'IDE / Canvas を切替',
  'menubar.openPalette': 'コマンドパレット',
  'menubar.openSettings': '設定…',
  'menubar.openGithub': 'GitHub で開く',
  'menubar.restart': '再起動',
  // ---------- UserMenu (サイドバー左下) ----------
  'userMenu.settings': '設定',
  'userMenu.language': '言語',
  'userMenu.theme': 'テーマ',
  'userMenu.releases': 'GitHub でリリースを見る',
  // ---------- ワークスペース (Issue #4) ----------
  'workspace.roots': 'ワークスペース',
  'workspace.add': 'フォルダを追加',
  'workspace.remove': 'ワークスペースから外す',
  'workspace.removePrimaryConfirm': '{name} を現在のプロジェクトから外します。よろしいですか？',
  'workspace.removed': '{name} をワークスペースから外しました',
  'workspace.added': '{name} をワークスペースに追加しました',
  'workspace.alreadyAdded': '{name} は既に追加されています',

  // ---------- Sidebar ----------
  'sidebar.files': 'ファイル',
  'sidebar.changes': '変更',
  'sidebar.history': '履歴',
  'sidebar.loading': '読み込み中…',
  'sidebar.notGitRepo': 'Git リポジトリではありません',
  'sidebar.noChanges': '変更なし',
  'sidebar.noSessions': 'このプロジェクトのセッション履歴はまだありません',
  'sidebar.filesChanged': '{count} 変更',
  'sidebar.sessionCount': '{count} セッション',
  'sidebar.refresh': '更新',
  'sidebar.teams': 'チーム',
  'sidebar.singleSessions': '個別セッション',
  'sidebar.notes': 'メモ',
  'rail.primaryNav': 'メインナビゲーション',

  // ---------- Notes (Issue #17) ----------
  'notes.title': 'メモ',
  'notes.placeholder': 'ターミナル間で受け渡したい内容を書き留めてください…\n自動保存されます。',
  'notes.copy': 'クリップボードにコピー',
  'notes.clear': 'メモをクリア',
  'notes.copied': 'メモをコピーしました',
  'notes.copyFailed': 'コピーに失敗しました',
  'notes.confirmClear': 'メモをクリアしますか？',
  'notes.autoSaved': '自動保存済み',
  'notes.chars': '文字',

  // ---------- Team history ----------
  'editor.loading': 'ファイルを読み込み中…',
  'editor.save': '保存 (Ctrl+S)',
  'editor.save.ariaLabel': '保存',
  'editor.viewPreview': 'プレビュー表示',
  'editor.viewSource': 'ソース表示',
  'editor.binaryNotice': 'バイナリファイルは編集できません: {path}',
  'editor.nonUtf8Warning':
    '非 UTF-8 として読み込みました ({path}) — 保存すると元のエンコーディングを失うため編集不可にしています。',
  'editor.nonUtf8SaveBlocked': '保存は無効化されています (非 UTF-8): {path}',
  'editor.nonUtf8ReadOnly': '読み取り専用 (非 UTF-8)',
  'editor.externalChangeConfirm':
    '{path} は開いた後にディスク上で更新されています。このまま保存すると外部の変更を上書きします。続行しますか?',
  'editor.saveAborted': '保存を中止しました: {path}',
  'editor.saved': '保存しました: {path}',
  'editor.saveFailed': '保存失敗: {error}',
  'editor.discardSingle': '未保存の変更があります。このファイルを閉じますか？\n\n{path}',
  'editor.discardMultiple': '未保存の変更があります。このまま切り替えると {count} 個のファイルの変更が失われます。続行しますか？',
  'editor.restartConfirm': '未保存の変更があります。このままアプリを再起動すると変更が失われます。続行しますか？',
  // Issue #595: Canvas 上の EditorCard を × / Clear で閉じる際に未保存編集を確認するダイアログ。
  'editor.confirmDiscardChanges':
    '未保存の編集が残っています。このカードを閉じると編集内容は失われます。続行しますか？\n\n{path}',
  'editor.confirmDiscardChangesPlural':
    '未保存の編集が {count} 件残っています。これらのカードを閉じると編集内容はすべて失われます。続行しますか？\n\n{paths}',

  // ---------- Welcome ----------
  'welcome.subtitle': 'vibe coding with Claude Code',
  'welcome.hint1Key': '右',
  'welcome.hint1Text': 'のターミナルで Claude Code に話しかける',
  'welcome.hint2Key': '変更',
  'welcome.hint2Text': 'タブから Claude が触ったファイルの diff を確認',
  'welcome.hint3Key': '履歴',
  'welcome.hint3Text': 'タブから過去のセッションに復帰',
  'welcome.hint4Text': 'でコマンドパレット',

  // ---------- Context menu ----------
  'welcome.title': '静かな集中で、すばやく進める。',
  'welcome.recentProjects': '最近のプロジェクト',
  'welcome.recentProjectsTitle': 'すぐに戻れる作業面',
  'welcome.workspaceLabel': 'ワークスペース',
  'welcome.quickStart': 'クイックスタート',
  'welcome.quickStartTitle': 'よく使う操作',
  // Issue #729: canvas-layout-helpers の language ベース hardcode を i18n.ts に移管
  'common.show': '表示',
  'common.hide': '隠す',
  'common.saving': '保存中…',
  'common.systemDefault': 'システム既定',
  'status.noProject': 'プロジェクトが選択されていません',

  // ---------- Image preview ----------
  'imagePreview.devUnavailable': 'dev:vite モードでは画像プレビューを利用できません。',
  'imagePreview.loadError': '画像を表示できません: {path}',

  // ---------- Team history ----------
  'onboarding.back': '戻る',
  'onboarding.next': '次へ',
  'onboarding.skip': 'あとでにする',
  'onboarding.replay': 'セットアップをもう一度',
  'onboarding.ariaLabel': 'vibe-editor セットアップ',
  'onboarding.welcome.eyebrow': 'vibe-editor',
  'onboarding.welcome.title': '静かな集中の、新しい入口。',
  'onboarding.welcome.subtitle':
    'Claude Code と Codex のための、穏やかな IDE。数ステップだけ、ご一緒させてください。',
  'onboarding.welcome.cta': 'はじめる',
  'onboarding.appearance.eyebrow': 'Appearance',
  'onboarding.appearance.title': '見た目を選ぶ',
  'onboarding.appearance.subtitle': '言語とテーマは、あとで設定からいつでも変えられます。',
  'onboarding.appearance.language': '言語',
  'onboarding.appearance.theme': 'テーマ',
  'onboarding.workspace.eyebrow': 'Workspace',
  'onboarding.workspace.title': '最初のフォルダを開く',
  'onboarding.workspace.subtitle':
    'プロジェクトの場所を選ぶと、次回以降も自動で開きます。あとから追加してもかまいません。',
  'onboarding.workspace.choose': 'フォルダを選ぶ',
  'onboarding.workspace.change': '別のフォルダを選ぶ',
  'onboarding.workspace.clear': '選択したフォルダをクリア',
  'onboarding.done.eyebrow': 'Ready',
  'onboarding.done.title': '準備ができました',
  'onboarding.done.subtitle': '落ち着いた画面で、今日の一行を書きはじめましょう。',
  'onboarding.done.summaryLanguage': '言語',
  'onboarding.done.summaryTheme': 'テーマ',
  'onboarding.done.summaryFolder': 'フォルダ',
  'onboarding.done.summaryFolderNone': 'あとで開く',
  'onboarding.done.cta': 'エディタを開く'

};

export const commonEn: Dict = {

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

  // ---------- Mascot section (SettingsModal "Character" section) ----------
  // Issue #729: MascotSection isJa ternaries / settings-options.ts hardcode -> centralised in i18n.ts
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

  // ---------- Team history ----------
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
  'welcome.title': 'Build with calm momentum.',
  'welcome.recentProjects': 'Recent projects',
  'welcome.recentProjectsTitle': 'Jump back into your flow',
  'welcome.workspaceLabel': 'Workspace',
  'welcome.quickStart': 'Quick start',
  'welcome.quickStartTitle': 'What you can do next',
  // Issue #729: canvas-layout-helpers language-based hardcode moved into i18n.ts
  'common.show': 'Show',
  'common.hide': 'Hide',
  'common.saving': 'Saving…',
  'common.systemDefault': 'System default',
  'status.noProject': 'No project selected',

  // ---------- Image preview ----------
  'imagePreview.devUnavailable': 'Image preview is unavailable in dev:vite mode.',
  'imagePreview.loadError': 'Unable to display image: {path}',

  // ---------- Team history ----------
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
  'onboarding.done.cta': 'Open editor'

};
