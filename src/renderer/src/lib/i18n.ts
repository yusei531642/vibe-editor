import type { Language } from '../../../types/shared';
import { useSettings } from './settings-context';

/**
 * フラットキー方式の軽量 i18n。
 * `{param}` 形式のパラメータ置換を最低限サポート。
 */
type Dict = Record<string, string>;

const ja: Dict = {
  // ---------- Common ----------
  'common.close': '閉じる',

  // ---------- Toolbar ----------
  'toolbar.restart.title': 'アプリを再起動',
  'toolbar.palette.title': 'コマンドパレット (Ctrl+Shift+P)',
  'toolbar.settings.title': '設定 (Ctrl+,)',

  // ---------- AppMenu ----------
  'appMenu.title': 'プロジェクトメニュー',
  'appMenu.new': '新規プロジェクト…',
  'appMenu.newHint': '空フォルダを作成/選択',
  'appMenu.openFolder': 'フォルダを開く…',
  'appMenu.openFolderHint': '既存のプロジェクト',
  'appMenu.openFile': 'ファイルを開く…',
  'appMenu.openFileHint': '単独ファイル',
  'appMenu.addToWorkspace': 'フォルダをワークスペースに追加…',
  'appMenu.addToWorkspaceHint': 'サイドバーに別ルートを並べる',
  'appMenu.recent': '最近のプロジェクト',
  'appMenu.recentCount': '{count} 件の履歴',
  'appMenu.workspace': 'ワークスペース',
  'appMenu.clear': 'クリア',
  'appMenu.empty': '履歴なし',
  // ---------- UserMenu (サイドバー左下) ----------
  'userMenu.settings': '設定',
  'userMenu.language': '言語',
  'userMenu.theme': 'テーマ',
  'userMenu.releases': 'GitHub でリリースを見る',
  // ---------- ワークスペース (Issue #4) ----------
  'workspace.roots': 'ワークスペース',
  'workspace.add': 'フォルダを追加',
  'workspace.remove': 'ワークスペースから外す',
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
  'teamHistory.resume': 'チーム「{name}」を復元',
  'teamHistory.resumed': 'チーム「{name}」を復元しました',
  'teamHistory.delete': '履歴から削除',

  // ---------- File tree / Editor ----------
  'filetree.refresh': '再読込',
  'editor.loading': 'ファイルを読み込み中…',
  'editor.save': '保存 (Ctrl+S)',
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
  'ctxMenu.openDiff': '差分を開く',
  'ctxMenu.reviewDiff': '差分レビューを Claude Code に依頼',
  'ctxMenu.copyPath': 'パスをコピー',

  // ---------- Claude Code panel ----------
  'claudePanel.title': 'Claude Code',
  'claudePanel.starting': '起動待ち',
  'claudePanel.running': '実行中',
  'claudePanel.exited': '終了',
  'claudePanel.restartTitle': 'ターミナルを再起動',
  'claudePanel.notFound.title': 'Claude Code が見つかりません',
  'claudePanel.notFound.body':
    '`claude` コマンドが PATH 上に見つかりませんでした。Claude Code をインストールするか、設定で起動コマンドのパスを指定してください。',
  'claudePanel.notFound.step1Title': 'CLI をインストール',
  'claudePanel.notFound.step1Desc': '`claude` コマンドがターミナルから実行できる状態にします。',
  'claudePanel.notFound.step2Title': '設定を確認',
  'claudePanel.notFound.step2Desc': 'カスタムコマンドを使う場合は Settings から起動コマンドを見直します。',
  'claudePanel.notFound.installLink': 'Claude Code をインストール',
  'claudePanel.notFound.retry': '再検出',
  'claudePanel.notFound.settings': '設定で指定',
  'claudePanel.checking': '確認中…',
  'claudePanel.newTab': '新しいターミナルタブ',
  'claudePanel.closeTab': 'タブを閉じる',
  'claudePanel.tabLimit': '上限に達しています（最大{max}）',
  'claudePanel.addClaude': 'Claude Code を追加',
  'claudePanel.addCodex': 'Codex を追加',
  'claudePanel.createTeam': 'Team を作成…',

  // ---------- Team ----------
  'team.title': 'Team を作成',
  'team.presets': 'プリセット',
  'team.custom': 'カスタム',
  'team.members': 'メンバー',
  'team.addMember': 'メンバーを追加',
  'team.removeMember': '削除',
  'team.saveAsPreset': 'プリセットとして保存',
  'team.presetName': 'プリセット名',
  'team.teamNamePlaceholder': '例: Feature X',
  'team.deletePreset': 'プリセットを削除',
  'team.editPreset': 'プリセットを編集',
  'team.updatePreset': 'プリセットを上書き保存',
  'team.savePreset': '保存',
  'team.cancelEdit': '編集をキャンセル',
  'team.create': '作成',
  'team.remaining': '残り {count} タブ作成可能',
  'team.tooMany': '{need} タブ必要（残り {remaining}）',
  'team.closeTeamConfirm': 'これはチームリーダーです。チーム全体を閉じますか？',
  'team.closeTeam': 'チームを閉じる',
  'team.closeLeaderOnly': 'リーダーのみ閉じる',
  'team.teamLabel': 'チーム: {name}',
  'team.defaultName': 'チーム',

  // ---------- Canvas ----------
  'canvas.add': '追加',
  'canvas.spawnTeam': 'チーム起動',
  'canvas.preset': 'プリセット',
  'canvas.recent': '最近使ったチーム',
  'canvas.panels': 'パネル',
  'canvas.customTeam': 'カスタムチームを作成…',
  'canvas.savedPresets': '保存済みプリセット',
  'canvas.noRecentTeams': 'まだ保存されたチームがありません。プリセットから起動してください。',
  'canvas.clear': 'クリア',
  'canvas.clearConfirm': 'Canvas 上のカードをすべて削除しますか？',
  'canvas.switchToIde': 'IDE モードに戻る',
  'canvas.modeToggle': 'Canvas モードに切り替え',
  'canvas.modeToggleShortcut': 'Canvas モードに切り替え (Ctrl+Shift+M)',
  'canvas.add.claude': 'Claude Code',
  'canvas.add.codex': 'Codex',
  'canvas.add.fileTree': 'ファイルツリー',
  'canvas.add.gitChanges': 'Git 変更',
  'canvas.add.emptyEditor': 'エディタ（空）',
  'canvas.card.editor': 'エディタ',
  'canvas.lastUsed': '最終使用: {value}',
  'canvas.deletePreset': 'プリセットを削除',
  'canvas.deletePresetConfirm': 'プリセット「{name}」を削除しますか？',

  // ---------- Agent Card ----------
  'agentCard.close': 'カードを閉じる',
  'agentStatus.idle': '待機中',
  'agentStatus.thinking': '思考中',
  'agentStatus.typing': '応答中',

  // ---------- Sessions ----------
  'sessions.resume': 'セッション {id} に戻る',
  'sessions.messages': '{count} 件',

  // ---------- Roles ----------
  'role.leader': 'Leader',
  'role.planner': 'Planner',
  'role.programmer': 'Programmer',
  'role.researcher': 'Researcher',
  'role.reviewer': 'Reviewer',

  // ---------- Settings ----------
  'settings.title': '設定',
  'settings.language': '言語',
  'settings.language.desc':
    'UI 表示言語を切り替え。Claude Code 自体の応答言語には影響しません。',
  'settings.theme': 'テーマ',
  'settings.uiFont': 'UI フォント',
  'settings.uiFontFamily': 'フォントファミリ',
  'settings.uiFontSize': 'サイズ (px)',
  'settings.uiFontCustom': 'カスタム CSS font-family',
  'settings.editorFont': 'エディタフォント (Monaco)',
  'settings.editorFontFamily': 'フォントファミリ',
  'settings.editorFontSize': 'サイズ (px)',
  'settings.editorFontCustom': 'カスタム CSS font-family',
  'settings.terminal': 'ターミナル',
  'settings.terminalFontSize': 'フォントサイズ (px)',
  'settings.terminalNote':
    'ターミナルフォントファミリはエディタフォントと同じものを使用します。',
  'settings.density': '情報密度',
  'settings.density.compact': 'Compact',
  'settings.density.compactDesc': '14"以下の画面向け、余白小',
  'settings.density.normal': 'Normal',
  'settings.density.normalDesc': '既定',
  'settings.density.comfortable': 'Comfortable',
  'settings.density.comfortableDesc': '大画面向け、ゆったり',
  'settings.claudeLaunch': 'Claude Code 起動オプション',
  'settings.claudeLaunch.command': 'コマンド',
  'settings.claudeLaunch.args': '引数（空白区切り、ダブルクォートで空白を含む値）',
  'settings.claudeLaunch.cwd': '作業ディレクトリ（空ならプロジェクトルート）',
  'settings.claudeLaunch.note':
    '変更後は右パネルの再起動ボタンでターミナルを再起動すると反映されます。',
  'settings.reset': 'デフォルトに戻す',
  'settings.cancel': 'キャンセル',
  'settings.apply': '適用して保存',
  'settings.custom': '（カスタム）',

  // ---------- Toast ----------
  'toast.reviewRequested': '差分レビューを依頼: {path}',
  'toast.pathCopied': 'パスをクリップボードにコピー',
  'toast.sessionResumed': 'セッションに復帰: {title}',
  'toast.recentCleared': '最近のプロジェクト履歴をクリアしました',
  'toast.newProject': '新規プロジェクトを作成',
  'toast.notEmpty': 'フォルダが空ではありません。既存として開きます',
  'toast.openedFile': '{file} の親フォルダをプロジェクトとして読み込みました',
  'toast.terminalNotReady': 'ターミナルが起動していません',

  // ---------- Status ----------
  'status.loaded': '読み込み完了',
  'status.loading': 'プロジェクト読み込み中…',
  'status.templateInserted': 'テンプレートを挿入しました（まだ保存されていません）',
  'status.initError': '初期化エラー: {err}',
  'status.loadError': '読み込みエラー: {err}'
};

