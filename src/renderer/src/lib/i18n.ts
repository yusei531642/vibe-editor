import type { Language } from '../../../types/shared';
import { useSettings } from './settings-context';

/**
 * フラットキー方式の軽量 i18n。
 * `{param}` 形式のパラメータ置換を最低限サポート。
 */
type Dict = Record<string, string>;

const ja: Dict = {
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
  'appMenu.recent': '最近のプロジェクト',
  'appMenu.clear': 'クリア',
  'appMenu.empty': '履歴なし',

  // ---------- Sidebar ----------
  'sidebar.changes': '変更',
  'sidebar.history': '履歴',
  'sidebar.loading': '読み込み中…',
  'sidebar.notGitRepo': 'Git リポジトリではありません',
  'sidebar.noChanges': '変更なし',
  'sidebar.noSessions': 'このプロジェクトのセッション履歴はまだありません',
  'sidebar.filesChanged': '{count} 変更',
  'sidebar.sessionCount': '{count} セッション',
  'sidebar.refresh': '更新',

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
  'claudePanel.notFound.installLink': 'Claude Code をインストール',
  'claudePanel.notFound.retry': '再検出',
  'claudePanel.notFound.settings': '設定で指定',
  'claudePanel.checking': '確認中…',

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
  'appMenu.recent': 'Recent projects',
  'appMenu.clear': 'Clear',
  'appMenu.empty': 'No history',

  // ---------- Sidebar ----------
  'sidebar.changes': 'Changes',
  'sidebar.history': 'History',
  'sidebar.loading': 'Loading…',
  'sidebar.notGitRepo': 'Not a git repository',
  'sidebar.noChanges': 'No changes',
  'sidebar.noSessions': 'No session history for this project yet',
  'sidebar.filesChanged': '{count} changed',
  'sidebar.sessionCount': '{count} sessions',
  'sidebar.refresh': 'Refresh',

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
  'claudePanel.notFound.installLink': 'Install Claude Code',
  'claudePanel.notFound.retry': 'Retry detection',
  'claudePanel.notFound.settings': 'Open settings',
  'claudePanel.checking': 'Checking…',

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
