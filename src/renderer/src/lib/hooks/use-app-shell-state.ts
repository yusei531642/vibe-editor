/**
 * use-app-shell-state — App.tsx 冒頭にあった `const settings = { claudeCommand:
 * useSettingsValue(...), ... }` の合成ブロックを切り出したもの (Issue #487)。
 *
 * `useSettingsValue` ごとに細粒度購読しつつ、利用側 (AppShell / 子コンポーネント
 * に渡す `settings` props) は単一の plain object で読めるよう一段噛ませる。
 * AppShell 以外で本 hook を直接使う想定は無いが、構造を見えるようにすることで
 * 「どの設定値が AppShell render に影響するか」を一望できるようにする副次効果がある。
 */
import { useSettingsValue } from '../settings-context';
import type { AppSettings } from '../../../../types/shared';

/**
 * App.tsx で使われる「shell 描画に影響する設定値の subset」。
 * AppSettings から必要なキーだけを Pick し、optional 性まで含めて型を維持する。
 */
export type AppShellSettings = Pick<
  AppSettings,
  | 'claudeCommand'
  | 'claudeArgs'
  | 'claudeCwd'
  | 'lastOpenedRoot'
  | 'recentProjects'
  | 'workspaceFolders'
  | 'claudeCodePanelWidth'
  | 'sidebarWidth'
  | 'codexCommand'
  | 'codexArgs'
  | 'language'
  | 'theme'
  | 'density'
  | 'statusMascotVariant'
  | 'hasCompletedOnboarding'
  | 'mcpAutoSetup'
>;

export function useAppShellState(): AppShellSettings {
  return {
    claudeCommand: useSettingsValue('claudeCommand'),
    claudeArgs: useSettingsValue('claudeArgs'),
    claudeCwd: useSettingsValue('claudeCwd'),
    lastOpenedRoot: useSettingsValue('lastOpenedRoot'),
    recentProjects: useSettingsValue('recentProjects'),
    workspaceFolders: useSettingsValue('workspaceFolders'),
    claudeCodePanelWidth: useSettingsValue('claudeCodePanelWidth'),
    sidebarWidth: useSettingsValue('sidebarWidth'),
    codexCommand: useSettingsValue('codexCommand'),
    codexArgs: useSettingsValue('codexArgs'),
    language: useSettingsValue('language'),
    theme: useSettingsValue('theme'),
    density: useSettingsValue('density'),
    statusMascotVariant: useSettingsValue('statusMascotVariant'),
    hasCompletedOnboarding: useSettingsValue('hasCompletedOnboarding'),
    mcpAutoSetup: useSettingsValue('mcpAutoSetup')
  };
}
