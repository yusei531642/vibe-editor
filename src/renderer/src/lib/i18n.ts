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

  // ---------- Topbar (redesign shell) ----------
  'topbar.searchHint': 'コマンドを検索…',
  'topbar.mode.canvas': 'Canvas',
  'topbar.mode.ide': 'IDE',
  'topbar.mode.terminal': 'Terminal',

  // ---------- Status bar ----------
  'status.branch': 'ブランチ',
  'status.changes': '変更',
  'status.lang': '言語',
  'status.theme': 'テーマ',
  'status.ready': '準備完了',
  'status.mascot.idle': '待機中',
  'status.mascot.editing': '編集中',
  'status.mascot.dirty': '変更あり',
  'status.mascot.running': 'エージェント応答中',
  'status.mascot.reviewing': '確認中',
  'status.mascot.blocked': '対応が必要',

  // ---------- Canvas HUD ----------
  'canvas.hud.stage': 'ステージ',
  'canvas.hud.list': 'リスト',
  'canvas.hud.focus': 'フォーカス',
  'canvas.hud.fit': 'フィット',
  'canvas.hud.zoomIn': 'ズームイン',
  'canvas.hud.zoomOut': 'ズームアウト',
  'canvas.hud.arrange.open': '整理',
  // Issue #368: ホバー時の機能役割説明 (Label — 役割)
  'canvas.hud.stage.tooltip': 'ステージ — エージェントを放射状に並べたビューに切替',
  'canvas.hud.list.tooltip': 'リスト — エージェントを縦並びの一覧で表示',
  'canvas.hud.focus.tooltip': 'フォーカス — 選択中のエージェントだけを大きく表示',
  'canvas.hud.fit.tooltip': 'フィット — Canvas 上の全カードが収まるよう自動で拡縮',
  'canvas.hud.zoomIn.tooltip': 'ズームイン — Canvas を拡大表示',
  'canvas.hud.zoomOut.tooltip': 'ズームアウト — Canvas を縮小表示',
  'canvas.hud.arrange.open.tooltip': '整理 — カードの整頓・サイズ統一・間隔をまとめて調整',
  'canvas.hud.arrange.tidy': '整頓',
  'canvas.hud.arrange.unifySize': 'サイズ統一',
  'canvas.hud.arrange.gap.label': '間隔',
  'canvas.hud.arrange.gap.tight': '狭い',
  'canvas.hud.arrange.gap.normal': '標準',
  'canvas.hud.arrange.gap.wide': '広い',

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
  'canvasMenu.lockTeam': 'チームで一緒に動かす',
  'canvasMenu.unlockTeam': 'チーム固定を解除',
  'canvasMenu.deleteCard': 'カードを削除',
  'canvasMenu.addClaudeHere': 'ここに Claude を追加',
  'canvasMenu.addCodexHere': 'ここに Codex を追加',
  'canvasMenu.addFileTreeHere': 'ここにファイルツリーを追加',
  'canvasMenu.addChangesHere': 'ここに Git 変更を追加',
  'canvasMenu.addEditorHere': 'ここに空のエディタを追加',
  'canvasMenu.spawnDefaultTeam': '既定チームを起動',

  // ---------- Claude Code panel ----------
  'claudePanel.title': 'IDEモード',
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

  // ---------- Team ----------
  'team.closeTeamConfirm': 'これはチームリーダーです。チーム全体を閉じますか？',
  'team.closeTeam': 'チームを閉じる',
  'team.closeLeaderOnly': 'リーダーのみ閉じる',
  'team.defaultName': 'チーム',

  // ---------- Canvas ----------
  'canvas.add': '追加',
  'canvas.add.tooltip': '追加 — Claude / Codex / ファイルツリー / Git 変更などのカードを Canvas に置く',
  'canvas.spawnTeam': 'チーム起動',
  'canvas.spawnTeam.tooltip': 'チーム起動 — 既定プリセットでリーダー＋メンバーを一括起動',
  'canvas.spawnTeamMore': 'その他のチーム…',
  'canvas.spawnTeamMore.tooltip': 'プリセット選択 — 別の組み込みプリセットや最近使ったチームから選ぶ',
  'canvas.preset': 'プリセット',
  'canvas.preset.leaderClaude': 'Leader のみで起動 (Claude Code)',
  'canvas.preset.leaderHrClaude': 'Leader + HR で起動 (Claude Code)',
  'canvas.preset.leaderCodex': 'Leader のみで起動 (Codex)',
  'canvas.preset.leaderHrCodex': 'Leader + HR で起動 (Codex)',
  'canvas.preset.dualClaudeClaude': 'Claude 組織 + Claude 組織',
  'canvas.preset.dualClaudeCodex': 'Claude 組織 + Codex 組織',
  'canvas.preset.dualCodexCodex': 'Codex 組織 + Codex 組織',
  'canvas.preset.dualCodexClaude': 'Codex 組織 + Claude 組織',
  'canvas.organization.claude': 'Claude 組織',
  'canvas.organization.claudeA': 'Claude 組織 A',
  'canvas.organization.claudeB': 'Claude 組織 B',
  'canvas.organization.codex': 'Codex 組織',
  'canvas.organization.codexA': 'Codex 組織 A',
  'canvas.organization.codexB': 'Codex 組織 B',
  'canvas.recent': '最近使ったチーム',
  'canvas.panels': 'パネル',
  'canvas.noRecentTeams': '最近使ったチームはありません。プリセットから起動してください。',
  'canvas.clear': 'クリア',
  'canvas.clear.tooltip': 'クリア — Canvas 上のカードをすべて削除',
  'canvas.clearConfirm': 'Canvas 上のカードをすべて削除しますか？',
  // Issue #595: Clear 実行時に dirty な EditorCard が居ればファイル名一覧と件数を表示する。
  'canvas.clearConfirmWithDirtyEditors':
    'Canvas 上のカードをすべて削除します。未保存の編集が {count} 件あり、これらは破棄されます。続行しますか？\n\n{paths}',
  'canvas.switchToIde': 'IDE モードに戻る',
  'canvas.switchToIde.tooltip': 'IDE — エディタとターミナル中心の IDE モードへ切替',
  'canvas.modeToggle': 'Canvas モードに切り替え',
  'canvas.add.claude': 'Claude Code',
  'canvas.add.codex': 'Codex',
  'canvas.add.fileTree': 'ファイルツリー',
  'canvas.add.gitChanges': 'Git 変更',
  'canvas.add.emptyEditor': 'エディタ（空）',
  'canvas.card.editor': 'エディタ',
  'canvas.lastUsed': '最終使用: {value}',

  // ---------- Agent Card ----------
  'agentCard.close': 'カードを閉じる',
  'agentCard.confirmCloseTeam':
    'このカードを閉じると、同じチーム「{name}」のメンバー {count} 名すべて (Leader 含む) が一緒に閉じられます。続行しますか？',
  'handoff.create': '引き継ぎ',
  'handoff.createTooltip':
    '引き継ぎ書を保存し、Leader 自身に MCP で新 Leader 採用 → 交代を依頼します',
  'handoff.created': '引き継ぎ書 {file} を保存し、Leader に MCP 手順を伝えました',
  'handoff.acknowledged': '引き継ぎ ack を受信し、旧セッションを退役しました',
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
  'agentCard.summary.region': 'エージェントの状態サマリ',
  'agentCard.summary.noTask': '現在のタスクは未割当',
  'agentCard.summary.needsLeader': 'Leader の入力待ち',
  'agentCard.summary.ago.unobserved': '出力はまだ観測されていません',
  'agentCard.summary.ago.now': '直前に出力',
  'agentCard.summary.ago.sec': '最終出力から {value} 秒前',
  'agentCard.summary.ago.min': '最終出力から {value} 分前',
  'agentCard.summary.ago.hour': '最終出力から {value} 時間前',
  'agentCard.summary.ago.day': '最終出力から {value} 日前',

  // Issue #510: Agent カード health badge (TeamHub diagnostics 由来)
  'agentCard.summary.health.state.alive': '稼働中',
  'agentCard.summary.health.state.stale': '沈黙中',
  'agentCard.summary.health.state.dead': '応答なし',
  'agentCard.summary.health.state.unknown': '不明',
  'agentCard.summary.health.silent.sec': '{state} ({value} 秒沈黙)',
  'agentCard.summary.health.silent.min': '{state} ({value} 分沈黙)',
  'agentCard.summary.health.tooltip': 'Health: {state} / 直近自己申告: {status}',
  'agentCard.summary.health.noStatus': '自己申告なし',

  // Issue #521: Canvas 全体サマリ HUD
  'canvas.hud.summary.label': 'Canvas 全体の状態サマリ',
  'canvas.hud.summary.active': '進行中',
  'canvas.hud.summary.active.tooltip': '進行中 — 直近に出力があったエージェントの数',
  'canvas.hud.summary.blocked': 'Leader 待ち',
  'canvas.hud.summary.blocked.tooltip':
    'Leader 待ち — Leader の入力 / handoff ack を待っているエージェントの数',
  'canvas.hud.summary.stale': '停滞',
  'canvas.hud.summary.stale.tooltip': '停滞 — 5 分以上出力が無いエージェントの数',
  'canvas.hud.summary.completed': '完了',
  'canvas.hud.summary.completed.tooltip': '完了 — handoff ack 済 / 退役済のエージェントの数',
  'canvas.hud.summary.dead': '応答なし',
  'canvas.hud.summary.dead.tooltip':
    '応答なし — 15 分以上 PTY 出力なしのエージェントの数 (Hub diagnostics 由来)',

  // Issue #522: Team Presets panel
  'preset.title': 'チームプリセット',
  'preset.button.tooltip': 'プリセット — 現在のチーム編成を保存・再構築',
  'preset.saveCurrent': '現在のチームを保存',
  'preset.saveCurrent.tooltip': '今 Canvas に並んでいる Agent カードをプリセットとして保存',
  'preset.save': '保存',
  'preset.name': '名前',
  'preset.namePlaceholder': '例: 計画 + 実装 + レビュー チーム',
  'preset.description': '説明',
  'preset.descriptionPlaceholder': '任意のメモ (どんな課題に向く編成か等)',
  'preset.apply': '適用',
  'preset.apply.tooltip': 'このプリセットの役職構成を Canvas に展開',
  'preset.delete': '削除',
  'preset.delete.tooltip': 'このプリセットをディスクから削除',
  'preset.empty': '保存されたプリセットはまだありません',
  'preset.loading': '読み込み中…',
  'preset.roleCount': '{count} 名',
  'preset.saved': 'プリセット「{name}」を保存しました',
  'preset.applied': '「{name}」のメンバー {count} 名を Canvas に追加しました',
  'preset.deleted': 'プリセット「{name}」を削除しました',
  'preset.error.empty': 'Canvas に Agent カードがありません。先にチームを組んでから保存してください',
  'preset.error.noName': 'プリセット名を入力してください',
  'preset.error.listFailed': 'プリセット一覧の読み込みに失敗しました',
  'preset.error.saveFailed': 'プリセット保存に失敗しました: {detail}',
  'preset.error.deleteFailed': 'プリセット削除に失敗しました: {detail}',

  // Issue #514: Team Dashboard
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
  // Issue #615: dual / multi preset 対応の team section heading
  'dashboard.team.label': 'チーム {index}',

  // ---------- Sessions ----------
  'sessions.resume': 'セッション {id} に戻る',
  'sessions.messages': '{count} 件',
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

  // ---------- Theme labels (UserMenu / OnboardingWizard 共有) ----------
  'theme.label.claude-dark': 'Claude Dark',
  'theme.label.claude-light': 'Claude Light',
  'theme.label.dark': 'ダーク',
  'theme.label.light': 'ライト',
  'theme.label.midnight': 'ミッドナイト',
  'theme.label.glass': 'グラス',

  // ---------- Language labels (UserMenu / LanguageSection 共有) ----------
  'lang.label.ja': '日本語',
  'lang.label.ja.sub': 'Japanese',
  'lang.label.en': 'English',
  'lang.label.en.sub': 'English',

  // ---------- Settings: Logs (Issue #326) ----------
  'settings.logs.title': 'ログ',
  'settings.logs.desc':
    'アプリの実行ログ (~/.vibe-editor/logs/vibe-editor.log) の末尾を表示します。バグ報告にはこのログを添付してください。',
  'settings.logs.refresh': '再読み込み',
  'settings.logs.openDir': 'ログフォルダを開く',
  'settings.logs.levelFilter': 'レベル',
  'settings.logs.level.all': 'すべて',
  'settings.logs.loading': '読み込み中…',
  'settings.logs.empty': 'ログはまだありません。',
  'settings.logs.noMatch': '選択したレベルに該当するログがありません。',
  'settings.logs.truncated': '末尾のみ表示中',

  // ---------- Toast ----------
  'toast.reviewRequested': '差分レビューを依頼: {path}',
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
  'toast.sessionResumed': 'セッションに復帰: {title}',
  'toast.recentCleared': '最近のプロジェクト履歴をクリアしました',
  'toast.newProject': '新規プロジェクトを作成',
  'toast.notEmpty': 'フォルダが空ではありません。既存として開きます',
  'toast.openedFile': '{file} の親フォルダをプロジェクトとして読み込みました',
  'toast.terminalNotReady': 'ターミナルが起動していません',
  'toast.settings.saveFailed': '設定の保存に失敗しました: {error}',
  'toast.settings.projectRootFailed': 'プロジェクトルートの反映に失敗しました: {error}',
  // Issue #578: Canvas 非表示中に recruit が走った件数を可視化時に警告する
  'toast.recruitWhileHidden':
    'Canvas を非表示の間にメンバー採用が {count} 件走りました。失敗していたら再実行してください',
  'toast.recruitRescued': '採用 (遅着救済): {ms}ms 遅れて受領されました',

  // ---------- Terminal (pasteエラー等) ----------
  'terminal.pasteImageFailed': '画像保存失敗',
  'terminal.pasteException': 'ペースト例外',

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
  'settings.command': 'コマンド',
  'settings.argsUnterminatedQuote': 'ダブルクォート (") が閉じていません。引数が誤って解釈される可能性があります。',
  'settings.argsUnicodeDash':
    'Unicode ダッシュ (–, — など) が含まれています。実行時に ASCII の "--" に自動変換します。コピペや IME の自動変換が原因の可能性があります。',

  // ---------- Custom agents ----------
  'settings.customAgents.title': 'カスタムエージェント',
  'settings.customAgents.add': '+ カスタムエージェントを追加',
  'settings.customAgents.name': '表示名',
  'settings.customAgents.remove': '削除',
  'settings.customAgents.untitled': '（無名）',

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

  // ---------- Status ----------
  'status.loaded': '読み込み完了',
  'status.loading': 'プロジェクト読み込み中…',
  'status.templateInserted': 'テンプレートを挿入しました（まだ保存されていません）',
  'status.initError': '初期化エラー: {err}',
  'status.loadError': '読み込みエラー: {err}',
  'status.noProject': 'プロジェクトが選択されていません',

  // ---------- Onboarding ----------
  'onboarding.step': '{current} / {total}',
  'onboarding.back': '戻る',
  'onboarding.next': '次へ',
  'onboarding.skip': 'あとでにする',
  'onboarding.replay': 'セットアップをもう一度',
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
  'onboarding.workspace.picked': '選択したフォルダ',
  'onboarding.done.eyebrow': 'Ready',
  'onboarding.done.title': '準備ができました',
  'onboarding.done.subtitle': '落ち着いた画面で、今日の一行を書きはじめましょう。',
  'onboarding.done.summaryLanguage': '言語',
  'onboarding.done.summaryTheme': 'テーマ',
  'onboarding.done.summaryFolder': 'フォルダ',
  'onboarding.done.summaryFolderNone': 'あとで開く',
  'onboarding.done.cta': 'エディタを開く'
};

