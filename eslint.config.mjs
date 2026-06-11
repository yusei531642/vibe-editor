// ESLint flat config — Issue #721
//
// CI に lint ステップを足す目的で導入した「最小・グリーンなベースライン」設定。
// 現行コードベースをエラー 0 で通すことを最優先し、ノイジーなルール
// (no-unused-vars / no-explicit-any / exhaustive-deps 等) は off ないし warn に倒している。
// ここで error にしているのは「実害が大きく、現行コードでは 0 件」の少数ルールのみ。
// 将来の PR で段階的に厳格化していく前提。
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

// Issue #939: i18n ハードコード検知用の日本語文字クラス (ひらがな / カタカナ / CJK 統合漢字 /
// 全角記号・全角英数)。esquery の属性 regex マッチで使う。
const JA_CHARS = '[\\u3000-\\u30ff\\u4e00-\\u9fff\\uff01-\\uff60]';

// Issue #939 時点で既に日本語ハードコードを含むファイルの免除 baseline。
// ここに載っているファイルは違反を「これ以上増やさない」運用 (解消 PR で 1 つずつ削る)。
// 新規ファイルを足すのは「表示文字列でない正当な日本語」がある場合のみ。
const I18N_HARDCODE_BASELINE = [
  'src/renderer/src/components/AppShell.tsx',
  'src/renderer/src/components/canvas/cards/AgentNodeCard/CardFrame.tsx',
  'src/renderer/src/components/canvas/cards/AgentNodeCard/CardHandoff.tsx',
  'src/renderer/src/components/settings/RoleProfilesSection.tsx',
  'src/renderer/src/components/settings/VoiceSection.tsx',
  'src/renderer/src/lib/app-state-context.tsx',
  'src/renderer/src/lib/filetree-state-context.tsx',
  'src/renderer/src/lib/hooks/use-team-launch-helpers.ts',
  'src/renderer/src/lib/hooks/use-xterm-bind.ts',
  'src/renderer/src/lib/paste-image-client.ts',
  'src/renderer/src/lib/role-profiles-context.tsx',
  'src/renderer/src/lib/settings-context.tsx',
  'src/renderer/src/lib/tauri-api.ts',
  'src/renderer/src/lib/toast-context.tsx',
  'src/renderer/src/lib/use-terminal-spawn.ts',
  'src/renderer/src/lib/use-xterm-instance.ts',
  'src/renderer/src/lib/voice-realtime.ts',
  'src/renderer/src/lib/workspace-presets.ts',
  'src/renderer/src/main.tsx'
];

