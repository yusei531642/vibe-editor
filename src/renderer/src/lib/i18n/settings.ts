/* eslint-disable no-restricted-syntax -- i18n辞書本体のため、日本語文字列リテラルをここに集約する */
import type { Dict } from './index';

// 設定モーダル・テーマ・表示設定辞書。公開キーは aggregator で既存 i18n API に統合される。

export const settingsJa: Dict = {

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
  'mascot.desc.custom': '自分で用意した画像 (PNG/GIF/SVG/WebP) を相棒として使う',

  // ---------- Canvas HUD ----------
  'fonts.family': 'フォントファミリ',
  'fonts.custom': '（カスタム）',
  'fonts.size': 'サイズ (px)',
  'fonts.customCss': 'カスタム CSS font-family',

  // ---------- Roles ----------

  // ---------- Settings ----------
  'settings.title': '設定',
  // Issue #729: WelcomePane の inline isJa を i18n.ts に移管
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

  // ---------- Toast ----------
  'settings.command': 'コマンド',
  'settings.argsUnterminatedQuote': 'ダブルクォート (") が閉じていません。引数が誤って解釈される可能性があります。',
  'settings.argsUnicodeDash':
    'Unicode ダッシュ (–, — など) が含まれています。実行時に ASCII の "--" に自動変換します。コピペや IME の自動変換が原因の可能性があります。',

  // ---------- Custom agents ----------

};

