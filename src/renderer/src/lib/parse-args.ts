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
 */
export function parseShellArgs(input: string): string[] {
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
  return args;
}
