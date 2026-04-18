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
 */
export function parseShellArgs(input: string): string[] {
  return parseShellArgsInternal(input).args;
}

/**
 * Issue #76: 閉じクォート忘れを error として返すバージョン。
 * 呼び出し側で UI 警告を出すのに使う。
 */
export interface ParseShellArgsResult {
  args: string[];
  /** クォートが閉じずに入力が終わった場合 true */
  unterminatedQuote: boolean;
}

export function parseShellArgsStrict(input: string): ParseShellArgsResult {
  return parseShellArgsInternal(input);
}

function parseShellArgsInternal(input: string): ParseShellArgsResult {
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
