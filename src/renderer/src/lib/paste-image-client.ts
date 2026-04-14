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
  const buffer = await blob.arrayBuffer();
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, i + chunkSize))
    );
  }
  const base64 = btoa(binary);

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
