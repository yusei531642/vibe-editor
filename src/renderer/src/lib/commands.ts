/**
 * コマンドパレット用のコマンド定義。
 * App.tsx から hooks/handlers を受け取って動的に構築する。
 */

export interface Command {
  id: string;
  title: string;
  /** 副題（ショートカット表示など） */
  subtitle?: string;
  /** カテゴリラベル（例: 'ファイル', 'ビュー', 'ターミナル'） */
  category: string;
  /** 表示条件（falseなら非表示） */
  when?: () => boolean;
  run: () => void | Promise<void>;
}

/** ファジー検索: クエリの各文字がタイトル内に順序通り出現するかでスコア付け。 */
export function fuzzyMatch(query: string, target: string): number {
  if (!query) return 1;
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (t.includes(q)) {
    // 連続一致を高スコアに
    return 100 - (t.indexOf(q) / Math.max(1, t.length)) * 50;
  }
  // 飛び飛び一致: 文字順序チェック
  let qi = 0;
  let score = 0;
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) {
      score += 1;
      qi++;
    }
  }
  if (qi < q.length) return 0; // 全文字を拾えない
  return score;
}

export function filterCommands(commands: Command[], query: string): Command[] {
  const visible = commands.filter((c) => (c.when ? c.when() : true));
  if (!query.trim()) return visible;
  return visible
    .map((c) => ({ c, score: fuzzyMatch(query, `${c.category} ${c.title}`) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.c);
}
