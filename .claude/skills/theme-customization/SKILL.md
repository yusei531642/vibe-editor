---
name: theme-customization
description: vibe-editor で新しいテーマ (claude-dark / claude-light / dark / light / midnight / glass のような色プリセット) を追加・既存テーマの色を調整するときに必ず使う 4 層同期 skill。`src/types/shared.ts` の `ThemeName` ユニオン、`src/renderer/src/lib/themes.ts` の `THEMES` オブジェクトと `ThemeVars` インターフェイス、`src/renderer/src/styles/tokens.css` の CSS 変数、`src/renderer/src/lib/monaco-setup.ts` の Monaco カスタムテーマ定義 (`claude-dark` / `claude-light` 等) — これらが 1 つでもズレるとテーマ切替で undefined フォールバックや配色崩れが起きる。ユーザーが「テーマを追加」「新しいテーマ」「カラースキーム」「テーマの色を変更」「Claude.ai 風の◯◯テーマ」「accent カラーを変えて」「dark テーマの bg を◯◯に」「Monaco の配色を調整」「tokens.css に変数を足して」「テーマトークンを追加」等を言ったとき、また `themes.ts` / `tokens.css` / `monaco-setup.ts` を編集しそうなときには必ずこの skill を起動すること。
---

# theme-customization

vibe-editor のテーマシステムは **CSS 変数 + zustand 設定 + Monaco custom theme** の 3 系統が連動して動く。
新テーマ追加・色調整は **4 層を必ず同期** させる必要があり、どれか 1 つを忘れるとテーマ切替時に色が崩れる。

> デザイン上の色決定 (Claude.ai 風 / Linear 風など) は **`claude-design`** skill 側に集約されている。
> この skill は「決まった色をコードに正しく落とす」ための実装手順。

---

## 4 層の関係

```
┌────────────────────────────────────────────┐
│ 1. shared.ts: ThemeName ユニオン            │  型定義 (TS / Rust 両用)
│ 2. themes.ts: THEMES{ name: ThemeVars }     │  色トークン (TS から CSS 変数を流し込む)
│ 3. tokens.css: :root[data-theme="..."] {…}  │  CSS 側で参照する変数群
│ 4. monaco-setup.ts: monaco.editor.defineTheme│  Monaco エディタ専用カスタム配色
└────────────────────────────────────────────┘
```

`ThemeVars` (themes.ts:3-25) のフィールドが UI 全体で参照される CSS 変数の真実の出所。
`tokens.css` は CSS 側のフォールバック / 互換 / 派生変数を定義する場所で、テーマごとに値が直接書かれているわけではない (ほとんどは themes.ts の値が `useEffect` で `document.documentElement.style.setProperty` される)。

---

## Step 1: `shared.ts` の `ThemeName` を拡張

```ts
// src/types/shared.ts
export type ThemeName =
  | 'claude-dark'
  | 'claude-light'
  | 'dark'
  | 'light'
  | 'midnight'
  | 'glass'
  | 'sunset';   // ← 新テーマを追加
```

これを足すと、`AppSettings.theme` の型もこの新名を受け付けるようになる。
`APP_SETTINGS_SCHEMA_VERSION` (shared.ts) は **既存値の意味を変えるなら** bump、追加だけなら不要。

---

## Step 2: `themes.ts` の `THEMES` に新エントリを追加

`ThemeVars` の **全フィールドを埋める**。省略すると undefined が CSS 変数に流れて崩れる。

```ts
// src/renderer/src/lib/themes.ts
export const THEMES: Record<ThemeName, ThemeVars> = {
  // 既存…
  sunset: {
    bg: '#1a0f0a',
    bgPanel: '#241511',
    bgSidebar: '#140a07',
    bgToolbar: 'rgba(26, 15, 10, 0.62)',
    bgElev: '#2e1a14',
    border: 'rgba(255, 200, 160, 0.10)',
    borderStrong: 'rgba(255, 200, 160, 0.18)',
    bgHover: 'rgba(255, 200, 160, 0.06)',
    bgActive: 'rgba(255, 140, 60, 0.16)',
    accent: '#ff7a3c',
    accentHover: '#ff9259',
    accentSoft: '#ffa978',
    accentTint: 'rgba(255, 122, 60, 0.14)',
    warning: '#f5a623',
    warningHover: '#f7b955',
    text: '#fff5ee',
    textDim: '#d9c0b0',
    textMute: '#a08573',
    surfaceGlass: 'rgba(26, 15, 10, 0.62)',
    focusRing: '0 0 0 3px rgba(255, 122, 60, 0.28)',
    monacoTheme: 'vs-dark'   // または 'claude-dark' / 'claude-light' / 自作 ('sunset' を Step 4 で defineTheme)
  },
};
```

### `monacoTheme` の選び方

| 値             | 何になるか                                 |
|----------------|-------------------------------------------|
| `'vs-dark'`    | Monaco 標準のダーク (黒背景)              |
| `'vs'`         | Monaco 標準のライト (白背景)              |
| `'hc-black'`   | ハイコントラストダーク                    |
| `'claude-dark'` | monaco-setup.ts で定義済み (warm dark)   |
| `'claude-light'`| monaco-setup.ts で定義済み (warm light)  |
| 自作テーマ ID  | Step 4 で `monaco.editor.defineTheme()` を追加した上で指定 |