const en: Dict = {
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

  // ---------- Topbar (redesign shell) ----------
  'topbar.searchHint': 'Search commands…',
  'topbar.mode.canvas': 'Canvas',
  'topbar.mode.ide': 'IDE',
  'topbar.mode.terminal': 'Terminal',

  // ---------- Status bar ----------
  'status.branch': 'branch',
  'status.changes': 'changes',
  'status.lang': 'lang',
  'status.theme': 'theme',
  'status.ready': 'Ready',
  'status.mascot.idle': 'Idle',
  'status.mascot.editing': 'Editing',
  'status.mascot.dirty': 'Changes pending',
  'status.mascot.running': 'Agent active',
  'status.mascot.reviewing': 'Reviewing',
  'status.mascot.blocked': 'Needs attention',

  // ---------- Canvas HUD ----------
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
  'canvasMenu.lockTeam': 'Move team together',
  'canvasMenu.unlockTeam': 'Unlock team movement',
  'canvasMenu.deleteCard': 'Delete card',
  'canvasMenu.addClaudeHere': 'Add Claude here',
  'canvasMenu.addCodexHere': 'Add Codex here',
  'canvasMenu.addFileTreeHere': 'Add file tree here',
  'canvasMenu.addChangesHere': 'Add Git changes here',
  'canvasMenu.addEditorHere': 'Add empty editor here',
  'canvasMenu.spawnDefaultTeam': 'Spawn default team',

  // ---------- Claude Code panel ----------
  'claudePanel.title': 'IDE Mode',
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

  // ---------- Team ----------
  'team.closeTeamConfirm': 'This is the team leader. Close entire team?',
  'team.closeTeam': 'Close Team',
  'team.closeLeaderOnly': 'Close Leader Only',
  'team.defaultName': 'Team',

  // ---------- Canvas ----------
  'canvas.add': 'Add',
  'canvas.add.tooltip': 'Add — Place a Claude / Codex agent, file tree, git changes, or empty editor card',
  'canvas.spawnTeam': 'Spawn Team',
  'canvas.spawnTeam.tooltip': 'Spawn Team — Launch leader and members in one click using the default preset',
  'canvas.spawnTeamMore': 'More team options…',
  'canvas.spawnTeamMore.tooltip': 'Pick a preset — Choose another built-in preset or a recently used team',
  'canvas.preset': 'Preset',
  'canvas.preset.leaderClaude': 'Leader only (Claude Code)',
  'canvas.preset.leaderHrClaude': 'Leader + HR (Claude Code)',
  'canvas.preset.leaderCodex': 'Leader only (Codex)',
  'canvas.preset.leaderHrCodex': 'Leader + HR (Codex)',
  'canvas.preset.dualClaudeClaude': 'Claude org + Claude org',
  'canvas.preset.dualClaudeCodex': 'Claude org + Codex org',
  'canvas.preset.dualCodexCodex': 'Codex org + Codex org',
  'canvas.preset.dualCodexClaude': 'Codex org + Claude org',
  'canvas.organization.claude': 'Claude org',
  'canvas.organization.claudeA': 'Claude org A',
  'canvas.organization.claudeB': 'Claude org B',
  'canvas.organization.codex': 'Codex org',
  'canvas.organization.codexA': 'Codex org A',
  'canvas.organization.codexB': 'Codex org B',
  'canvas.recent': 'Recent',
  'canvas.panels': 'Panels',
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
  'canvas.add.claude': 'Claude Code',
  'canvas.add.codex': 'Codex',
  'canvas.add.fileTree': 'File Tree',
  'canvas.add.gitChanges': 'Git Changes',
  'canvas.add.emptyEditor': 'Editor (empty)',
  'canvas.card.editor': 'Editor',
  'canvas.lastUsed': 'Last used: {value}',

  // ---------- Agent Card ----------
  'agentCard.close': 'Close card',
  'agentCard.confirmCloseTeam':
    'Closing this card will also close all {count} members of team "{name}" (including the Leader). Continue?',
  'handoff.create': 'Hand off',
  'handoff.createTooltip':
    'Save a handoff document and ask the leader to recruit a successor and switch over via MCP',
  'handoff.created': 'Handoff saved ({file}); MCP instructions sent to the leader PTY',
  'handoff.acknowledged': 'Handoff acknowledged; retired the old session',
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
  // Issue #615: dual / multi preset support for team section heading
  'dashboard.team.label': 'Team {index}',

  // ---------- Sessions ----------
  'sessions.resume': 'Resume session {id}',
  'sessions.messages': '{count} msgs',
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

  // ---------- Theme labels (UserMenu / OnboardingWizard) ----------
  'theme.label.claude-dark': 'Claude Dark',
  'theme.label.claude-light': 'Claude Light',
  'theme.label.dark': 'Dark',
  'theme.label.light': 'Light',
  'theme.label.midnight': 'Midnight',
  'theme.label.glass': 'Glass',

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

  // ---------- Toast ----------
  'toast.reviewRequested': 'Review requested: {path}',
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
  'toast.sessionResumed': 'Resumed session: {title}',
  'toast.recentCleared': 'Recent projects cleared',
  'toast.newProject': 'New project created',
  'toast.notEmpty': 'Folder is not empty. Opening as existing project',
  'toast.openedFile': 'Loaded parent folder of {file} as project',
  'toast.terminalNotReady': 'Terminal is not ready',
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
  'settings.command': 'Command',
  'settings.argsUnterminatedQuote':
    'Unterminated double quote (") — arguments may be parsed incorrectly.',
  'settings.argsUnicodeDash':
    'Contains Unicode dashes (–, — etc.) — they will be normalized to ASCII "--" at runtime. Likely caused by paste or IME autocorrect.',

  // ---------- Custom agents ----------
  'settings.customAgents.title': 'Custom agents',
  'settings.customAgents.add': '+ Add custom agent',
  'settings.customAgents.name': 'Display name',
  'settings.customAgents.remove': 'Remove',
  'settings.customAgents.untitled': '(untitled)',

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

  'status.loaded': 'Loaded',
  'status.loading': 'Loading project…',
  'status.templateInserted': 'Template inserted (not saved yet)',
  'status.initError': 'Init error: {err}',
  'status.loadError': 'Load error: {err}',
  'status.noProject': 'No project selected',

  // ---------- Onboarding ----------
  'onboarding.step': '{current} / {total}',
  'onboarding.back': 'Back',
  'onboarding.next': 'Next',
  'onboarding.skip': 'Skip for now',
  'onboarding.replay': 'Run setup again',
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
  'onboarding.workspace.picked': 'Selected folder',
  'onboarding.done.eyebrow': 'Ready',
  'onboarding.done.title': 'You are all set',
  'onboarding.done.subtitle': 'A calm workspace for today’s first line.',
  'onboarding.done.summaryLanguage': 'Language',
  'onboarding.done.summaryTheme': 'Theme',
  'onboarding.done.summaryFolder': 'Folder',
  'onboarding.done.summaryFolderNone': 'Open later',
  'onboarding.done.cta': 'Open editor'
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
    return interpolate(text, params);
  };
}

