/**
 * agent-registry.ts — エージェント定義の正規化レジストリ (Issue #1113 Phase1)。
 *
 * built-in (claude / codex) と settings.customAgents を **同一の `ResolvedAgentDescriptor`**
 * に解決する単一の窓口。Canvas カードの表示 (名前 / アイコン / accent) と起動パラメータ、
 * engine 判定、skill 注入方式の既定をここに集約し、`'claude' | 'codex'` リテラルの散在や
 * 「custom が claude に偽装される」状態を解消する。
 *
 * 所有権 (DoD #939): エージェント記述子の解決ロジックはこの module に閉じる。起動の
 * command/args/cwd は `agent-resolver.ts` の `resolveAgentConfig` を単一ソースとして委譲し、
 * 二重定義を作らない。表示メタ (displayName/icon/accentColor/tags) と engine / skill 既定の
 * 合成だけをこの module が担う。
 *
 * 役割分担: この module は **エージェント種別 (claude/codex/custom)** の identity を扱う。
 * カードの **ロール (leader/programmer 等)** ベースの glyph/accent は `agent-visual.ts`
 * (`resolveAgentVisual`) が所有しており軸が直交する。両者を混同しないこと。
 */
import type {
  AgentConfig,
  AgentEngine,
  AgentRuntime,
  AgentSkillInjection,
  ApiAgentProviderId,
  AppSettings
} from '../../../types/shared';
import { resolveAgentConfig } from './agent-resolver';

/** UI / 起動 / skill 判定が参照する、正規化済みのエージェント記述子。 */
export interface ResolvedAgentDescriptor {
  /** 識別子。'claude' | 'codex' | customAgents の id。 */
  id: string;
  /** built-in (同梱) か custom (settings.customAgents) か。 */
  kind: 'builtin' | 'custom';
  /** 'cli' (PTY) か 'api' (Chat)。 */
  runtime: AgentRuntime;
  /** 挙動系統。args/resume/inject の組み立てと team tool 配線がこれで分岐する。 */
  engine: AgentEngine;
  /** カードヘッダー等に出す表示名。 */
  displayName: string;
  /** 表示アイコン (lucide アイコン名)。必ず既定込みで埋める。 */
  icon: string;
  /** accent カラー (CSS color)。省略時は呼び出し側で `--accent` を使う。 */
  accentColor?: string;
  /** 分類・フィルタ用タグ。 */
  tags: string[];
  /** CLI 起動コマンド (runtime === 'cli' のみ意味を持つ)。 */
  command?: string;
  /** CLI 起動引数 (展開前テキスト)。 */
  args?: string;
  /** 作業ディレクトリ。 */
  cwd?: string;
  /** 起動時に注入する環境変数 (Issue #1113)。 */
  env?: Record<string, string>;
  /** 定義レベルの既定 skill 群 (Phase4)。 */
  defaultSkillIds: string[];
  /** skill の注入方式 (Phase4)。 */
  skillInjection: AgentSkillInjection;
  /** API provider id (runtime === 'api' のみ)。 */
  providerId?: ApiAgentProviderId;
  /** API モデル (runtime === 'api' のみ)。 */
  model?: string;
}

/** built-in エージェントの表示メタ。command/args は settings から解決するのでここには持たない。 */
interface BuiltinAgentMeta {
  id: string;
  engine: AgentEngine;
  displayName: string;
  icon: string;
}

const BUILTIN_AGENT_META: BuiltinAgentMeta[] = [
  { id: 'claude', engine: 'claude', displayName: 'Claude Code', icon: 'Sparkles' },
  { id: 'codex', engine: 'codex', displayName: 'Codex', icon: 'Terminal' }
];

/** engine ごとの skill 注入の既定 (Phase4)。claude は .claude/skills 自動探索が効くので materialize。 */
export function defaultSkillInjectionForEngine(engine: AgentEngine): AgentSkillInjection {
  return engine === 'claude' ? 'claude-dir' : 'none';
}

/** runtime ごとのアイコン既定 (custom がアイコン未指定のとき)。 */
function defaultIconForRuntime(runtime: AgentRuntime): string {
  return runtime === 'api' ? 'Bot' : 'Terminal';
}

/** custom agent 設定 (cli/api) の engine を返す。cli は宣言値 (既定 'claude')、api は 'claude' 互換。 */
export function engineForAgentConfig(agent: AgentConfig): AgentEngine {
  if (agent.runtime === 'cli') return agent.engine ?? 'claude';
  // API agent は team tool 配線上 claude 互換として扱う (engine policy の互換維持)。
  return 'claude';
}

/** built-in (claude/codex) の記述子を settings から合成する。 */
export function builtinAgentDescriptors(settings: AppSettings): ResolvedAgentDescriptor[] {
  return BUILTIN_AGENT_META.map((meta) => {
    const resolved = resolveAgentConfig(meta.id, settings);
    return {
      id: meta.id,
      kind: 'builtin' as const,
      runtime: 'cli' as const,
      engine: meta.engine,
      displayName: meta.displayName,
      icon: meta.icon,
      tags: ['builtin'],
      command: resolved.command,
      args: resolved.args,
      cwd: resolved.cwd,
      defaultSkillIds: [],
      skillInjection: defaultSkillInjectionForEngine(meta.engine)
    };
  });
}

/** custom agent 設定を正規化記述子へ変換する。 */
export function customAgentDescriptor(agent: AgentConfig): ResolvedAgentDescriptor {
  const engine = engineForAgentConfig(agent);
  const base = {
    id: agent.id,
    kind: 'custom' as const,
    runtime: agent.runtime,
    engine,
    displayName: agent.name || agent.id,
    icon: agent.icon || defaultIconForRuntime(agent.runtime),
    accentColor: agent.color,
    tags: agent.tags ?? []
  };
  if (agent.runtime === 'cli') {
    return {
      ...base,
      command: agent.command,
      args: agent.args,
      cwd: agent.cwd,
      env: agent.env,
      defaultSkillIds: agent.defaultSkillIds ?? [],
      skillInjection: agent.skillInjection ?? defaultSkillInjectionForEngine(engine)
    };
  }
  return {
    ...base,
    providerId: agent.providerId,
    model: agent.model,
    defaultSkillIds: agent.skillIds ?? [],
    skillInjection: 'none'
  };
}

/** built-in + custom をまとめた記述子一覧 (追加エージェントピッカー / 管理 UI 用, Phase3)。 */
export function listAgentDescriptors(settings: AppSettings): ResolvedAgentDescriptor[] {
  const customs = (settings.customAgents ?? []).map(customAgentDescriptor);
  return [...builtinAgentDescriptors(settings), ...customs];
}

/**
 * カード payload の identity から記述子を解決する。
 *  - agentConfigId が custom にマッチ → その custom 記述子。
 *  - それ以外 → engine (既定 'claude') の built-in 記述子。
 */
export function resolveAgentDescriptor(
  ref: { agentConfigId?: string; engine?: AgentEngine },
  settings: AppSettings
): ResolvedAgentDescriptor {
  if (ref.agentConfigId) {
    const custom = (settings.customAgents ?? []).find((a) => a.id === ref.agentConfigId);
    if (custom) return customAgentDescriptor(custom);
  }
  const engine: AgentEngine = ref.engine ?? 'claude';
  const builtins = builtinAgentDescriptors(settings);
  return builtins.find((d) => d.engine === engine) ?? builtins[0];
}
