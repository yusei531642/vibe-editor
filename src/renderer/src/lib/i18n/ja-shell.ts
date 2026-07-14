import type { Dict } from './types';

/**
 * 日本語辞書 — シェル / エディタ / ターミナル等の共通 UI。
 * Issue #1032: i18n.ts の god-file 分割で領域別サブ辞書に分離。
 * 追加キーは領域の合うファイルへ。merge は index.ts 側で行う。
 */
export const jaShell: Dict = {
  // ---------- Common ----------
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


  // ---------- AppMenu ----------
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


  // ---------- File tree / Editor ----------
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
  'canvasMenu.lockTeam': 'チームで一緒に動かす',
  'canvasMenu.unlockTeam': 'チーム固定を解除',
  'canvasMenu.deleteCard': 'カードを削除',
  'canvasMenu.addClaudeHere': 'ここに Claude を追加',
  'canvasMenu.addCodexHere': 'ここに Codex を追加',
  'canvasMenu.addCustomAgentHere': 'ここに {name} を追加',
  'canvasMenu.addFileTreeHere': 'ここにファイルツリーを追加',
  'canvasMenu.addChangesHere': 'ここに Git 変更を追加',
  'canvasMenu.addEditorHere': 'ここに空のエディタを追加',
  'canvasMenu.spawnDefaultTeam': '既定チームを起動',


  // ---------- Claude Code panel ----------
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


  // ---------- Sessions ----------
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
  'fonts.family': 'フォントファミリ',
  'fonts.custom': '（カスタム）',
  'fonts.size': 'サイズ (px)',
  'fonts.customCss': 'カスタム CSS font-family',


  // ---------- Roles ----------


  // ---------- Toast ----------
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
  'quicknav.placeholder': 'エージェント / カードへジャンプ…',
  'quicknav.empty': '該当するカードがありません',
  'quicknav.hintNavigate': '↑↓ 選択',
  'quicknav.hintJump': 'Enter ジャンプ',
  'quicknav.hintClose': 'Esc 閉じる',


  // ---------- Command palette entries (Issue #57) ----------
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
  'customAgent.warn.args': 'カスタムエージェントの引数に解析上の警告があります（未閉じクォート / 特殊ダッシュ）。設定を確認してください',
  'customAgent.warn.modelOverride': '明示モデル指定（{model}）で起動します。プランで利用できないモデルの場合、claude が API エラーを繰り返すことがあります',
  'terminal.apiErrorHint': 'API エラーが繰り返し発生しています。起動したモデルがプランで利用できない可能性があります。/model で標準モデルに変更してください',
  'terminal.status.starting': '{command} を起動中…',
  'terminal.status.running': '実行中: {command}',
  'terminal.status.exited': '終了 (exitCode={exitCode})',
  'terminal.status.spawnFailed': '起動失敗: {error}',
  'terminal.status.reconnect': '再接続: {command}',
  'terminal.status.reconnectRestored': '再接続 (出力復元): {command}',
  'terminal.status.exception': '例外: {error}',
  'terminal.diagnostic.exited': '[プロセス終了: {status}]',
  'terminal.diagnostic.finalOutput': '── 最終出力 (死因の可能性) ──',
  'terminal.diagnostic.spawnFailed': '[起動エラー] {error}',
  'terminal.diagnostic.unknownError': '不明なエラー',
  'terminal.diagnostic.exception': '[例外] {error}',
  'terminal.limitReached': 'ターミナル上限（{max}）に達しました',
  'terminal.limitWarning': 'ターミナル数が {threshold} に達しました（上限 {max}）',
  'terminal.restart': '再起動',
  'terminal.closeTab': '閉じる',
  'layout.sidebarResizeTitle': 'ドラッグでサイドバー幅を調整 / ダブルクリックでリセット',
  'layout.idePanelResizeTitle': 'ドラッグで IDE モードパネルの幅を調整',
  'cmd.settings.open': '設定を開く',
  'cmd.settings.cycleDensity': '情報密度を切り替え',
  'cmd.settings.cycleDensitySub': '現在: {density}',
  'cmd.theme.title': 'テーマ: {name}',
  'cmd.theme.current': '✓ 現在のテーマ',
  'cmd.cat.app': 'アプリ',
  'cmd.app.restart': 'vibe-editor (アプリ) を再起動',


  // ---------- Updater (Issue #59) ----------
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
  'status.noProject': 'プロジェクトが選択されていません',


  // ---------- Image preview ----------
  'imagePreview.devUnavailable': 'dev:vite モードでは画像プレビューを利用できません。',
  'imagePreview.loadError': '画像を表示できません: {path}',

};
