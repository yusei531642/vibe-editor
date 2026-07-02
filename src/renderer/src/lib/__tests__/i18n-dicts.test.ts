import { describe, expect, it } from 'vitest';
import { jaShell } from '../i18n/ja-shell';
import { jaCanvas } from '../i18n/ja-canvas';
import { jaSettings } from '../i18n/ja-settings';
import { enShell } from '../i18n/en-shell';
import { enCanvas } from '../i18n/en-canvas';
import { enSettings } from '../i18n/en-settings';

// Issue #1032: i18n 辞書を領域別サブ辞書に分割した。index.ts は後勝ち spread で merge
// するため、サブ辞書間でキーが重複すると片方の訳文が沈黙して上書きされる。
// 分割構成の不変条件 (キーはサブ辞書横断で一意 / ja・en は同一キー集合) をここで固定する。

const CHUNKS = {
  ja: { shell: jaShell, canvas: jaCanvas, settings: jaSettings },
  en: { shell: enShell, canvas: enCanvas, settings: enSettings }
} as const;

describe('i18n sub-dictionaries', () => {
  for (const lang of ['ja', 'en'] as const) {
    it(`${lang}: サブ辞書間でキーが重複しない`, () => {
      const seen = new Map<string, string>();
      for (const [chunkName, dict] of Object.entries(CHUNKS[lang])) {
        for (const key of Object.keys(dict)) {
          const prev = seen.get(key);
          expect(prev, `key "${key}" は ${prev} と ${chunkName} の両方に定義されている`).toBeUndefined();
          seen.set(key, chunkName);
        }
      }
    });
  }

  it('ja / en は同一のキー集合を持つ', () => {
    const jaKeys = Object.keys({ ...jaShell, ...jaCanvas, ...jaSettings }).sort();
    const enKeys = Object.keys({ ...enShell, ...enCanvas, ...enSettings }).sort();
    const jaOnly = jaKeys.filter((k) => !enKeys.includes(k));
    const enOnly = enKeys.filter((k) => !jaKeys.includes(k));
    expect(jaOnly, 'ja にだけ存在するキー').toEqual([]);
    expect(enOnly, 'en にだけ存在するキー').toEqual([]);
  });
});