新しい配色を細部まで合わせたいなら **自作テーマ ID** にして Step 4 を書く。流用で十分なら既存のいずれかを指定。

---

## Step 3: `tokens.css` に派生変数 / 互換変数があれば追加

`tokens.css` (`src/renderer/src/styles/tokens.css`) は **CSS 側で参照されるトークン**を定義する場所。
themes.ts から流し込まれる変数 (`--bg`, `--text`, `--accent` …) が主役だが、CSS 側だけで使う派生 (`--font-claude-response`, motion / shadow / radius など) も並んでいる。

新テーマ追加で **新規変数を増やすケースは少ない** (themes.ts の `ThemeVars` を増やしたい場合のみ)。
増やすときは:

1. `ThemeVars` インターフェイス (themes.ts:3-25) にフィールドを追加。
2. `THEMES` の **全テーマ** に値を埋める (TS strict なので忘れるとコンパイルエラー)。
3. 流し込み箇所 (おそらく `SettingsContext` の `useEffect`) で `setProperty` が新フィールドを拾うか確認。
4. CSS 側で `var(--newvar)` を参照する場所を追加。

> **既存変数の値を変えるだけ**なら themes.ts のみ触れば十分。tokens.css は触らなくてよい。

---

## Step 4: Monaco カスタムテーマを足す (必要なら)

`monaco-setup.ts` に既に `claude-dark` / `claude-light` の例がある (monaco-setup.ts:62-114)。新テーマを Monaco でも独自配色にしたければ追加:

```ts
// src/renderer/src/lib/monaco-setup.ts
monaco.editor.defineTheme('sunset', {
  base: 'vs-dark',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#1a0f0a',
    'editor.foreground': '#fff5ee',
    'editor.lineHighlightBackground': '#241511',
    'editorCursor.foreground': '#ff7a3c',
    // ... claude-dark の例を踏襲
    // diff: 10% tint で揃える (skill: claude-design セクション 6)
    'diffEditor.insertedTextBackground': '#578a0019',
    'diffEditor.removedTextBackground':  '#cf3a3a19',
    'diffEditor.insertedLineBackground': '#578a000d',
    'diffEditor.removedLineBackground':  '#cf3a3a0d',
    'diffEditorGutter.insertedLineBackground': '#578a0033',
    'diffEditorGutter.removedLineBackground':  '#cf3a3a33',
  }
});
```

そして Step 2 の `monacoTheme` を `'sunset'` に書き換える。
**`ThemeVars.monacoTheme` の string union にも追加する**こと (themes.ts:24)。

```ts
monacoTheme: 'vs-dark' | 'vs' | 'hc-black' | 'claude-dark' | 'claude-light' | 'sunset';
```

---

## Step 5: 設定 UI / コマンドパレットへの露出

新テーマが選択肢として出るかは、設定モーダル (`components/settings/`) や CommandPalette (`lib/commands*`) のテーマ一覧定義による。

- 設定モーダルでテーマプルダウンに自動列挙されているなら追加不要。`Object.keys(THEMES)` から派生していれば自動。
- ハードコードされた配列があれば、その配列にも `sunset` を追加。
- i18n が必要な表示名 (`「サンセット」`) があれば `lib/i18n*` に翻訳キーを足す。

---

## Step 6: 検証

```bash
npm run typecheck
npm run dev
```

実機で:

1. 設定モーダル → テーマで新テーマを選択。
2. 全 UI が崩れていないか (左サイドバー、ツールバー、エディタ、Canvas、ターミナル、設定モーダル自身)。
3. **Monaco エディタの背景** が想定通り (色が `vs-dark` のままなら Step 4 を飛ばしている)。
4. 設定を再起動しても永続化されているか。
5. 別テーマと往復してチラつき / 残留色が無いか。

スクリーンショットで before/after 並べて自己レビューする (CLAUDE.md「動作の証明」原則)。

---

## よくある事故

- **`monacoTheme` を `'vs-dark'` のままで Step 4 を書いた**: 自作テーマが認識されないので Step 2 の `monacoTheme` 書き換えを必ずセットで。
- **`ThemeVars` のフィールドを 1 つだけ書き忘れた**: TS strict で落ちる。落ちなかったら Record 型が `Partial` になっていないか確認。
- **alpha 付きカラー (`rgba(...)`) を `border` 系に入れ忘れた**: Linear/Raycast 風の薄ボーダーが破綻する。既存テーマ (claude-dark) の値を元に微調整する。
- **claude-dark / claude-light の "Claude.ai 実測値" コメントを書き換えた**: あの値は Claude.ai 本家から取った値なので、別テーマを足す場合は **新エントリで** 書く (既存値は触らない)。
- **`focusRing` を空文字にした**: a11y で focus が見えなくなる。最低限 `0 0 0 3px rgba(accent, 0.28)` 風の値を入れる。

---

## 関連 skill

- 色パレット決定 / Claude.ai 風の表現意図 → **`claude-design`** skill
- 全体の地図 → **`vibeeditor`** skill
- 設定スキーマを破壊変更するなら → `APP_SETTINGS_SCHEMA_VERSION` を bump (vibeeditor 参照)