export const settingsEn: Dict = {

  'settings.mascot.title': 'Character',
  'settings.mascot.pickTitle': 'Pick a mascot image',
  'settings.mascot.imageFilterName': 'Images',
  'settings.mascot.choose': 'Choose image…',
  'settings.mascot.clear': 'Clear',
  'settings.mascot.hint':
    'PNG / GIF (animated) / APNG / WebP / SVG. A small square (32–128 px) renders best.',
  'mascot.desc.vibe': 'Default tiny companion',
  'mascot.desc.spark': 'Brighter and lighter',
  'mascot.desc.mono': 'A terminal-friendly angular look',
  'mascot.desc.coder': 'A tiny companion typing at a computer',
  'mascot.desc.custom': 'Use your own image (PNG/GIF/SVG/WebP) as the companion',

  // ---------- Canvas HUD ----------
  'fonts.family': 'Font family',
  'fonts.custom': '(custom)',
  'fonts.size': 'Size (px)',
  'fonts.customCss': 'Custom CSS font-family',

  // ---------- Roles ----------

  // ---------- Settings ----------
  'settings.title': 'Settings',
  // Issue #729: WelcomePane inline isJa moved into i18n.ts
  'settings.roles.title': 'Role profiles',
  'settings.roles.desc':
    'Define vibe-team member roles. Leaders pick from these when calling team_recruit.',
  'settings.roles.globalPreamble': 'Global preamble',
  'settings.roles.globalPreambleHint': 'Prepended to all prompts',
  'settings.roles.confirmDelete': 'Delete "{id}"?',
  'settings.roles.addCustom': 'Add custom role',
  'settings.roles.newCustomDesc': 'New custom role.',
  'settings.roles.builtin': 'built-in',
  'settings.roles.custom': 'custom',
  'settings.roles.color': 'Color',
  'settings.roles.glyph': 'Glyph',
  'settings.roles.defaultEngine': 'Default engine',
  'settings.roles.permissions': 'Permissions',
  'settings.roles.promptEn': 'System prompt (EN)',
  'settings.roles.promptJa': 'System prompt (JA)',
  'settings.roles.promptPlaceholders':
    'Available: {teamName} {selfLabel} {selfDescription} {roster} {tools} {globalPreamble}',
  'settings.roles.deleteRole': 'Delete this role',
  // Issue #729: settings-section-meta.tsx FIXED_LABELS_EN moved into i18n.ts
  'settings.section.general.label': 'General',
  'settings.section.general.title': 'General',
  'settings.section.general.desc': 'Language and density',
  'settings.section.appearance.label': 'Appearance',
  'settings.section.appearance.title': 'Appearance',
  'settings.section.appearance.desc': 'Theme, surfaces, and character',
  'settings.section.fonts.label': 'Fonts',
  'settings.section.fonts.title': 'Typography',
  'settings.section.fonts.desc': 'UI / editor / terminal fonts',
  'settings.section.claude.label': 'Claude Code',
  'settings.section.claude.title': 'Claude Code',
  'settings.section.claude.desc': 'Launch command and args',
  'settings.section.codex.label': 'Codex',
  'settings.section.codex.title': 'Codex',
  'settings.section.codex.desc': 'Launch command and args',
  // Issue #1068: codex team_send delivery method toggle
  'settings.codexDelivery.title': 'team_send delivery',
  'settings.codexDelivery.label': 'Delivery method',
  'settings.codexDelivery.optBackend': 'Backend (app-server) — falls back to PTY if unavailable',
  'settings.codexDelivery.optPty': 'PTY injection — always paste into the terminal',
  'settings.codexDelivery.hint':
    'How team_send reaches codex: via the official codex app-server (JSON-RPC) or the legacy PTY paste into the terminal. Backend keeps history and avoids input races, but automatically falls back to PTY when the app-server is unavailable. Windows always uses PTY (app-server is not supported).',
  'settings.section.roles.label': 'Role profiles',
  'settings.section.roles.title': 'Role profiles',
  'settings.section.roles.desc': 'Team member role templates',
  'settings.section.mcp.label': 'MCP',
  'settings.section.mcp.title': 'MCP',
  'settings.section.mcp.desc': 'How to install vibe-team MCP',
  // Issue #825: Voice Direction Mode (Beta)
  'settings.section.voice.label': 'Voice (Beta)',
  'settings.section.voice.title': 'Voice Direction',
  'settings.section.voice.desc':
    'Direct your Leader by talking to an AI assistant via OpenAI Realtime API.',
  'settings.voice.beta.warning':
    'This feature is in beta and has not been tested. Unexpected behavior, unstable connections, or misrecognition may occur. Please share feedback on GitHub Issues.',
  'settings.voice.enabled.label': 'Enable voice direction',
  'settings.voice.apiKey.label': 'API key',
  'settings.voice.apiKey.placeholder': 'sk-...',
  'settings.voice.apiKey.save': 'Save',
  'settings.voice.apiKey.clear': 'Clear',
  'settings.voice.apiKey.clearConfirm': 'Delete the saved API key?',
  'settings.voice.apiKey.savedNotice':
    'Your API key is encrypted and securely stored in your OS keyring (Credential Manager on Windows, Keychain on macOS, secret-service on Linux). Once saved, it cannot be viewed again. Click "Clear" to re-enter.',
  'settings.voice.model.label': 'Model',
  'settings.voice.voiceName.label': 'AI voice',
  'settings.voice.language.label': 'Language',
  'settings.voice.inputDevice.label': 'Input device (microphone)',
  'settings.voice.outputDevice.label': 'Output device (speaker)',
  'settings.voice.shortcut.label': 'Toggle shortcut',
  'settings.voice.shortcut.reset': 'Reset',
  'settings.voice.shortcut.capturing': 'Capturing… (press a key combination)',
  'settings.voice.confirmation.label': 'Send confirmation',
  'settings.voice.confirmation.always': 'Always confirm (recommended)',
  'settings.voice.confirmation.bypass': 'Bypass confirmation',
  'settings.voice.confirmation.bypassWarning':
    'When bypassed, both the AI verbal confirmation and the renderer-side final check are skipped. Misrecognized speech may be sent to the Leader immediately.',
  'settings.voice.disclaimer.title': 'Voice Direction (Beta)',
  'settings.voice.disclaimer.body':
    'This feature is in beta and has not been tested by the developers. Unexpected behavior may occur.\n\nPlease read before using:\n- It uses the OpenAI Realtime API. API charges apply.\n- Your API key is stored encrypted in your OS keyring.\n- Microphone permission is required.\n- Recognition accuracy and connection stability depend on your environment.\n- Please report issues and feedback on GitHub Issues.',
  'settings.voice.disclaimer.ack': 'I understand',
  'settings.section.logs.label': 'Logs',
  'settings.section.logs.title': 'Logs',
  'settings.section.logs.desc': 'View runtime logs from the app',
  'settings.section.untitled': '(untitled)',
  'settings.section.customDesc': 'Custom agent settings',
  'settings.section.addCustom': '+ Add',
  'settings.section.group.agents': 'Agents',
  'settings.section.group.team': 'Team',
  'settings.section.group.other': 'Other',
  // Issue #729: SettingsModal inline isJa moved into i18n.ts
  'settings.dialog.label': 'Settings',
  'settings.back': 'Back',
  'settings.sections.ariaLabel': 'Settings sections',
  'settings.saveFailedSeeConsole': 'Failed to save settings. See the developer console for details.',
  'settings.search.placeholder': 'Search settings…',
  'settings.search.ariaLabel': 'Search settings',
  'settings.search.clear': 'Clear',
  'settings.search.noMatches': 'No matches',
  'settings.fonts.uiFontTitle': 'UI Font',
  'settings.fonts.editorFontTitle': 'Editor Font (Monaco)',
  'settings.launch.title': 'Launch options',
  'settings.launch.argsLabel': 'Arguments',
  'settings.launch.argsLabelSimple': 'Arguments',
  'settings.launch.cwdLabel': 'Working directory',
  'settings.launch.cwdUnset': '(unset)',
  'settings.launch.applyNote': 'Restart terminals to apply changes.',
  'settings.language': 'Language',
  'settings.language.desc':
    'Switch the UI language. Does not affect the language Claude Code responds in.',
  'settings.theme': 'Theme',
  'settings.uiFont': 'UI font',
  'settings.uiFontFamily': 'Font family',
  'settings.uiFontSize': 'Size (px)',
  'settings.editorFont': 'Editor font (Monaco)',
  'settings.editorFontFamily': 'Font family',
  'settings.editorFontSize': 'Size (px)',
  'settings.terminal': 'Terminal',
  'settings.terminalFontFamily': 'Font',
  'settings.terminalFontSize': 'Font size (px)',
  'settings.terminalNote':
    'Default is JetBrains Mono Nerd Font (bundled). Includes Powerline / Devicons / Material Icons glyphs so Starship and oh-my-posh icons no longer render as tofu. ★ marks bundled fonts that always render the same regardless of OS-installed fonts.',
  'settings.terminalForceUtf8.label': 'Force UTF-8 in Windows terminals (chcp 65001)',
  'settings.terminalForceUtf8.hint':
    'Inject `chcp 65001` when launching cmd.exe / PowerShell so console output is UTF-8. Prevents Japanese / CJK filenames and output from rendering as U+FFFD. Turn this OFF only if you intentionally want to keep the OEM code page. No-op on non-Windows OSes.',
  'settings.terminalForceUtf8.nonWindows': 'This setting only applies on Windows',
  'settings.density': 'Density',
  // Issue #729: DensitySection hardcoded JP desc moved to i18n.ts (mirrors theme.desc / mascot.desc)
  'density.desc.compact': 'For 14" or smaller screens, tighter spacing',
  'density.desc.normal': 'Default',
  'density.desc.comfortable': 'For large screens, roomier spacing',
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

  // ---------- Theme descriptions (ThemeSection theme cards) ----------
  // Issue #729: previously hardcoded JP in settings-options.ts. Now centralised so EN users see English.
  'theme.desc.claude-dark': "Anthropic's official palette. Warm dark brown + coral #D97757 (default)",
  'theme.desc.claude-light': 'Recreates the claude.ai cream background with warm accent colors',
  'theme.desc.dark': 'Classic VS Code-style dark',
  'theme.desc.midnight': 'Deep blue-purple base with purple accents',
  'theme.desc.glass': 'Frosted-glass look — translucent panels + blur',
  'theme.desc.light': 'Bright background, dark text',

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
  'settings.command': 'Command',
  'settings.argsUnterminatedQuote':
    'Unterminated double quote (") — arguments may be parsed incorrectly.',
  'settings.argsUnicodeDash':
    'Contains Unicode dashes (–, — etc.) — they will be normalized to ASCII "--" at runtime. Likely caused by paste or IME autocorrect.',

  // ---------- Custom agents ----------

};
