import type { Dict } from './types';

/**
 * 日本語辞書 — Canvas / チーム / エージェント関連。
 * Issue #1032: i18n.ts の god-file 分割で領域別サブ辞書に分離。
 * 追加キーは領域の合うファイルへ。merge は index.ts 側で行う。
 */
export const jaCanvas: Dict = {
  'canvas.persistence.corruptBackedUp':
    'Canvasの保存データが破損していたため初期化しました。原文は「{key}」へ退避しました',
  'canvas.persistence.corruptBackupFailed':
    'Canvasの保存データが破損し、退避にも失敗しました。データ保護のため自動保存を停止しています',
  // ---------- Canvas HUD ----------
  'canvas.apiAgent.teamRole': 'チームロール',
  'canvas.apiAgent.teamRolePlaceholder': '例: reviewer',
  'canvas.apiChat.placeholder': '指示を入力してください (/でコマンド、@でエージェントを選択)',
  'canvas.apiChat.typing': '{name} が入力中…',
  'canvas.apiChat.ready': '準備完了。指示を入力してください。',
  'canvas.apiChat.loadingPrompt': 'システムプロンプトを読み込み中…',
  'canvas.apiChat.configure': '設定でこの API エージェントを構成してください。',
  'canvas.apiChat.mention': 'エージェントを選択 (@)',
  'canvas.apiChat.attach': 'ファイル添付 (近日対応)',
  'canvas.apiChat.send': '送信',
  'canvas.apiChat.stop': '停止',
  'canvas.apiChat.cmd.planDesc': '計画を立てる',
  'canvas.apiChat.cmd.statusDesc': '状態を確認',
  'canvas.apiChat.cmd.contextDesc': 'コンテキストを表示',
  'canvas.apiChat.cmd.clearDesc': '履歴をクリア',
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


  // ---------- Team history ----------
  'teamHistory.resume': 'チーム「{name}」を復元',
  'teamHistory.resumed': 'チーム「{name}」を復元しました',
  'teamHistory.alreadyOpen': 'チーム「{name}」は既に Canvas 上にあります',
  'teamHistory.delete': '履歴から削除',


  // ---------- Team ----------
  'team.closeTeamConfirm': 'これはチームリーダーです。チーム全体を閉じますか？',
  'team.closeTeam': 'チームを閉じる',
  'team.closeLeaderOnly': 'リーダーのみ閉じる',


  // ---------- Canvas ----------
  'canvas.spawnTeam': 'チーム起動',
  'canvas.spawnTeam.tooltip': 'チーム起動 — 既定プリセットでリーダー＋メンバーを一括起動',
  'canvas.spawnTeamMore': 'その他のチーム…',
  'canvas.spawnTeamMore.tooltip': 'プリセット選択 — 別の組み込みプリセットや最近使ったチームから選ぶ',
  'canvas.preset': 'プリセット',
  'canvas.preset.leaderClaude': 'Leader のみで起動 (Claude Code)',
  'canvas.preset.leaderCodex': 'Leader のみで起動 (Codex)',
  'canvas.preset.builtinHeader': '組み込み',
  'canvas.preset.savedHeader': '保存済み',
  'canvas.preset.leaderCustom': 'Leader のみで起動 ({name})',
  'canvas.recent': '最近使ったチーム',
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
  'canvas.card.editor': 'エディタ',
  'canvas.list.title': 'チーム',
  'canvas.list.empty': 'まだエージェントが配置されていません',


  // ---------- Agent Card ----------
  'agentCard.close': 'カードを閉じる',
  'agentCard.confirmCloseTeam':
    'このカードを閉じると、同じチーム「{name}」のメンバー {count} 名すべて (Leader 含む) が一緒に閉じられます。続行しますか？',
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
  'dashboard.alert.leaderInput': 'Leader 入力待ち',
  'dashboard.alert.staleOutput': '5 分以上出力なし',
  // Issue #615: dual / multi preset 対応の team section heading
  'dashboard.team.label': 'チーム {index}',


  // ---------- Team history ----------
  'teamHistory.resume.emptyMembers': 'チームメンバー情報が空のため復元できません',
  'teamHistory.resume.otherProject':
    'このチームは別プロジェクト({project})の履歴です',
  'teamHistory.resume.terminalLimit':
    'ターミナル上限({max})を超えるため復元できません',

};
