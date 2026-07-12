import type { Dict } from './types';

/**
 * 日本語辞書 — 設定モーダル / オンボーディング / テーマ / 音声指揮。
 * Issue #1032: i18n.ts の god-file 分割で領域別サブ辞書に分離。
 * 追加キーは領域の合うファイルへ。merge は index.ts 側で行う。
 */
export const jaSettings: Dict = {
  // ---------- Mascot section (SettingsModal の「キャラクター」セクション) ----------
  // Issue #729: MascotSection の isJa 三項 / settings-options.ts hardcode を i18n.ts に集約
  'settings.mascot.title': 'キャラクター',
  'settings.mascot.pickTitle': '相棒にする画像を選択',
  'settings.mascot.imageFilterName': '画像',
  'settings.mascot.choose': '画像を選ぶ…',
  'settings.mascot.clear': 'クリア',
  'settings.mascot.hint':
    'PNG / GIF (アニメ可) / APNG / WebP / SVG を選べます。\n小さめ (32〜128px) の正方形が綺麗に出ます。',
  'mascot.desc.vibe': '既定の小さな相棒',
  'mascot.desc.spark': '明るめで軽い印象',
  'mascot.desc.mono': '端末になじむ角ばった見た目',
  'mascot.desc.coder': 'PCでカタカタ作業する相棒',
  'mascot.desc.custom': '自分で用意したラスター画像 (PNG/GIF/WebP) を相棒として使う',


  // ---------- Settings ----------
  'settings.title': '設定',
  // Issue #729: WelcomePane の inline isJa を i18n.ts に移管
  'welcome.title': '静かな集中で、すばやく進める。',
  'welcome.recentProjects': '最近のプロジェクト',
  'welcome.recentProjectsTitle': 'すぐに戻れる作業面',
  'welcome.workspaceLabel': 'ワークスペース',
  'welcome.quickStart': 'クイックスタート',
  'welcome.quickStartTitle': 'よく使う操作',
  // Issue #729: canvas-layout-helpers の language ベース hardcode を i18n.ts に移管
  'canvas.agentCount': '{count} エージェント',
  'canvas.orgAgentCount': '{organizationCount} 組織 / {agentCount} エージェント',
  // Issue #729: RoleProfilesSection の isJa 三項を i18n.ts に移管
  'settings.roles.title': 'ロール定義',
  'settings.roles.desc':
    'vibe-team のメンバーロールを定義します。Leader が team_recruit で動的に呼ぶときの選択肢になります。',
  'settings.roles.globalPreamble': '全エージェント共通の前置き',
  'settings.roles.globalPreambleHint': '全 system prompt の先頭に挿入',
  'settings.roles.confirmDelete': '"{id}" を削除しますか?',
  'settings.roles.addCustom': 'カスタムロールを追加',
  'settings.roles.newCustomDesc': '新しいカスタムロール。',
  'settings.roles.builtin': '組み込み',
  'settings.roles.custom': 'カスタム',
  'settings.roles.color': '色',
  'settings.roles.glyph': 'グリフ',
  'settings.roles.defaultEngine': '既定エンジン',
  'settings.roles.permissions': '権限',
  'settings.roles.promptEn': 'システムプロンプト (EN)',
  'settings.roles.promptJa': 'システムプロンプト (JA)',
  'settings.roles.promptPlaceholders':
    'placeholder: {teamName} {selfLabel} {selfDescription} {roster} {tools} {globalPreamble}',
  'settings.roles.deleteRole': 'このロールを削除',
  // Issue #729: settings-section-meta.tsx の FIXED_LABELS_JA を i18n.ts へ移管
  'settings.section.general.label': '一般',
  'settings.section.general.title': '一般',
  'settings.section.general.desc': '言語と密度設定',
  'settings.section.appearance.label': '表示',
  'settings.section.appearance.title': '表示',
  'settings.section.appearance.desc': 'テーマ、配色、キャラクター',
  'settings.section.fonts.label': 'フォント',
  'settings.section.fonts.title': 'フォント',
  'settings.section.fonts.desc': 'UI / エディタ / ターミナルのフォント',
  'settings.section.claude.label': 'Claude Code',
  'settings.section.claude.title': 'Claude Code',
  'settings.section.claude.desc': '起動コマンドと引数',
  'settings.section.codex.label': 'Codex',
  'settings.section.codex.title': 'Codex',
  'settings.section.codex.desc': '起動コマンドと引数',
  // Issue #1068: codex team_send の配送方式トグル
  'settings.codexDelivery.title': 'team_send の配送方式',
  'settings.codexDelivery.label': '配送方式',
  'settings.codexDelivery.optBackend': 'バックエンド (app-server) — 使えなければ PTY に自動 fallback',
  'settings.codexDelivery.optPty': 'PTY 注入 — 常にターミナルへ貼り付け',
  'settings.codexDelivery.hint':
    'codex への team_send を、codex 公式 app-server (JSON-RPC) 経由で送るか、従来どおりターミナルへ PTY 注入するか。バックエンドは履歴に残り入力競合も避けられますが、app-server が使えない場合は自動で PTY に fallback します。Windows は app-server 未対応のため常に PTY です。',
  'settings.section.roles.label': 'ロール定義',
  'settings.section.roles.title': 'ロール定義',
  'settings.section.roles.desc': 'チームメンバーの役割テンプレ',
  'settings.section.mcp.label': 'MCP',
  'settings.section.mcp.title': 'MCP',
  'settings.section.mcp.desc': 'vibe-team MCP の導入方法',
  // Issue #825: 音声指揮モード (Voice Direction, Beta)
  'settings.section.voice.label': '音声指揮 (Beta)',
  'settings.section.voice.title': '音声指揮',
  'settings.section.voice.desc': 'OpenAI Realtime API で AI と会話して Leader を指揮する',
  'settings.voice.beta.warning':
    'この機能はベータで、動作テストを行っていません。意図しない挙動・不安定な接続・誤認識が発生する可能性があります。フィードバックは GitHub Issue でお寄せください。',
  'settings.voice.enabled.label': '音声指揮を有効化',
  'settings.voice.apiKey.label': 'API キー',
  'settings.voice.apiKey.placeholder': 'sk-...',
  'settings.voice.apiKey.save': '保存',
  'settings.voice.apiKey.clear': 'クリア',
  'settings.voice.apiKey.clearConfirm': 'API キーを削除しますか?',
  'settings.voice.apiKey.savedNotice':
    'API キーは OS のキーリング (Windows: 資格情報マネージャー / macOS: キーチェーン / Linux: secret-service) に暗号化して安全に保存しています。一度保存すると再表示されません。再入力する場合は「クリア」してください。',
  'settings.voice.model.label': 'モデル',
  'settings.voice.voiceName.label': 'AI の声',
  'settings.voice.language.label': '言語',
  'settings.voice.inputDevice.label': '入力デバイス (マイク)',
  'settings.voice.outputDevice.label': '出力デバイス (スピーカー)',
  'settings.voice.shortcut.label': 'トグルショートカット',
  'settings.voice.shortcut.reset': 'リセット',
  'settings.voice.shortcut.capturing': '入力中… (キーを押してください)',
  'settings.voice.confirmation.label': '送信時の確認',
  'settings.voice.confirmation.always': '毎回確認する (推奨)',
  'settings.voice.confirmation.bypass': '確認を省略する (バイパス)',
  'settings.voice.confirmation.bypassWarning':
    'バイパス時は AI からの音声確認も Renderer 側の最終確認もスキップされ、誤認識でも即座に Leader へ送信されます。',
  'settings.voice.disclaimer.title': '音声指揮 (Beta)',
  'settings.voice.disclaimer.body':
    'この機能はベータで、開発者による動作テストを行っていません。意図しない挙動が発生する可能性があることをご了承ください。\n\n以下を理解した上でご利用ください:\n- OpenAI Realtime API を使用します。API 料金が発生します。\n- API キーは OS のキーリングに暗号化して保管されます。\n- マイクへのアクセス許可が必要です。\n- 認識精度や接続安定性は環境に依存します。\n- 不具合や改善要望は GitHub Issue でお寄せください。',
  'settings.voice.disclaimer.ack': '理解しました',
  'voice.button.idle': 'クリックで会話開始',
  'voice.button.connecting': '接続中…',
  'voice.button.listening': '会話中 — クリックで終了',
  'voice.button.disabled.noKey': '設定で API キーを保存してください',
  'voice.button.disabled.notEnabled': '設定で音声指揮を有効化してください',
  'voice.confirm.title': '危険な操作の確認',
  'voice.confirm.body': '次のメッセージを Leader に送信しますか?\n\n「{text}」',
  'voice.confirm.send': '送信する',
  'voice.confirm.cancel': 'キャンセル',
  'voice.trail.sending': 'Leader へ送信中… (3 秒後に確定)',
  'voice.trail.spawningTeam': 'チームを起動中… ({preset}, 3 秒後に確定)',
  'voice.trail.cancel': 'キャンセル',
  'voice.toast.apiKeySaved': 'API キーを保存しました',
  'voice.toast.apiKeyCleared': 'API キーを削除しました',
  'voice.toast.sent': 'Leader に送信しました',
  'voice.toast.sendFailed': '送信に失敗しました ({code})',
  'voice.error.micDenied': 'マイクへのアクセスが拒否されました',
  'voice.error.openai401': 'OpenAI 認証エラー (API キーを確認してください)',
  'voice.error.keyringUnavailable': 'OS のキーリングが利用できません',
  'common.show': '表示',
  'common.hide': '隠す',
  'common.saving': '保存中…',
  'common.systemDefault': 'システム既定',
  'settings.section.logs.label': 'ログ',
  'settings.section.logs.title': 'ログ',
  'settings.section.logs.desc': 'アプリの実行ログを表示',
  'settings.section.untitled': '（無名）',
  'settings.section.customDesc': 'カスタムエージェント設定',
  'settings.section.addCustom': '+ 追加',
  'settings.section.group.agents': 'エージェント',
  'settings.section.group.team': 'チーム',
  'settings.section.group.other': 'その他',
  // Issue #729: SettingsModal の inline isJa を i18n.ts に移管
  'settings.dialog.label': '設定',
  'settings.back': '戻る',
  'settings.sections.ariaLabel': '設定セクション',
  'settings.saveFailedSeeConsole': '設定の保存に失敗しました。詳細は開発者ツールのコンソールを確認してください。',
  'settings.search.placeholder': '設定を検索…',
  'settings.search.ariaLabel': '設定を検索',
  'settings.search.clear': 'クリア',
  'settings.search.noMatches': '一致する項目がありません',
  'settings.fonts.uiFontTitle': 'UI フォント',
  'settings.fonts.editorFontTitle': 'エディタフォント (Monaco)',
  'settings.launch.title': '起動オプション',
  'settings.launch.argsLabel': '引数（空白区切り、ダブルクォートで空白を含む値）',
  'settings.launch.argsLabelSimple': '引数（空白区切り）',
  'settings.launch.cwdLabel': '作業ディレクトリ（空なら現在のプロジェクトルート）',
  'settings.launch.cwdUnset': '（未設定）',
  'settings.launch.applyNote': '変更後は再起動でターミナルに反映されます。',
  'settings.customAgents.newName': '新しいエージェント',
  'settings.language': '言語',
  'settings.language.desc':
    'UI 表示言語を切り替え。Claude Code 自体の応答言語には影響しません。',
  'settings.theme': 'テーマ',
  'settings.uiFont': 'UI フォント',
  'settings.uiFontFamily': 'フォントファミリ',
  'settings.uiFontSize': 'サイズ (px)',
  'settings.editorFont': 'エディタフォント (Monaco)',
  'settings.editorFontFamily': 'フォントファミリ',
  'settings.editorFontSize': 'サイズ (px)',
  'settings.terminal': 'ターミナル',
  'settings.terminalFontFamily': 'フォント',
  'settings.terminalFontSize': 'フォントサイズ (px)',
  'settings.terminalNote':
    '既定は JetBrains Mono Nerd Font (本体同梱)。Powerline / Devicons / Material Icons の glyph を含み、Starship や oh-my-posh の icon が tofu になりません。★ は本体にバンドルされたフォントで、OS 未インストールでも常に同じルックで描画されます。',
  'settings.terminalForceUtf8.label': 'Windows ターミナルで UTF-8 を強制 (chcp 65001)',
  'settings.terminalForceUtf8.hint':
    'cmd.exe / PowerShell 起動時に chcp 65001 を inject して console output を UTF-8 化します。漢字ファイル名や日本語出力が U+FFFD 化するのを防ぎます。OEM コードページを意図的に使いたい場合のみ OFF にしてください。Windows 以外の OS では何もしません。',
  'settings.terminalForceUtf8.nonWindows': 'この設定は Windows でのみ有効です',
  'settings.density': '情報密度',
  // Issue #729: DensitySection 旧 hardcoded JP desc を i18n.ts に移管 (theme.desc / mascot.desc と同型)
  'density.desc.compact': '14"以下の画面向け、余白小',
  'density.desc.normal': '既定',
  'density.desc.comfortable': '大画面向け、ゆったり',
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


  // ---------- Theme descriptions (ThemeSection の theme card 用) ----------
  // Issue #729: 旧 settings-options.ts の hardcoded JP `desc` を i18n.ts に移管。EN ユーザー向け表示を修正。
  'theme.desc.claude-dark': 'Anthropic 公式カラー準拠。ウォームダークブラウン + コーラル #D97757（既定）',
  'theme.desc.claude-light': 'claude.ai のクリーム背景と温かい差し色を再現',
  'theme.desc.dark': 'VS Code 系のクラシックダーク',
  'theme.desc.midnight': '深い青紫ベース、紫アクセント',
  'theme.desc.glass': 'すりガラス風 — 半透明パネル + ブラー',
  'theme.desc.light': '明るい背景、暗い文字',


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


  // ---------- Settings 補助 (Issue #76) ----------
  'settings.command': 'コマンド',
  'settings.argsUnterminatedQuote': 'ダブルクォート (") が閉じていません。引数が誤って解釈される可能性があります。',
  'settings.argsUnicodeDash':
    'Unicode ダッシュ (–, — など) が含まれています。実行時に ASCII の "--" に自動変換します。コピペや IME の自動変換が原因の可能性があります。',


  // ---------- Custom agents ----------
  'settings.customAgents.add': '+ カスタムエージェントを追加',
  'settings.agentWizard.title': 'エージェントを追加',
  'settings.agentWizard.typeApi': 'API モデル',
  'settings.agentWizard.typeApiDesc': 'OpenAI / Anthropic / Gemini などのクラウドモデル',
  'settings.agentWizard.typeCli': 'CLI コマンド',
  'settings.agentWizard.typeCliDesc': 'ターミナルで動く CLI エージェント (claude/codex 互換)',
  'settings.agentWizard.apiKeyOptional': 'API キー (任意・後で設定可)',
  'settings.agentWizard.skills': 'Skill',
  'settings.agentWizard.skillsHint':
    '起動時に効かせる skill を選択します (任意)。未 import の場合は設定の Skill セクションから取り込めます。',
  'settings.agentWizard.reviewSummary': '以下の内容で作成します',
  'settings.agentWizard.next': '次へ',
  'settings.agentWizard.back': '戻る',
  'settings.agentWizard.create': '作成',
  'settings.agentWizard.cancel': 'キャンセル',
  'settings.customAgents.name': '表示名',
  'settings.customAgents.remove': '削除',
  'settings.customAgents.untitled': '（無名）',
  // Issue #729: CustomAgentEditor の isJa 三項を i18n.ts に集約
  'settings.customAgents.confirmDelete': 'カスタムエージェント "{name}" を削除しますか？',
  'settings.customAgents.namePlaceholder': '例: Aider',
  'settings.customAgents.argsLabel': '引数（空白区切り、ダブルクォートで空白を含む値）',
  'settings.customAgents.cwdLabel': '作業ディレクトリ（空なら現在のプロジェクトルート）',
  'settings.customAgents.cwdUnset': '（未設定）',
  'settings.customAgents.accentColor': 'アクセントカラー（任意）',
  'settings.customAgents.engine': 'engine（互換系統）',
  'settings.customAgents.engineClaude': 'Claude 互換',
  'settings.customAgents.engineCodex': 'Codex 互換',
  'settings.customAgents.icon': 'アイコン（lucide 名）',
  'settings.customAgents.tags': 'タグ',
  'settings.customAgents.tagsPlaceholder': 'カンマ区切り',
  'settings.customAgents.runtime': '実行方式',
  'settings.customAgents.provider': 'Provider',
  'settings.customAgents.baseUrl': 'Base URL',
  'settings.customAgents.model': 'Model',
  'settings.customAgents.apiKey': 'API key',
  'settings.customAgents.apiKeySaved': '保存済み（値は表示されません）',
  'settings.customAgents.apiKeyClearConfirm': '保存済み API key を削除しますか？',
  'settings.customAgents.apiKeySaveError': 'API キーの保存に失敗しました: {detail}',
  'settings.customAgents.toolMode': 'Tool mode',
  'settings.customAgents.toolAuto': 'Auto',
  'settings.customAgents.toolReadOnly': 'Read-only chat',
  'settings.customAgents.systemPrompt': 'System prompt override',
  'settings.customAgents.apiNote': 'TeamHub tool は provider/model が対応する場合のみ有効です。',
  'settings.customAgents.readOnlyNote':
    'この provider/model は tool calling を read-only chat に degrade します。',
  'settings.customAgents.applyNote': '変更後、Canvas で該当エージェントのカードを作り直すと反映されます。',
  'settings.customAgents.skills': 'Skill (SKILL.md)',
  'settings.customAgents.skillsEmpty':
    'import 済みの skill がありません。下の「Claude / Codex から import」で追加してください。',
  'settings.customAgents.skillsAutoTeam': 'TeamHub 参加時は vibe-team skill が自動で追加されます。',
  'settings.customAgents.skillSearch': 'skill を検索',
  'settings.customAgents.applySkills': 'プロジェクトに適用',
  'settings.customAgents.applySkillsBusy': '適用中…',
  'settings.customAgents.applySkillsEmpty': '適用する skill が選択されていません。',
  'settings.customAgents.applySkillsDone':
    '{count}/{total} 件の skill を .claude/skills に適用しました。',
  'settings.customAgents.applySkillsError': 'skill の適用に失敗しました: {detail}',
  'settings.customAgents.cliSkillsNote':
    'CLI エージェントは .claude/skills を自動探索します。チェックして「適用」でプロジェクトに配置してください。',
  'settings.customAgents.skillImport.title': 'Claude / Codex から skill を import',
  'settings.customAgents.skillImport.note':
    '~/.claude/skills と ~/.agents/skills (Codex) を走査し、選んだ skill を vibe-editor 専用フォルダにコピーします。',
  'settings.customAgents.skillImport.empty':
    'import 元 (~/.claude/skills・~/.agents/skills) に skill が見つかりません。',
  'settings.customAgents.skillImport.import': 'Import',
  'settings.customAgents.skillImport.remove': '削除',


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
  // Issue #729: McpSection の isJa 三項を i18n.ts に移管
  'settings.mcp.claudeSampleNote': '~/.claude.json のサンプル (既存の mcpServers と統合してください):',
  'settings.mcp.codexSampleNote': '~/.codex/config.toml のサンプル:',
  'settings.mcp.connInfoLabel': '接続情報 (現在値):',


  // ---------- Onboarding ----------
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
  'onboarding.done.cta': 'エディタを開く',
};
