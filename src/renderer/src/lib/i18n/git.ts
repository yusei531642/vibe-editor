/* eslint-disable no-restricted-syntax -- i18n辞書本体のため、日本語文字列リテラルをここに集約する */
import type { Dict } from './index';

// ファイルツリー・diff・コンテキストメニュー辞書。公開キーは aggregator で既存 i18n API に統合される。

export const gitJa: Dict = {

  'filetree.refresh': '再読込',
  'filetree.treeLabel': 'ファイルツリー',
  'diff.loading': 'diff を読み込み中…',
  'diff.selectFile': '差分を表示するファイルを選択してください',
  'diff.error': 'エラー: {error}',
  'diff.binary': 'バイナリファイルは diff 表示できません: {path}',
  'diff.new': '(新規追加)',
  'diff.deleted': '(削除)',
  'diff.toggleMode': '差分表示モード切替',
  'diff.toggleInline': 'インラインに切替',
  'diff.toggleSideBySide': 'サイドバイサイドに切替',
  'ctxMenu.openDiff': '差分を開く',
  'ctxMenu.reviewDiff': '差分レビューを Claude Code に依頼',
  'ctxMenu.copyPath': 'パスをコピー',
  // Issue #251: ファイルツリー右クリックメニュー
  'ctxMenu.copyAbsolutePath': '絶対パスをコピー',
  'ctxMenu.copyRelativePath': '相対パスをコピー',
  'ctxMenu.copyFileName': 'ファイル名をコピー',
  'ctxMenu.revealInFolder': 'エクスプローラーで開く',
  // Issue #592: VS Code 互換のファイル/フォルダ操作
  'ctxMenu.newFile': '新しいファイル',
  'ctxMenu.newFolder': '新しいフォルダ',
  'ctxMenu.rename': '名前の変更',
  'ctxMenu.delete': '削除',
  'ctxMenu.cut': '切り取り',
  'ctxMenu.copy': 'コピー',
  'ctxMenu.paste': '貼り付け',
  'ctxMenu.duplicate': '複製を作成',
  'filetree.prompt.newFileName': '新しいファイル名',
  'filetree.prompt.newFolderName': '新しいフォルダ名',
  'filetree.prompt.renameTo': '新しい名前',
  'filetree.confirmDeleteFile': '"{name}" をゴミ箱に移動しますか？',
  'filetree.confirmDeleteFolder': '"{name}" とその中身をすべてゴミ箱に移動しますか？',
  'filetree.confirmDeletePermanent': '"{name}" を完全に削除しますか？この操作は元に戻せません。',
  'filetree.preloadRestartRequired': 'アプリを再起動してください（preload 更新のため）',
  'claudePanel.title': 'IDEモード',
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
  'claudePanel.addClaude': 'Claude Code を追加',
  'claudePanel.addCodex': 'Codex を追加',

  // ---------- Team ----------

};

export const gitEn: Dict = {

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

  // ---------- Team ----------

};
