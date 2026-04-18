/**
 * 簡易シェルライクな引数パーサ。
 * - 空白で分割
 * - ダブルクォート `"..."` で空白を含めた塊を作れる
 * - バックスラッシュエスケープは未対応（Windowsパス互換のため `\` は生かす）
 * - シングルクォートは対象外（多くのシェルで異なる挙動なため）
 */

export interface ParseShellArgsResult {
  ok: boolean;
  args: string[];
  /** Issue #76: 閉じクォート忘れなどのエラーメッセージ (UI 表示用) */
  error?: string;
}

/**
 * Issue #76: 閉じクォートが検出できなかったときに error を返す安全版。
 *
 * 例:
 *   parseShellArgsStrict('--model opus "missing-end')
 *   // => { ok: false, args: [...], error: 'Unmatched quote (\")' }
 */
export function parseShellArgsStrict(input: string): ParseShellArgsResult {
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
  if (inQuotes) {
    return { ok: false, args, error: 'Unmatched quote (")' };
  }
  return { ok: true, args };
}

/**
 * 旧 API。閉じクォート不一致でも silent に accept して args を返す (後方互換)。
 * 新しいコードは `parseShellArgsStrict` を使って UI で error を表示することを推奨。
 *
 * 例:
 *   parseShellArgs('--model opus --add-dir "D:/my projects/foo"')
 *   // => ['--model', 'opus', '--add-dir', 'D:/my projects/foo']
 */
export function parseShellArgs(input: string): string[] {
  const r = parseShellArgsStrict(input);
  if (!r.ok) {
    // console だけに残す。設定入力の validate は SettingsModal が別途拾う想定。
    // eslint-disable-next-line no-console
    console.warn('[parse-args] Unmatched quote in:', input);
  }
  return r.args;
}
