---
name: monaco-language-setup
description: vibe-editor の Monaco エディタに新言語サポート (シンタックスハイライト) を追加するときに使う skill。`src/renderer/src/lib/monaco-setup.ts` の selective import (`monaco-editor/esm/vs/basic-languages/<lang>/<lang>.contribution`) と `src/renderer/src/lib/language.ts` の `EXT_MAP` (拡張子 → Monaco 言語 ID) を **2 ファイル同期**で追加する手順、basic-languages に entry が無い言語の代替策 (Issue #77 の TOML→ini 流用)、worker の有無、bundle サイズへの影響、検証手順をまとめる。ユーザーが「言語サポートを追加」「Monaco に◯◯言語を足して」「シンタックスハイライト」「拡張子マッピング」「.◯◯ ファイルが plaintext 表示になる」「TOML / Zig / Nim のハイライト」「basic-languages の◯◯」「language.ts」「monaco-setup.ts」等を言ったとき、また `monaco-setup.ts` / `language.ts` を編集しそうなときには必ずこの skill を起動すること。
---

# monaco-language-setup

vibe-editor の Monaco は **selective import** 戦略 (バンドル肥大化防止のため、basic-languages を 1 つずつ import する)。
新言語を足すには **monaco-setup.ts と language.ts の 2 ファイル同期**が必要。

> 現状 27 言語が登録済み (monaco-setup.ts:14-42)。
> 「シンタックスハイライトのみ」 = `basic-languages/<lang>/<lang>.contribution`。**language worker (TS の型チェック等) は登録していない**ので軽量。

---

## 2 ファイル同期

```
┌────────────────────────────────────────────────────────────┐
│ 1. monaco-setup.ts: import '<lang>/<lang>.contribution'    │  Monaco に言語を登録
│ 2. language.ts: EXT_MAP['<ext>'] = '<lang>'               │  拡張子 → Monaco 言語 ID
└────────────────────────────────────────────────────────────┘
```

両方書かないと:

- 1 だけ → 言語は知っているが拡張子から引けない (`detectLanguage()` が plaintext 返す)。
- 2 だけ → 拡張子 → 言語 ID は引けるが Monaco がその ID を知らないので結局 plaintext 描画。

---

## Step 1: 該当言語が basic-languages にあるか確認

[monaco-editor の basic-languages](https://github.com/microsoft/monaco-editor/tree/main/src/basic-languages) で対応言語を確認する。**バージョン依存**で増減するので、リポジトリの monaco-editor の実物を見る:

```bash
ls node_modules/monaco-editor/esm/vs/basic-languages
```

ある場合 → Step 2 へ。ない場合 → Step 1.5 (代替策) へ。

### Step 1.5: 無い場合の代替策

| 状況                               | 対応                                                                  |
|------------------------------------|-----------------------------------------------------------------------|
| 上位互換の言語が basic-languages にある | その ID で代替 (例 Issue #77: `toml` → `ini` で流用、語彙の上位互換)  |
| 似た構文の別言語で代替              | 例: Zig は明確な entry が無いので `cpp` で当てる (golf 的だが妥当)    |
| Monarch tokenizer を自作           | `monaco.languages.register({ id: 'mylang' })` + `setMonarchTokensProvider` を monaco-setup.ts に追加。重いので慎重に |
| basic-languages 以外の Monaco 純正 | (json / typescript-language-features 等は worker 同梱で重い)。基本やらない |

代替策を取るなら `language.ts` の該当行に **必ずコメントで「なぜ ◯◯ に流用したか」を残す** (Issue #77 の前例参照)。

---

## Step 2: `monaco-setup.ts` に import を追加

`src/renderer/src/lib/monaco-setup.ts` の既存 import 群 (14〜42 行目) に 1 行追加。**アルファベット順 / 既存の並びの慣例に合わせる** (途中で並びが乱れていればその場の慣例に従う)。

```ts
// 例: zig を追加 (basic-languages にあると仮定)
import 'monaco-editor/esm/vs/basic-languages/zig/zig.contribution';
```

### import path の罠

- 必ず `.../basic-languages/<id>/<id>.contribution` の形 — `.contribution` を忘れると言語が登録されない。
- `id` は monaco の言語 ID と完全一致。`csharp` (× `c-sharp`)、`cpp` (× `c++`)、`shell` (× `bash`) などケアフル。**フォルダ名 = 拡張子 .contribution 名**。
- 既存例:
  - `dockerfile` ← Dockerfile
  - `ini` ← .ini と TOML 流用 (Issue #77)
  - `shell` ← sh / bash / zsh

### json と c の例外

`monaco-setup.ts:39-42` のコメントが正:

> json と c は monaco-editor v0.55 の basic-languages に entry が無い (json は language/json の worker 同梱版のみ、c は cpp に統合済み)。

→ json は `EXT_MAP['json'] = 'json'` で Monaco の組込が拾う、c は `EXT_MAP['c'] = 'c'` で `cpp` contribution が拾う、という **暗黙の流用**。新言語を足すときも同じパターンが使えないか先に確認する。

---

## Step 3: `language.ts` の `EXT_MAP` に拡張子を追加

`src/renderer/src/lib/language.ts` (~5 行目から始まる `EXT_MAP`) に追加。

```ts
const EXT_MAP: Record<string, string> = {
  // ...
  zig: 'zig',  // ← 拡張子 → Monaco 言語 ID
  // 拡張子が複数あるなら全部書く
  zigon: 'zig',
};
```

### キーの正規化

- **すべて小文字**で書く (`detectLanguage()` 内で toLowerCase 済み)。
- ドット (`.`) は付けない (`'.zig'` は誤り、`'zig'` が正)。
- ファイル名そのもので判別する特殊ケース (Dockerfile / Makefile) は `language.ts:51-52` のように関数本体で個別ハンドル — `EXT_MAP` に入れない。

---

## Step 4: 検証

```bash
npm run typecheck
npm run dev
```

実機で:

1. 該当拡張子のファイルをエディタで開き、シンタックスハイライトが効いているか確認。
2. ファイル名タブにある「言語表示」(あれば) が想定 ID か。
3. キーワードや文字列のトークン化が崩れていないか (Monarch のバージョン違いで稀に色が抜ける)。
4. ファイルツリーから該当ファイルが普通に開けるか (どのコンポーネントもリーク的に変わっていないか)。

`detectLanguage('foo.zig')` を Console から呼んで `'zig'` が返るかも見ると確実:

```ts
import { detectLanguage } from './lib/language';
detectLanguage('foo.zig'); // => 'zig'
```

---

## バンドルサイズへの影響

basic-languages の 1 言語 import は概ね 5〜30 KB (gzip 後)。
27 言語登録済みでも language worker を入れていないため十分軽い。

ただし **Monarch tokenizer 自作** (Step 1.5 の最終手段) は数十 KB 級になりうるため、必要性をユーザーに確認してから着手する。

---

## やってはいけないこと

- **`monaco-editor` 全体を import する**: `import * as monaco from 'monaco-editor'` ではなく `'monaco-editor/esm/vs/editor/editor.api'` を使う (monaco-setup.ts:7)。前者は worker 含めバンドルが膨れる。
- **language worker を新規追加する**: 軽量重視のため避ける (monaco-setup.ts のコメント参照)。worker が必要な機能 (TS の型チェック等) を入れたいときは別途相談。
- **`EXT_MAP` の値に存在しない言語 ID を書く**: Monaco が `Cannot register language` 警告を出して plaintext にフォールバックする。
- **basic-languages のフォルダ名を勝手に推測する**: `node_modules/monaco-editor/esm/vs/basic-languages/` を ls で確認してから書く。
- **既存の TOML→ini 代替を消す**: Issue #77 の判断記録なので、TOML 専用 contribution が出るまで触らない。

---

## 関連 skill

- 全体の地図 → **`vibeeditor`** skill
- 配色 (Monaco テーマ) → **`theme-customization`** skill
