/**
 * 簡易シェルライクな引数パーサ。
 * - 空白で分割
 * - ダブルクォート `"..."` で空白を含めた塊を作れる
 * - バックスラッシュエスケープは未対応（Windowsパス互換のため `\` は生かす）
 * - シングルクォートは対象外（多くのシェルで異なる挙動なため）
 *
 * 例:
 *   parseShellArgs('--model opus --add-dir "D:/my projects/foo"')
 *   // => ['--model', 'opus', '--add-dir', 'D:/my projects/foo']
 *
 * Issue #76: 閉じクォートが無いまま入力が終わった場合、従来は silent に残りを
 * 1 つの token として詰め込んでいた。ユーザーの typo を検知できないため、
 * `parseShellArgsStrict` を別途公開し、settings 保存フローから呼び出せるようにする。
 *
 * Issue #449: 入力ソース (IME / コピペ / ハイフン自動補正) によっては U+2013 (en dash)
 * 等の Unicode ダッシュが option token 先頭に混入する。Codex CLI / Claude CLI はこれを
 * option として解釈しないため、`--dangerously-bypass-approvals-and-sandbox` のような
 * 重要フラグが silent に無視され、ワーカー多重起動時に承認ダイアログが連発する。
 * `parseShellArgs` では token 先頭の Unicode ダッシュを ASCII '-' に正規化して救済し、
 * `parseShellArgsStrict` では正規化前の混入を warning として呼び出し側に通知する。
 */
export function parseShellArgs(input: string): string[] {
  return parseShellArgsInternal(input).args.map(normalizeLeadingDashes);
}

/**
 * Issue #76 / #449: 閉じクォート忘れと Unicode dash 混入を呼び出し側に伝えるバージョン。
 * UI で警告を出すのに使う。
 */
export interface ParseShellArgsResult {
  args: string[];
  /** クォートが閉じずに入力が終わった場合 true */
  unterminatedQuote: boolean;
  /**
   * Issue #449: 先頭が Unicode ダッシュ (U+2013 / U+2014 / U+2212 等) の token が
   * 1 つでもあった場合 true。`args` 自体は ASCII '-' に正規化済みなので、UI 警告だけ
   * を出して値はそのまま使ってもらう想定。
   */
  hasUnicodeDash: boolean;
}

export function parseShellArgsStrict(input: string): ParseShellArgsResult {
  const internal = parseShellArgsInternal(input);
  let hasUnicodeDash = false;
  const normalized = internal.args.map((arg) => {
    const next = normalizeLeadingDashes(arg);
    if (next !== arg) hasUnicodeDash = true;
    return next;
  });
  return {
    args: normalized,
    unterminatedQuote: internal.unterminatedQuote,
    hasUnicodeDash
  };
}

function parseShellArgsInternal(input: string): {
  args: string[];
  unterminatedQuote: boolean;
} {
  const args: string[] = [];
  let current = '';
  let inQuotes = false;
  let hasCurrent = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      hasCurrent = true;
      continue;
    }
    if ((ch === ' ' || ch === '\t') && !inQuotes) {
      if (hasCurrent) {
        args.push(current);
        current = '';
        hasCurrent = false;
      }
      continue;
    }
    current += ch;
    hasCurrent = true;
  }
  if (hasCurrent) args.push(current);
  return { args, unterminatedQuote: inQuotes };
}

/**
 * Issue #449: token 先頭の Unicode dash 系文字を ASCII '--' (long option prefix) に置換する。
 *
 * 対象 Unicode ダッシュ (各種スマートクォート/全角):
 *   - U+2010 HYPHEN          "‐"
 *   - U+2011 NON-BREAKING H. "‑"
 *   - U+2012 FIGURE DASH     "‒"
 *   - U+2013 EN DASH         "–"
 *   - U+2014 EM DASH         "—"
 *   - U+2015 HORIZONTAL BAR  "―"
 *   - U+2212 MINUS SIGN      "−"
 *   - U+FE58 SMALL EM DASH   "﹘"
 *   - U+FE63 SMALL HYPHEN-M. "﹣"
 *   - U+FF0D FULLWIDTH HYP.  "－"
 *
 * macOS / iOS / MS Word の autocorrect は `--` を `–` (en dash) に変換するため、
 * Unicode dash で始まる token は元々 `--` (long option) を意図していたケースがほぼ全て。
 * カウント数に関係なく一律 `--` に正規化することで `--dangerously-bypass-approvals-and-sandbox`
 * のような flag を救済する。短縮形 `-x` は Unicode dash に化けないので影響しない。
 *
 * `--foo=–value` のように option の value 側に Unicode dash が含まれていても、token 先頭
 * (= ASCII '-' で始まる) には触らないので影響しない。
 */
const UNICODE_DASH_RE = /^[‐‑‒–—―−﹘﹣－][‐‑‒–—―−﹘﹣－\-]*/;

export function normalizeLeadingDashes(token: string): string {
  if (!token) return token;
  return token.replace(UNICODE_DASH_RE, () => '--');
}

/**
 * Issue #1097: parse 済み args 列から明示的なモデル指定 (`--model` / `-m`) を検出して値を返す。
 * 指定が無ければ `null`。値が次トークンの形式 (`--model opus`) も `=` 形式 (`--model=opus`) も対応。
 * フラグのみで値が続かない場合は空文字を返す。
 */
export function findModelOverride(args: string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--model' || a === '-m') return args[i + 1] ?? '';
    if (a.startsWith('--model=')) return a.slice('--model='.length);
    if (a.startsWith('-m=')) return a.slice('-m='.length);
  }
  return null;
}

/** Issue #1097: custom-agent 起動前に出す警告 (i18n key + params)。UI 側で `t()` 評価して toast 表示。 */
export interface CustomAgentArgWarning {
  messageKey: string;
  params?: Record<string, string>;
}

/**
 * Issue #1097: custom-agent の `args` 文字列を parse しつつ、起動前にユーザーへ出すべき警告を返す。
 * - G1: 未閉じクォート / Unicode ダッシュ混入 (`customAgent.warn.args`)
 * - G2: 明示モデル指定 (`customAgent.warn.modelOverride`) — プラン未許可だと API error ループの原因。
 * UI 依存を持たない純粋関数 (呼び出し側が warnings を toast 表示する)。`args` は正規化済みトークン。
 */
export function parseCustomAgentArgs(raw: string | undefined | null): {
  args: string[];
  warnings: CustomAgentArgWarning[];
} {
  if (!raw) return { args: [], warnings: [] };
  const parsed = parseShellArgsStrict(raw);
  const warnings: CustomAgentArgWarning[] = [];
  if (parsed.unterminatedQuote || parsed.hasUnicodeDash) {
    warnings.push({ messageKey: 'customAgent.warn.args' });
  }
  const model = findModelOverride(parsed.args);
  if (model !== null) {
    warnings.push({ messageKey: 'customAgent.warn.modelOverride', params: { model: model || '?' } });
  }
  return { args: parsed.args, warnings };
}
