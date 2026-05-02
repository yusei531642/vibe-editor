import {
  Bot,
  Code2,
  Palette,
  Plug,
  ScrollText,
  Settings as SettingsIcon,
  Sparkles,
  Type,
  Users,
  type LucideIcon
} from 'lucide-react';

/**
 * SectionId はカスタムエージェント対応のため動的な文字列。
 * 固定セクション: 'general' | 'appearance' | 'fonts' | 'claude' | 'codex' | 'roles' | 'mcp' | 'logs'
 * カスタムエージェント: `custom:${agentId}`
 */
export type SectionId = string;

/** セクション ID → サイドバー Lucide アイコン。
 *
 *  旧実装は JSX リテラルをモジュールスコープに保持していたが、これは
 *  React.StrictMode の二重レンダリングや React Server Components 移行時に
 *  「複数のレンダーが同一インスタンスを共有する」前提が崩れる懸念がある。
 *  → アイコンコンポーネント自体だけを参照し、props (size/strokeWidth) は
 *     共通定数として再利用、JSX は呼び出しごとに都度生成する形に統一する。
 *     パフォーマンスへの影響はこの規模では実測差が出ないため、安全側に倒す。 */
export const ICON_PROPS = { size: 14, strokeWidth: 1.85 } as const;
// SECTION_ICON_TYPES の値は lucide-react のアイコン (LucideIcon) なので、
// 旧 React.ComponentType<typeof ICON_PROPS> (リテラル {size:14}) ではなく
// LucideIcon 型を使うほうが正確で意図が伝わる (レビュー指摘)。
export const SECTION_ICON_TYPES: Record<string, LucideIcon> = {
  general: SettingsIcon,
  appearance: Palette,
  fonts: Type,
  claude: Bot,
  codex: Code2,
  roles: Users,
  mcp: Plug,
  logs: ScrollText
};
export function iconFor(id: SectionId): JSX.Element {
  const Icon =
    SECTION_ICON_TYPES[id] ??
    (id.startsWith('custom:') ? Sparkles : SECTION_ICON_TYPES.general);
  return <Icon {...ICON_PROPS} />;
}

/** 固定セクションのラベル / タイトル / 説明 (i18n)。
 *  毎レンダー新規オブジェクトを生成すると useMemo の deps チェーンが無効化されるため、
 *  ja / en それぞれをモジュールスコープで 1 度だけ作る。 */
export type FixedLabelEntry = { label: string; title: string; desc: string };
export const FIXED_LABELS_JA: Record<string, FixedLabelEntry> = {
  general: { label: '一般', title: '一般', desc: '言語と密度設定' },
  appearance: { label: '表示', title: '表示', desc: 'テーマ、配色、キャラクター' },
  fonts: { label: 'フォント', title: 'フォント', desc: 'UI / エディタ / ターミナルのフォント' },
  claude: { label: 'Claude Code', title: 'Claude Code', desc: '起動コマンドと引数' },
  codex: { label: 'Codex', title: 'Codex', desc: '起動コマンドと引数' },
  roles: { label: 'ロール定義', title: 'ロール定義', desc: 'チームメンバーの役割テンプレ' },
  mcp: { label: 'MCP', title: 'MCP', desc: 'vibe-team MCP の導入方法' },
  logs: { label: 'ログ', title: 'ログ', desc: 'アプリの実行ログを表示' }
};
export const FIXED_LABELS_EN: Record<string, FixedLabelEntry> = {
  general: { label: 'General', title: 'General', desc: 'Language and density' },
  appearance: { label: 'Appearance', title: 'Appearance', desc: 'Theme, surfaces, and character' },
  fonts: { label: 'Fonts', title: 'Typography', desc: 'UI / editor / terminal fonts' },
  claude: { label: 'Claude Code', title: 'Claude Code', desc: 'Launch command and args' },
  codex: { label: 'Codex', title: 'Codex', desc: 'Launch command and args' },
  roles: { label: 'Role profiles', title: 'Role profiles', desc: 'Team member role templates' },
  mcp: { label: 'MCP', title: 'MCP', desc: 'How to install vibe-team MCP' },
  logs: { label: 'Logs', title: 'Logs', desc: 'View runtime logs from the app' }
};

/** 名前未設定のカスタムエージェントに使う fallback 文字列。
 *  fixedLabels と同じく言語切替で同期するモジュール定数として持つことで、
 *  groups useMemo の closure から isJa を直接参照しないで済むようにする。 */
export const UNTITLED_FALLBACK_JA = '（無名）';
export const UNTITLED_FALLBACK_EN = '(untitled)';

/** 指定 id のラベル情報を返す (固定 + カスタム動的)。
 *  元 SettingsModal.tsx 内では closure で customAgents / isJa を参照していたが、
 *  独立 module 化に伴い pure 関数として引数化した。 */
export function labelOf(
  id: SectionId,
  isJa: boolean,
  customAgents: { id: string; name: string }[]
): { label: string; title: string; desc: string } {
  const fixedLabels = isJa ? FIXED_LABELS_JA : FIXED_LABELS_EN;
  if (fixedLabels[id]) return fixedLabels[id];
  if (id.startsWith('custom:')) {
    const a = customAgents.find((x) => `custom:${x.id}` === id);
    const name = a?.name || (isJa ? UNTITLED_FALLBACK_JA : UNTITLED_FALLBACK_EN);
    return {
      label: name,
      title: name,
      desc: isJa ? 'カスタムエージェント設定' : 'Custom agent settings'
    };
  }
  if (id === '__addCustom') {
    return {
      label: isJa ? '+ 追加' : '+ Add',
      title: isJa ? '+ 追加' : '+ Add',
      desc: ''
    };
  }
  return { label: id, title: id, desc: '' };
}
