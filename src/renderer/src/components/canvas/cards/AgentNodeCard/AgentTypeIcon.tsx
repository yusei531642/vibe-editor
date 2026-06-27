/**
 * AgentTypeIcon — agent-registry の `ResolvedAgentDescriptor.icon` (lucide アイコン名) を
 * 実際の lucide コンポーネントへ解決して描画する (Issue #1115 Phase2)。
 *
 * 種別 (claude / codex / custom) をヘッダーで一目で識別するためのアイコン。
 * claude-design 準拠: 16px / strokeWidth 1.75。色は親 (`.canvas-agent-card__type-icon`) の
 * `color` を継承する (custom は accent、builtin はロール accent)。
 * 未知のアイコン名は Terminal にフォールバックする。
 */
import {
  Bot,
  Boxes,
  Cloud,
  Cpu,
  Rocket,
  Sparkles,
  Terminal,
  Wrench,
  type LucideIcon
} from 'lucide-react';

const TYPE_ICONS: Record<string, LucideIcon> = {
  Sparkles,
  Terminal,
  Bot,
  Boxes,
  Cloud,
  Cpu,
  Rocket,
  Wrench
};

export function AgentTypeIcon({ name }: { name: string }): JSX.Element {
  const Icon = TYPE_ICONS[name] ?? Terminal;
  return <Icon size={16} strokeWidth={1.75} aria-hidden="true" />;
}