/**
 * Issue #176: String.prototype.replace の第 2 引数は `$&` `$1` `$$` 等を
 * 特殊置換シーケンスとして解釈する。Windows パスや正規表現サンプル等を
 * params に渡すと結果が壊れていた。`replace(re, fn)` の関数フォームなら
 * 戻り値は literal として扱われるので安全。
 */
function interpolate(text: string, params: Record<string, string | number>): string {
  return Object.entries(params).reduce(
    (acc, [k, v]) =>
      acc.replace(new RegExp(`\\{${k}\\}`, 'g'), () => String(v)),
    text
  );
}

/**
 * React コンテキスト外 (updater-check / timer callback など) から呼べる翻訳関数。
 * 言語を明示的に受け取るので、呼び出し元が settings.language を取って渡す必要がある。
 */
export function translate(
  lang: Language,
  key: string,
  params?: Record<string, string | number>
): string {
  const text = translations[lang]?.[key] ?? translations.ja[key] ?? key;
  if (!params) return text;
  // Issue #176: replace の関数フォームを使って `$` 特殊シーケンスを literal 化
  return Object.entries(params).reduce(
    (acc, [k, v]) =>
      acc.replace(new RegExp(`\\{${k}\\}`, 'g'), () => String(v)),
    text
  );
}
