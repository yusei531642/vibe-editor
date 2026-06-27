/**
 * use-skill-injection — CLI エージェントの skill 注入を司る hook (Issue #1125)。
 *
 * AgentNodeCard / CardFrame から skill 注入ロジックを切り出したもの (god-file 回避)。
 * `skillInjection` の capability に応じて 2 経路を扱う:
 *   - 'claude-dir'  : mount 時に既定 skill をプロジェクトの .claude/skills へ best-effort で
 *                     materialize する。claude/codex は起動時に .claude/skills を自動探索する
 *                     ため、手動「適用」なしに skill が効く。書き込みは idempotent。
 *   - 'prompt-file' : 選択 skill の本文を読み込み、戻り値の preamble として返す。呼び出し側は
 *                     これを system prompt に前置し、temp ファイル経由 (codex の
 *                     model_instructions_file / claude の append-system-prompt-file) で渡す。
 *                     codex は .claude/skills を自動探索しないため、この経路でのみ skill が効く。
 *   - 'none'        : 何もしない (preamble は空文字)。
 *
 * いずれも mount 時 best-effort で、失敗は warn に留めて起動を妨げない。ユーザー起動の
 * 「プロジェクトに適用」(設定エディタ) は別途トーストで結果を返すため、ここでは通知しない
 * (全カード mount でのトースト連発を避ける)。
 */
import { useEffect, useMemo, useState } from 'react';
import type { AgentSkillInjection, ApiAgentSkillBody } from '../../../types/shared';

/** prompt-file 注入用に skill 本文を system prompt セクションへ整形する。
 *  Rust 側 `build_skills_context` と同じ `## Skill: name (id)` 見出し形式に揃え、LLM が
 *  読む内容なので UI 言語に依存しない固定見出しを使う。 */
export function buildSkillPreamble(skills: ApiAgentSkillBody[]): string {
  if (skills.length === 0) return '';
  return skills.map((s) => `## Skill: ${s.name} (${s.id})\n${s.body.trim()}`).join('\n\n');
}

interface SkillInjectionInput {
  skillInjection: AgentSkillInjection;
  defaultSkillIds: string[];
}

/**
 * descriptor の skill 注入を実行し、prompt-file 経路の preamble (空なら '') を返す。
 * claude-dir 経路は副作用 (materialize) のみで preamble は空。
 */
export function useSkillInjection(input: SkillInjectionInput): string {
  const { skillInjection, defaultSkillIds } = input;

  // claude-dir: mount 時に .claude/skills へ materialize (best-effort, idempotent)。
  useEffect(() => {
    if (skillInjection !== 'claude-dir') return;
    if (!defaultSkillIds || defaultSkillIds.length === 0) return;
    void window.api.apiAgents
      .applySkillsToProject(defaultSkillIds)
      .catch((e) => console.warn('[agent-card] skill materialize failed:', e));
  }, [skillInjection, defaultSkillIds]);

  // prompt-file: 選択 skill の本文を読み込み preamble 化する。
  const [skillBodies, setSkillBodies] = useState<ApiAgentSkillBody[]>([]);
  useEffect(() => {
    if (skillInjection !== 'prompt-file' || !defaultSkillIds || defaultSkillIds.length === 0) {
      setSkillBodies([]);
      return;
    }
    let cancelled = false;
    void window.api.apiAgents
      .loadSkillBodies(defaultSkillIds)
      .then((skills) => {
        if (!cancelled) setSkillBodies(skills);
      })
      .catch((e) => {
        if (cancelled) return;
        setSkillBodies([]);
        console.warn('[agent-card] skill body load failed:', e);
      });
    return () => {
      cancelled = true;
    };
  }, [skillInjection, defaultSkillIds]);

  return useMemo(() => buildSkillPreamble(skillBodies), [skillBodies]);
}
