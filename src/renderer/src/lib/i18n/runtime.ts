/* eslint-disable no-restricted-syntax -- i18n辞書本体のため、日本語文字列リテラルをここに集約する */
import type { Dict } from './index';

// コマンドパレット・ターミナル・通知・アップデーター辞書。公開キーは aggregator で既存 i18n API に統合される。

export const runtimeJa: Dict = {

  'sessions.resume': 'セッション {id} に戻る',
  'sessions.messages': '{count} 件',
  // Issue #837: messageCount が走査上限で打ち切られたときの "N+" 表示。
  'sessions.messagesCapped': '{count}+ 件',
  'sessions.loadMore': '残り {remaining} 件を表示',

  // ---------- Tab ----------
  'tab.pinned': 'ピン留め中',
  'tab.newOutput': '新しい出力',
  'tab.pin': 'ピン留め',
  'tab.unpin': 'ピンを外す',
  'tab.close': 'タブを閉じる',
  'tab.closeWithShortcut': '閉じる (Ctrl+W)',
  'toast.reviewRequested': '差分レビューを依頼: {path}',
  'toast.sessionResumed': 'セッションに復帰: {title}',
  'toast.pathCopied': 'パスをクリップボードにコピー',
  'toast.copyFailed': 'クリップボードへのコピーに失敗しました',
  'toast.revealFailed': 'ファイルマネージャでの表示に失敗しました',
  // Issue #592: ファイル操作のフィードバック
  'toast.fileCreated': '"{name}" を作成しました',
  'toast.folderCreated': 'フォルダ "{name}" を作成しました',
  'toast.fileRenamed': '"{from}" を "{to}" にリネームしました',
  'toast.fileDeleted': '"{name}" を削除しました',
  'toast.fileCopied': '"{name}" をコピーしました',
  'toast.fileMoved': '"{name}" を移動しました',
  'toast.fileOpFailed': 'ファイル操作に失敗しました: {error}',
  'toast.fileOpClipboardEmpty': 'クリップボードに対象がありません',
  'toast.terminalNotReady': 'ターミナルが起動していません',
  'toast.settings.loadFailed':
    '設定ファイルを読み込めなかったため、この起動中は設定の自動保存を停止しました: {error}',
  'toast.settings.saveBlocked':
    '設定ファイルを読み込めなかったため、設定の保存を停止しています。アプリを再起動してください。',
  'toast.settings.saveFailed': '設定の保存に失敗しました: {error}',
  'toast.settings.projectRootFailed': 'プロジェクトルートの反映に失敗しました: {error}',
  // Issue #578: Canvas 非表示中に recruit が走った件数を可視化時に警告する
  'toast.recruitWhileHidden':
    'Canvas を非表示の間にメンバー採用が {count} 件走りました。失敗していたら再実行してください',
  'toast.recruitRescued': '採用 (遅着救済): {ms}ms 遅れて受領されました',

  // ---------- Terminal (pasteエラー等) ----------
  'terminal.pasteImageFailed': '画像保存失敗',
  'terminal.pasteException': 'ペースト例外',

  // ---------- Terminal cwd warning (Issue #818) ----------
  // Rust 側 `resolve_valid_cwd` が無効 cwd で fallback したとき、warning を
  // 日本語ハードコードせず i18n key + params で renderer に渡す (#729 取り残し対応)。
  // - `{requested}`: 指定された cwd (空文字なら下記 `*.unsetLabel` を埋める)
  // - `{fallback}` : フォールバック先 (project root か process default)
  'terminal.cwd.warningPrefix': '[警告]',
  'terminal.cwd.unsetLabel': '(未設定)',
  'terminal.cwd.invalidFallbackToHome':
    '指定された作業ディレクトリが無効です: {requested} → {fallback} で起動します',
  'terminal.cwd.invalidFallbackToProcessDefault':
    '作業ディレクトリが無効です: {requested} → プロセス既定の {fallback} で起動します',

  // ---------- Terminal context menu (Issue #356) ----------
  'terminal.ctxMenu.paste': '貼り付け',
  'terminal.ctxMenu.copySelection': '選択範囲をコピー',
  'terminal.ctxMenu.clear': 'ターミナルをクリア',

  // ---------- Command palette (Issue #39) ----------
  'palette.ariaLabel': 'コマンドパレット',
  'palette.placeholder': 'コマンドを検索…',
  'palette.hint': '↑↓ で選択 · Enter で実行 · Esc で閉じる',
  'palette.count': '{count} 件',
  'palette.empty': '一致するコマンドがありません',

  // ---------- Canvas QuickNav (Issue #58) ----------
  'cmd.cat.project': 'プロジェクト',
  'cmd.cat.workspace': 'ワークスペース',
  'cmd.cat.view': 'ビュー',
  'cmd.cat.tab': 'タブ',
  'cmd.cat.git': 'Git',
  'cmd.cat.sessions': 'セッション',
  'cmd.cat.terminal': 'ターミナル',
  'cmd.cat.settings': '設定',
  'cmd.cat.theme': 'テーマ',
  'cmd.project.new': '新規プロジェクト…',
  'cmd.project.openFolder': 'フォルダを開く…',
  'cmd.project.openFile': 'ファイルを開く…',
  'cmd.workspace.addFolder': 'フォルダをワークスペースに追加…',
  'cmd.project.recent': '最近: {name}',
  'cmd.view.sidebarChanges': 'サイドバー: 変更',
  'cmd.view.sidebarSessions': 'サイドバー: 履歴',
  'cmd.view.nextTab': '次のタブへ',
  'cmd.view.prevTab': '前のタブへ',
  'cmd.tab.close': 'アクティブなタブを閉じる',
  'cmd.tab.reopen': '最近閉じたタブを復元',
  'cmd.tab.togglePin': 'アクティブなタブをピン留め/解除',
  'cmd.git.refresh': '変更ファイル一覧を更新',
  'cmd.sessions.refresh': 'セッション履歴を更新',
  'cmd.terminal.addClaude': 'Claude Code タブを追加',
  'cmd.terminal.addCodex': 'Codex タブを追加',
  'cmd.terminal.closeTab': 'アクティブなターミナルタブを閉じる',
  'cmd.terminal.restart': 'ターミナルを再起動',

  // ---------- Terminal pane (exit handling) ----------
  'terminal.exited': '終了',
  'terminal.exitedTitle': 'プロセスが終了しています',
  'terminal.exitedBanner': 'プロセスが終了しました ({status})',
  'terminal.status.starting': '{command} を起動中…',
  'terminal.status.running': '実行中: {command}',
  'terminal.status.exited': '終了 (exitCode={exitCode})',
  'terminal.status.spawnFailed': '起動失敗: {error}',
  'terminal.status.reconnect': '再接続: {command}',
  'terminal.status.reconnectRestored': '再接続 (出力復元): {command}',
  'terminal.status.exception': '例外: {error}',
  'terminal.limitReached': 'ターミナル上限（{max}）に達しました',
  'terminal.limitWarning': 'ターミナル数が {threshold} に達しました（上限 {max}）',
  'terminal.restart': '再起動',
  'terminal.closeTab': '閉じる',
  'cmd.settings.open': '設定を開く',
  'cmd.settings.cycleDensity': '情報密度を切り替え',
  'cmd.settings.cycleDensitySub': '現在: {density}',
  'cmd.theme.title': 'テーマ: {name}',
  'cmd.theme.current': '✓ 現在のテーマ',
  'cmd.cat.app': 'アプリ',
  'cmd.app.restart': 'vibe-editor (アプリ) を再起動',

  // ---------- Settings 補助 (Issue #76) ----------
  'updater.confirm': 'vibe-editor v{version} が利用可能です。今すぐ更新しますか?',
  'updater.upToDate': '最新版を使用しています',
  'updater.checkFailed': '更新の確認に失敗しました: {error}',
  'updater.dialogFailed': '更新ダイアログの表示に失敗しました: {error}',
  'updater.downloading': '更新をダウンロード中…',
  'updater.downloadProgress': 'ダウンロード中… {pct}%',
  'updater.installing': 'インストール中… 完了後に再起動します',
  'updater.downloadFailed': 'ダウンロードに失敗しました: {error}',
  'updater.relaunchFailed': '再起動に失敗しました ({error})。手動で再起動してください',
  'updater.runningTasksWarning': '実行中のエージェントが {count} 個あります。更新で中断されます',
  'updater.checkNow': '更新を確認',
  'updater.button.label': '更新 v{version}',
  'updater.button.title': '新しいバージョン v{version} が利用可能です。クリックでインストール',
  // Issue #609: minisign 署名検証失敗の警告 (24h に 1 度だけ表示)
  'updater.signatureFailed':
    '更新ファイルの署名検証に失敗しました。改竄や中継経路の異常の可能性があります。次回更新までしばらくお待ちください。',

  // ---------- Toast tone ラベル (Issue #80) ----------
  'toast.tone.info': '情報',
  'toast.tone.success': '完了',
  'toast.tone.warning': '注意',
  'toast.tone.error': 'エラー',

  // ---------- Terminal タブ復元 (Issue #857) ----------
  'terminalTabs.restore.transcriptMissing':
    '過去の会話履歴が見つからず {count} 件のタブを新規会話で再起動しました',
  'terminalTabs.saveFailed':
    'ターミナルタブの保存に失敗しました: {error}',

  // ---------- Status ----------

};

export const runtimeEn: Dict = {

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
  'cmd.settings.open': 'Open settings',
  'cmd.settings.cycleDensity': 'Cycle density',
  'cmd.settings.cycleDensitySub': 'Current: {density}',
  'cmd.theme.title': 'Theme: {name}',
  'cmd.theme.current': '✓ current theme',
  'cmd.cat.app': 'App',
  'cmd.app.restart': 'Restart vibe-editor',

  // ---------- Settings helpers (Issue #76) ----------
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

};
