// Issue #825: マイク / スピーカーのデバイス選択用 helper。
//
// `navigator.mediaDevices.enumerateDevices()` は permission が無いと label が空文字に
// なるので、初回マウント時に `getUserMedia({audio:true})` を一瞬走らせて即停止する
// ことで label を取れるようにする (Web Audio API の標準パターン)。
//
// `audioElement.setSinkId(deviceId)` は Chromium 系のみ対応。WebKitGTK では throw する
// ので caller 側で feature detect (`'setSinkId' in HTMLMediaElement.prototype`) して
// 非対応環境ではフォールバックする責務がある。

export interface AudioDevice {
  /** `MediaDeviceInfo.deviceId`。`'default'` / `'communications'` 等の特殊 id を含む。 */
  deviceId: string;
  /** ユーザー向け表示名 (permission が無いと空文字になる)。 */
  label: string;
  /** `'audioinput'` (マイク) or `'audiooutput'` (スピーカー)。 */
  kind: 'audioinput' | 'audiooutput';
}

export interface AudioDeviceList {
  inputs: AudioDevice[];
  outputs: AudioDevice[];
}

/**
 * `enumerateDevices()` を呼び、audio I/O だけ抽出する。
 *
 * Permission が無くて label が空でも返却する (caller 側で必要なら
 * `ensureAudioPermissionForLabels()` を呼んで label 取得をリトライする)。
 */
export async function listAudioDevices(): Promise<AudioDeviceList> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) {
    return { inputs: [], outputs: [] };
  }
  const devices = await navigator.mediaDevices.enumerateDevices();
  const inputs: AudioDevice[] = [];
  const outputs: AudioDevice[] = [];
  for (const d of devices) {
    if (d.kind === 'audioinput') {
      inputs.push({ deviceId: d.deviceId, label: d.label, kind: 'audioinput' });
    } else if (d.kind === 'audiooutput') {
      outputs.push({ deviceId: d.deviceId, label: d.label, kind: 'audiooutput' });
    }
  }
  return { inputs, outputs };
}

/**
 * permission を取って即停止する (label を解放するためだけ)。
 *
 * Settings UI の初回マウント時に呼ぶ想定。マイク権限ダイアログが出るのでユーザーが拒否
 * すると `permissionDenied` を返す。拒否されても致命的ではない (label が空のまま表示
 * されるだけ) ので caller は no-op として扱える。
 */
export async function ensureAudioPermissionForLabels(): Promise<
  'granted' | 'permissionDenied' | 'unsupported'
> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    return 'unsupported';
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    // 即停止 (label 取得が目的)
    for (const track of stream.getTracks()) track.stop();
    return 'granted';
  } catch {
    return 'permissionDenied';
  }
}

/**
 * `audioElement.setSinkId(deviceId)` を feature detect して呼ぶ。
 *
 * 非対応環境では何もしない (戻り値 false)。空文字 / `'default'` は no-op で true 扱い
 * (= "システム既定" として何もしないが UI に「適用済み」と表示できる)。
 */
export async function applyOutputDevice(
  element: HTMLMediaElement,
  deviceId: string | undefined
): Promise<boolean> {
  if (!deviceId || deviceId === 'default') {
    return true;
  }
  // 型補正: setSinkId は HTMLMediaElement の experimental method。
  const el = element as HTMLMediaElement & {
    setSinkId?: (sinkId: string) => Promise<void>;
  };
  if (typeof el.setSinkId !== 'function') {
    return false;
  }
  try {
    await el.setSinkId(deviceId);
    return true;
  } catch {
    return false;
  }
}
