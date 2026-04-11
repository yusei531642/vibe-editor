import type { SkillInfo } from '../../../types/shared';

/**
 * CLAUDE.md 内でスキル有効化状態を保存するための管理ブロック。
 *
 * ```
 * <!-- claude-editor:skills:start -->
 * ## 有効化されているスキル
 *
 * - [x] skill-name — description
 * - [ ] other-skill — description
 * <!-- claude-editor:skills:end -->
 * ```
 *
 * - このマーカー間のみがアプリによって書き換えられる
 * - 外部のテキストは一切触らない
 */

export const SKILLS_BLOCK_START = '<!-- claude-editor:skills:start -->';
export const SKILLS_BLOCK_END = '<!-- claude-editor:skills:end -->';

const BLOCK_RE = new RegExp(
  `${escapeRe(SKILLS_BLOCK_START)}[\\s\\S]*?${escapeRe(SKILLS_BLOCK_END)}`
);

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 説明文を1行あたり上限文字数で切り詰める */
function shortDescription(desc: string, limit = 120): string {
  const single = desc.replace(/\s+/g, ' ').trim();
  if (single.length <= limit) return single;
  return single.slice(0, limit - 1) + '…';
}

/** CLAUDE.md 本文から、有効化されているスキル名の集合を取得 */
export function parseEnabledSkills(markdown: string): Set<string> {
  const block = markdown.match(BLOCK_RE);
  if (!block) return new Set();

  const enabled = new Set<string>();
  // `- [x] name — description` / `- [ ] name — description`
  const lineRe = /^\s*-\s*\[([ xX])\]\s*([^\s—-][^—\n]*?)(?:\s+[—-]\s*.*)?$/gm;
  let m: RegExpExecArray | null;
  while ((m = lineRe.exec(block[0])) !== null) {
    const checked = m[1].toLowerCase() === 'x';
    const name = m[2].trim();
    if (checked) enabled.add(name);
  }
  return enabled;
}

/**
 * 既存の CLAUDE.md に対し、指定スキル一覧と有効化状態で管理ブロックを更新する。
 * - ブロックが存在すれば置換
 * - 存在しなければ末尾に追記（空ファイルの場合は単独でブロックのみ書き出す）
 */
export function writeSkillsBlock(
  markdown: string,
  skills: SkillInfo[],
  enabled: Set<string>
): string {
  const lines: string[] = [
    SKILLS_BLOCK_START,
    '## 有効化されているスキル',
    '',
    '<!-- このブロックは claude-editor によって管理されています。手動編集可。 -->',
    ''
  ];

  if (skills.length === 0) {
    lines.push('_(利用可能なスキルが見つかりません)_');
  } else {
    for (const s of skills) {
      const mark = enabled.has(s.name) ? 'x' : ' ';
      const desc = shortDescription(s.description);
      lines.push(`- [${mark}] ${s.name}${desc ? ` — ${desc}` : ''}`);
    }
  }

  lines.push('', SKILLS_BLOCK_END);
  const block = lines.join('\n');

  if (BLOCK_RE.test(markdown)) {
    return markdown.replace(BLOCK_RE, block);
  }

  const sep = markdown.length === 0 || markdown.endsWith('\n') ? '\n' : '\n\n';
  return markdown + sep + block + '\n';
}
