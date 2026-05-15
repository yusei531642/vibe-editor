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

/** Issue #729: 旧 FIXED_LABELS_JA/EN は i18n.ts の `settings.section.*` キーへ移管した。
 *  固定セクション ID の列挙のみ残し、ラベル / タイトル / 説明は呼び出し側で
 *  t(`settings.section.${id}.{label|title|desc}`) を解決する。 */
export const FIXED_SECTION_IDS = [
  'general',
  'appearance',
  'fonts',
  'claude',
  'codex',
  'roles',
  'mcp',
  'logs'
] as const;

export type FixedSectionId = (typeof FIXED_SECTION_IDS)[number];

export type FixedLabelEntry = { label: string; title: string; desc: string };

/** 指定 id のラベル情報を返す (固定 + カスタム動的)。
 *  Issue #729: 旧実装は isJa: boolean と FIXED_LABELS_JA/EN 静的テーブルに依存していたが、
 *  i18n.ts への移管に伴い `t` 関数を受け取って t(`settings.section.${id}.*`) を解決する形に変更。
 *  caller (SettingsModal / useSettingsNav) は useT() の戻り値をそのまま渡す。 */
export function labelOf(
  id: SectionId,
  t: (key: string, params?: Record<string, string | number>) => string,
  customAgents: { id: string; name: string }[]
): FixedLabelEntry {
  if ((FIXED_SECTION_IDS as readonly string[]).includes(id)) {
    return {
      label: t(`settings.section.${id}.label`),
      title: t(`settings.section.${id}.title`),
      desc: t(`settings.section.${id}.desc`)
    };
  }
  if (id.startsWith('custom:')) {
    const a = customAgents.find((x) => `custom:${x.id}` === id);
    const name = a?.name || t('settings.section.untitled');
    return {
      label: name,
      title: name,
      desc: t('settings.section.customDesc')
    };
  }
  if (id === '__addCustom') {
    const label = t('settings.section.addCustom');
    return { label, title: label, desc: '' };
  }
  return { label: id, title: id, desc: '' };
}
