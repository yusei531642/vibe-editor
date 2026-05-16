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
      'no-constant-condition': ['warn', { checkLoops: false }]
    }
  }
);
