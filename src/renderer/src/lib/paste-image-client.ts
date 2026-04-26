/**
 * 画像 Blob を IPC 経由でメインプロセスに一時保存させ、絶対パスを pty に挿入する。
 *
 * - 画像を base64 に変換 → `terminal.savePastedImage` で main にファイル書き出し
 * - 返ったパスに空白が含まれていればダブルクォートで囲む
 * - 末尾にスペースを足して続けて入力しやすくする
 *
 * 失敗時は renderer 側で `term.writeln` 等のエラー表示を行えるよう、
 * `{ ok: false, error }` を返すだけで throw しない。
 */
export async function insertPastedImageToPty(
  blob: Blob,
  mime: string,
  writeToPty: (text: string) => void | Promise<void>
): Promise<{ ok: true } | { ok: false; error: string }> {
  // Issue #160: 旧実装は 32KB チャンクで Array.from(Uint8Array) → String.fromCharCode.apply
  // を回しており、20MB クラスのスクショで Array.from が 20M 要素配列を作成 → UI ハング。
  // FileReader.readAsDataURL で base64 をネイティブ実装一発で取得する方が圧倒的に速い。
  const dataUrl: string = await new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = () => reject(fr.error ?? new Error('FileReader failed'));
    fr.onload = () => resolve(typeof fr.result === 'string' ? fr.result : '');
    fr.readAsDataURL(blob);
  }).catch((e: Error) => {
    return Promise.reject(e);
  });
  // dataUrl は "data:<mime>;base64,<payload>" の形式。payload 部分のみ取り出す。
  const commaIdx = dataUrl.indexOf(',');
  const base64 = commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : '';
  if (!base64) {
    return { ok: false, error: 'pasted image is empty' };
  }

  const res = await window.api.terminal.savePastedImage(base64, mime);
  if (!res.ok || !res.path) {
    return { ok: false, error: res.error ?? '不明なエラー' };
  }

  const p = res.path;
  const needQuote = /\s/.test(p);
  const inserted = (needQuote ? `"${p}"` : p) + ' ';
  await writeToPty(inserted);
  return { ok: true };
}