export default tseslint.config(
  {
    // lint 対象外。typecheck / vitest と同じく src/ 配下 (renderer + types) のみを見る。
    // promo-video は独立サブプロジェクト、build / docs / tasks / skills は非ソース。
    ignores: [
      'node_modules/**',
      'dist/**',
      'src-tauri/**',
      'promo-video/**',
      'build/**',
      'docs/**',
      'tasks/**',
      'skills/**',
      '**/*.d.ts'
    ]
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    plugins: {
      // 既存ソースの `// eslint-disable-next-line react-hooks/exhaustive-deps`
      // ディレクティブが解決できるよう plugin を登録する。ルール自体は
      // baseline では warn 止まり (段階導入用)。
      'react-hooks': reactHooks
    },
    linterOptions: {
      // 既存ソースには無効化済みルール向けの eslint-disable コメントが残るが、
      // それらの除去はスコープ外。ベースライン段階では unused-directive を報告しない。
      reportUnusedDisableDirectives: 'off'
    },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module'
    },
    rules: {
      // --- 実害が大きく、現行コードで 0 件のため error に固定 ---
      // デバッガ文の混入はリリースビルドで実害になる。
      'no-debugger': 'error',
      // window.confirm / alert / prompt は描画スレッドをブロックし、
      // Tauri webview では挙動が不安定。#733 で window.confirm は撤去済み。
      'no-restricted-globals': [
        'error',
        { name: 'confirm', message: 'plugin-dialog の ask() / useNativeConfirm を使うこと。' },
        { name: 'alert', message: 'plugin-dialog の message() を使うこと。' },
        { name: 'prompt', message: 'ネイティブ prompt は使わない。専用 UI を実装すること。' }
      ],

      // --- 現行コードに多数当たる / 段階導入したいルールは無効化 or warn ---
      // 将来の PR で error へ引き上げる前提のベースライン。
      'react-hooks/rules-of-hooks': 'warn',
      'react-hooks/exhaustive-deps': 'warn',
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/ban-ts-comment': 'off',
      'no-empty': 'off',
      'no-control-regex': 'off',
      'no-useless-escape': 'off',
      'prefer-const': 'warn',
      'no-constant-condition': ['warn', { checkLoops: false }],

      // Issue #931: raw `invoke` の直叩きを禁止する。IPC 失敗の正規化
      // (`{ code, message }` の CommandError 化) は tauri-api/command-error.ts の
      // `invokeCommand()` に集約されており、raw invoke を使うと reject 値の型が
      // 経路ごとに揺れてエラー種別の機械判別が壊れる (#737 の部分適用の再発防止)。
      // `convertFileSrc` / `listen` 等 invoke 以外の import は制限しない。
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@tauri-apps/api/core',
              importNames: ['invoke'],
              message:
                'raw invoke は禁止。tauri-api/command-error.ts の invokeCommand() を使うこと (Issue #931)。'
            }
          ]
        }
      ]
    }
  },
  // Issue #931: invokeCommand の実装本体だけは raw invoke を import してよい。
  {
    files: ['src/renderer/src/lib/tauri-api/command-error.ts'],
    rules: {
      'no-restricted-imports': 'off'
    }
  },
  // Issue #939: i18n ハードコード検知。renderer 内の「日本語を含む文字列リテラル / JSX テキスト」
  // は t() 未経由のユーザー可視文言である可能性が極めて高く、EN ロケールに日本語が混入する
  // (#906/#907/#887/#844/#845/#822/#819/#818/#727 で 10 回以上再発)。AST ベースなので
  // コメント内の日本語には反応しない。
  //
  // 限界: 「英語ハードコード」(JA ロケールに英語が混入する逆方向) は機械判別できないため
  // 対象外。また i18n 辞書自身・Claude へ渡すプロンプト文字列 (role-profiles-builtin) ・
  // テストフィクスチャは正当な日本語リテラルなので除外する。
  //
  // 既存違反ファイルは「免除リスト」(下の ignores) で ratchet 的に固定する。免除ファイルの
  // 違反解消 PR ではリストから外すこと。**新規ファイルをこのリストに足さない** (足す場合は
  // 正当な理由 — プロンプト定義など表示文字列でない — を PR 説明に明記する)。
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    ignores: [
      // i18n 辞書本体 (ja 文言の定義場所)
      'src/renderer/src/lib/i18n.ts',
      // Claude / Codex へ渡す日本語プロンプト定義 (UI 表示文字列ではない)
      'src/renderer/src/lib/role-profiles-builtin.ts',
      'src/renderer/src/lib/team-prompts.ts',
      // テストフィクスチャ
      'src/renderer/**/*.test.{ts,tsx}',
      // --- 以下、既存違反の免除リスト (#939 時点の baseline。解消 PR で削っていく) ---
      ...I18N_HARDCODE_BASELINE
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: `Literal[value=/${JA_CHARS}/]`,
          message:
            '日本語の文字列リテラルは i18n 辞書 (useT / translate) 経由にしてください (Issue #939)。表示文字列でない正当な日本語の場合は eslint-disable-next-line で理由を明記して opt-out。'
        },
        {
          selector: `TemplateElement[value.raw=/${JA_CHARS}/]`,
          message:
            '日本語のテンプレートリテラルは i18n 辞書 (useT / translate) 経由にしてください (Issue #939)。'
        },
        {
          selector: `JSXText[value=/${JA_CHARS}/]`,
          message:
            'JSX 内の日本語テキストは i18n 辞書 (useT / translate) 経由にしてください (Issue #939)。'
        }
      ]
    }
  }
);