const en: Dict = {
  // ---------- Common ----------
  'common.close': 'Close',

  // ---------- Toolbar ----------
  'toolbar.restart.title': 'Restart app',
  'toolbar.palette.title': 'Command palette (Ctrl+Shift+P)',
  'toolbar.settings.title': 'Settings (Ctrl+,)',

  // ---------- AppMenu ----------
  'appMenu.title': 'Project menu',
  'appMenu.new': 'New project…',
  'appMenu.newHint': 'Create or select empty folder',
  'appMenu.openFolder': 'Open folder…',
  'appMenu.openFolderHint': 'Existing project',
  'appMenu.openFile': 'Open file…',
  'appMenu.openFileHint': 'Single file',
  'appMenu.addToWorkspace': 'Add folder to workspace…',
  'appMenu.addToWorkspaceHint': 'Show another root in the sidebar',
  'appMenu.recent': 'Recent projects',
  'appMenu.recentCount': '{count} recent',
  'appMenu.workspace': 'Workspace',
  'appMenu.clear': 'Clear',
  'appMenu.empty': 'No history',
  // ---------- UserMenu (sidebar footer) ----------
  'userMenu.settings': 'Settings',
  'userMenu.language': 'Language',
  'userMenu.theme': 'Theme',
  'userMenu.releases': 'View releases on GitHub',
  // ---------- Workspace (Issue #4) ----------
  'workspace.roots': 'Workspace',
  'workspace.add': 'Add folder',
  'workspace.remove': 'Remove from workspace',
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
  'teamHistory.resume': 'Resume team "{name}"',
  'teamHistory.resumed': 'Resumed team "{name}"',
  'teamHistory.delete': 'Remove from history',

  // ---------- File tree / Editor ----------
  'filetree.refresh': 'Reload',
  'editor.loading': 'Loading file…',
  'editor.save': 'Save (Ctrl+S)',
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

  // ---------- Claude Code panel ----------
  'claudePanel.title': 'Claude Code',
  'claudePanel.starting': 'Waiting',
  'claudePanel.running': 'Running',
  'claudePanel.exited': 'Exited',
  'claudePanel.restartTitle': 'Restart terminal',
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
  'claudePanel.closeTab': 'Close tab',
  'claudePanel.tabLimit': 'Limit reached (max {max})',
  'claudePanel.addClaude': 'Add Claude Code',
  'claudePanel.addCodex': 'Add Codex',
  'claudePanel.createTeam': 'Create Team…',

  // ---------- Team ----------
  'team.title': 'Create Team',
  'team.presets': 'Presets',
  'team.custom': 'Custom',
  'team.members': 'members',
  'team.addMember': 'Add member',
  'team.removeMember': 'Remove',
  'team.saveAsPreset': 'Save as preset',
  'team.presetName': 'Preset name',
  'team.teamNamePlaceholder': 'e.g. Feature X',
  'team.deletePreset': 'Delete preset',
  'team.editPreset': 'Edit preset',
  'team.updatePreset': 'Update preset',
  'team.savePreset': 'Save',
  'team.cancelEdit': 'Cancel edit',
  'team.create': 'Create',
  'team.remaining': '{count} tabs remaining',
  'team.tooMany': 'Needs {need} tabs ({remaining} remaining)',
  'team.closeTeamConfirm': 'This is the team leader. Close entire team?',
  'team.closeTeam': 'Close Team',
  'team.closeLeaderOnly': 'Close Leader Only',
  'team.teamLabel': 'Team: {name}',
  'team.defaultName': 'Team',

  // ---------- Canvas ----------
  'canvas.add': 'Add',
  'canvas.spawnTeam': 'Spawn Team',
  'canvas.preset': 'Preset',
  'canvas.recent': 'Recent',
  'canvas.panels': 'Panels',
  'canvas.customTeam': 'Create custom team…',
  'canvas.savedPresets': 'Saved presets',
  'canvas.noRecentTeams': 'No saved teams yet. Start one from a preset.',
  'canvas.clear': 'Clear',
  'canvas.clearConfirm': 'Clear every card on the canvas?',
  'canvas.switchToIde': 'Switch to IDE mode',
  'canvas.modeToggle': 'Switch to Canvas mode',
  'canvas.modeToggleShortcut': 'Switch to Canvas mode (Ctrl+Shift+M)',
  'canvas.add.claude': 'Claude Code',
  'canvas.add.codex': 'Codex',
  'canvas.add.fileTree': 'File Tree',
  'canvas.add.gitChanges': 'Git Changes',
  'canvas.add.emptyEditor': 'Editor (empty)',
  'canvas.card.editor': 'Editor',
  'canvas.lastUsed': 'Last used: {value}',
  'canvas.deletePreset': 'Delete preset',
  'canvas.deletePresetConfirm': 'Delete preset "{name}"?',

  // ---------- Agent Card ----------
  'agentCard.close': 'Close card',
  'agentStatus.idle': 'Idle',
  'agentStatus.thinking': 'Thinking',
  'agentStatus.typing': 'Typing',

  // ---------- Sessions ----------
  'sessions.resume': 'Resume session {id}',
  'sessions.messages': '{count} msgs',

  // ---------- Roles ----------
  'role.leader': 'Leader',
  'role.planner': 'Planner',
  'role.programmer': 'Programmer',
  'role.researcher': 'Researcher',
  'role.reviewer': 'Reviewer',

  // ---------- Settings ----------
  'settings.title': 'Settings',
  'settings.language': 'Language',
  'settings.language.desc':
    'Switch the UI language. Does not affect the language Claude Code responds in.',
  'settings.theme': 'Theme',
  'settings.uiFont': 'UI font',
  'settings.uiFontFamily': 'Font family',
  'settings.uiFontSize': 'Size (px)',
  'settings.uiFontCustom': 'Custom CSS font-family',
  'settings.editorFont': 'Editor font (Monaco)',
  'settings.editorFontFamily': 'Font family',
  'settings.editorFontSize': 'Size (px)',
  'settings.editorFontCustom': 'Custom CSS font-family',
  'settings.terminal': 'Terminal',
  'settings.terminalFontSize': 'Font size (px)',
  'settings.terminalNote':
    'Terminal font family uses the same value as the editor font.',
  'settings.density': 'Density',
  'settings.density.compact': 'Compact',
  'settings.density.compactDesc': 'For 14" or smaller screens',
  'settings.density.normal': 'Normal',
  'settings.density.normalDesc': 'Default',
  'settings.density.comfortable': 'Comfortable',
  'settings.density.comfortableDesc': 'For large screens, roomy',
  'settings.claudeLaunch': 'Claude Code launch options',
  'settings.claudeLaunch.command': 'Command',
  'settings.claudeLaunch.args':
    'Arguments (space-separated, double-quote values with spaces)',
  'settings.claudeLaunch.cwd': 'Working directory (empty = project root)',
  'settings.claudeLaunch.note':
    'Restart the terminal from the right panel to apply changes.',
  'settings.reset': 'Reset to defaults',
  'settings.cancel': 'Cancel',
  'settings.apply': 'Apply & save',
  'settings.custom': '(custom)',

  // ---------- Toast ----------
  'toast.reviewRequested': 'Review requested: {path}',
  'toast.pathCopied': 'Path copied to clipboard',
  'toast.sessionResumed': 'Resumed session: {title}',
  'toast.recentCleared': 'Recent projects cleared',
  'toast.newProject': 'New project created',
  'toast.notEmpty': 'Folder is not empty. Opening as existing project',
  'toast.openedFile': 'Loaded parent folder of {file} as project',
  'toast.terminalNotReady': 'Terminal is not ready',

  // ---------- Status ----------
  'status.loaded': 'Loaded',
  'status.loading': 'Loading project…',
  'status.templateInserted': 'Template inserted (not saved yet)',
  'status.initError': 'Init error: {err}',
  'status.loadError': 'Load error: {err}'
};

const translations: Record<Language, Dict> = { ja, en };

/**
 * React フック: 現在の言語設定に基づいた翻訳関数を返す。
 *
 * ```
 * const t = useT();
 * t('sidebar.changes');                    // "変更" or "Changes"
 * t('sidebar.filesChanged', { count: 3 }); // "3 変更" or "3 changed"
 * ```
 */
export function useT(): (key: string, params?: Record<string, string | number>) => string {
  const { settings } = useSettings();
  const lang = settings.language ?? 'ja';
  return (key: string, params?: Record<string, string | number>): string => {
    const text = translations[lang]?.[key] ?? translations.ja[key] ?? key;
    if (!params) return text;
    return Object.entries(params).reduce(
      (acc, [k, v]) => acc.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v)),
      text
    );
  };
}
