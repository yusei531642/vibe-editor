---
name: claude-design
description: Vibe-Editor の UI を「Claude.ai + Claude Code 公式風」にリファインする際に参照するデザインガイド。色 (warm off-white / terra cotta #d97757)、タイポ (Claude 返答は serif・ユーザーは sans)、余白、記号 (⏺・⎿・スピナー)、アニメ (150ms / cubic-bezier(.4,0,.2,1))、メッセージングトーンの具体値を提供する。UI 刷新・新規コンポーネント作成・テーマ追加・エージェント発話の装飾など、見た目やトーンの判断が必要な作業で必ず参照。
---

# Claude 公式風デザインガイド (Vibe-Editor 用)

Claude.ai 本体の CSS 変数実測 + Claude Code CLI の視覚言語観察をベースに、Vibe-Editor (Tauri + React) へ「翻訳」したガイド。

**いつ使うか**: UI コンポーネント新規作成 / 既存スタイル刷新 / 新テーマ追加 / エージェント発話装飾 / トースト・モーダル等の見た目判断全般。

**使い方**: このファイルを読んだ上で、下記トークン・パターンを `src/renderer/src/styles/tokens.css` と機能別 CSS (`styles/components/*.css`) に反映。値は「実測 or 近似」を明記してある箇所を信頼していい。

---

## 0. 哲学 (判断に迷ったら戻る)

1. **Warm, not neutral** — グレーは色相 45–60° 寄りの warm。純中立グレー/青みグレーは禁止
2. **Hairline borders, no shadows** — 1px + アルファ 12–15% のボーダー中心。shadow は modal/dropdown 限定
3. **Typographic hierarchy** — アイコンや色より、フォントファミリー差 (sans / serif) とウェイトで情報階層を作る
4. **Single accent** — terra cotta `#d97757` を「少面積で」。大面積塗りは NG
5. **Form over color for states** — 成功/失敗は色だけでなく記号形状 (✓/✗, ⏺ の位置) でも識別可能に
6. **Breathing space** — 罫線で囲まず空白でグルーピング。`gap` を太らせる

---

## 1. カラートークン

Claude.ai の実 CSS 変数から抽出 (HSL→hex)。`tokens.css` に以下を追加してプロジェクト全体で参照する想定。

```css
:root {
  /* Brand */
  --claude-brand:         #d97757;  /* terra cotta / Claude Orange */
  --claude-brand-strong:  #c6613f;  /* hover / pressed */
  --claude-brand-glow:    rgba(217, 119, 87, 0.12);  /* focus ring / subtle bg */

  /* Accents (用途限定) */
  --claude-accent-blue:   #3886e5;  /* info */
  --claude-accent-violet: #7261e0;  /* Pro / premium バッジのみ */

  /* Semantic */
  --claude-success: #578a00;  /* オリーブ寄りの green */
  --claude-warning: #a86b00;  /* 飽和低めマスタード */
  --claude-danger:  #cf3a3a;

  /* Light surfaces (warm off-white 階段) */
  --claude-bg-0: #ffffff;
  --claude-bg-1: #f8f8f6;  /* アプリ背景の基本 */
  --claude-bg-2: #f4f4f1;
  --claude-bg-3: #efeeeb;
  --claude-bg-4: #e6e5e0;  /* raised / hover */

  /* Light text */
  --claude-text-1: #141413;
  --claude-text-2: #373734;
  --claude-text-3: #7b7974;  /* muted */

  /* Hairline border */
  --claude-border: rgba(31, 30, 29, 0.15);
}

:root.theme-claude-dark,
:root[data-theme="claude-dark"] {
  --claude-bg-0: #0a0a0a;
  --claude-bg-1: #171716;  /* warm near-black、純黒禁止 */
  --claude-bg-2: #1f1f1e;
  --claude-bg-3: #2c2c2a;
  --claude-bg-4: #373734;

  --claude-text-1: #f8f8f6;
  --claude-text-2: #c3c2b7;
  --claude-text-3: #97958c;

  --claude-border: rgba(248, 248, 246, 0.12);
}
```

**ルール**:
- `brand` は CTA ボタン solid / リンク前景 / 送信ボタン / ロゴマーク / 状態ドットのみ。**背景の大面積塗りは禁止**
- `bg-1` がアプリの基準背景。`bg-2..4` は 1 段ずつ raised していくレイヤリング
- ダークは `#0a0a0a` `#171716` など **色相 55° 付近の warm**。Slack 風 cool gray は避ける

---

## 2. タイポグラフィ

Claude.ai の決定的特徴: **Claude の返答は serif、ユーザー入力は sans**。同一画面に 2 書体同居させる。

```css
:root {
  --font-sans:  "Inter", system-ui, "Segoe UI", "Hiragino Sans",
                "Yu Gothic", "Noto Sans CJK JP", sans-serif;
  --font-serif: "Source Serif 4", Georgia, "Hiragino Mincho ProN",
                "Yu Mincho", serif;
  --font-mono:  "JetBrains Mono", "SF Mono", "Cascadia Mono",
                ui-monospace, monospace;

  /* Claude.ai 実測値 */
  --claude-body-size:   16px;
  --claude-body-lh:     24px;   /* 1.5 */
  --claude-ui-size:     15px;
  --claude-heading-1:   56px;
  --claude-heading-1-lh:67.2px; /* 1.2 */
  --claude-heading-weight: 330; /* 細字 serif — 重要 */
}
```

**適用方針**:
- AgentNodeCard の AI 応答テキストは `font-family: var(--font-serif)` にすると即「Claude 風」になる
- ユーザー発言・UI ラベル・ボタン・入力欄は全て sans
- 大見出しは **serif + weight 330** (細字)。太字見出しは使わない
- mono はターミナル・diff・コードブロックのみ

---

## 3. 形状・余白

実測値:

| 要素 | 値 |
|---|---|
| Input border-radius | `9.6px` (≒ 0.6rem) |
| Button / chip radius | `6px` |
| Card radius | `12px` |
| Modal radius | `16px` |
| Border width | `1px` 固定。2px 以上は禁止 |
| Shadow (デフォルト) | **なし** |
| Shadow (modal/dropdown のみ) | `0 2px 8px rgba(0,0,0,0.16)` 相当 |
| Sidebar 幅 | 260–280px |
| Chat column max-width | 768–820px |
| Chat item gap | 16px |
| Focus ring | `0 0 0 3px var(--claude-brand-glow)` |

**ルール**:
- 角丸は上記 4 段階から選ぶ。独自値 (8px, 10px etc.) は追加しない
- Elevation はレイヤーの `bg-*` 段差と border で表現。**影を足さない**
- `gap: 16px` を基準、密度 (`compact`/`comfortable`) で ±4px

---

## 4. アニメーション

```css
:root {
  --claude-duration-fast: 150ms;  /* 色・不透明度・ボタン hover */
  --claude-duration-base: 200ms;  /* モーダル・ドロップダウン */
  --claude-duration-slow: 250ms;  /* 大きな層移動 */
  --claude-ease: cubic-bezier(0.4, 0, 0.2, 1);  /* Material ease-in-out */
}

.interactive {
  transition:
    color var(--claude-duration-fast) var(--claude-ease),
    background-color var(--claude-duration-fast) var(--claude-ease),
    border-color var(--claude-duration-fast) var(--claude-ease);
}
```

**ルール**:
- translate は ±2–4px のみ。派手なスライドインは禁止
- scale は `0.98↔1.0` 程度
- ストリーミングカーソルは単純な opacity blink (`animation: blink 1s steps(2) infinite`)

---

## 5. Claude Code 由来の記号・パターン

### ⏺ (U+23FA) メッセージ開始マーカー
Claude Code で最重要のシンボル。Web では 8px の円で表現:

```css
.cc-message::before {
  content: "";
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--claude-brand);
  box-shadow: 0 0 0 3px var(--claude-brand-glow);
  margin-right: 8px;
  vertical-align: middle;
}
```

### ⎿ (U+23BF) ツール出力の引き込み線
Web ではツリー用の左ボーダー + インデント:

```css
.cc-tool-output {
  border-left: 2px solid var(--claude-border);
  padding-left: 12px;
  margin-left: 8px;
  color: var(--claude-text-3);  /* muted */
}
```

### スピナー (6 フレーム flower)
`·` → `✻` → `✽` → `✶` → `✳` → `✢` をループ:

```css
@keyframes cc-spin {
  0%   { content: "·"; }
  16%  { content: "✻"; }
  33%  { content: "✽"; }
  50%  { content: "✶"; }
  66%  { content: "✳"; }
  83%  { content: "✢"; }
  100% { content: "·"; }
}
.cc-spinner::before {
  content: "·";
  color: var(--claude-brand);
  animation: cc-spin 0.9s steps(6) infinite;
}
```

### プロンプトインジケーター `›`
入力欄左端にミュート色の `›` を擬似要素で。

### 状態ドット
`--dot-ready: #70b8ff` (薄い水色) / `--dot-awaiting: #eec467` (マスタード) / `--dot-error: #cf3a3a` 。AgentNodeCard の状態表示に流用。

---

## 6. メッセージングトーン

Claude Code の実観察:
- 一人称日本語省略、**丁寧体 (〜します / 〜しました)**
- **絵文字禁止** — システム指示でも禁止されている
- **1–4 行で完結**、プリアンブル無し
- 装飾 Markdown (`**bold**`, `##`) は重要キーワード限定
- 省略記号は `…` (U+2026)、`...` 禁止
- ツール実行報告は能動態過去: `Read src/index.ts` / 「`src/index.ts` を読みました」

**ステータス動名詞はランダム化**:
`Thinking` → 「思索中」「下書き中」「探索中」「熟考中」「計画中」「検討中」

**トースト・通知文言**: `<動詞> + <目的語>` 形式で統一。
- ✓「ファイルを保存しました」
- ✗「ファイル保存に失敗しました: <原因>」
- ✗「保存エラー発生!!」(絵文字・感嘆符禁止)

---

## 7. コンポーネント別ルール

### ボタン
```css
.btn {
  border: 1px solid var(--claude-border);
  border-radius: 6px;
  padding: 6px 12px;
  background: transparent;
  color: var(--claude-text-1);
  font: 400 15px/1 var(--font-sans);
  transition: background-color var(--claude-duration-fast) var(--claude-ease);
}
.btn:hover { background: var(--claude-bg-3); }
.btn-primary {
  background: var(--claude-brand);
  border-color: var(--claude-brand);
  color: #fff;
}
.btn-primary:hover { background: var(--claude-brand-strong); }
```

### Input
```css
.input {
  border: 1px solid var(--claude-border);
  border-radius: 9.6px;
  padding: 0 12px;
  height: 36px;
  background: var(--claude-bg-0);
  font: 400 16px/1.5 var(--font-sans);
}
.input:focus {
  outline: none;
  border-color: var(--claude-brand);
  box-shadow: 0 0 0 3px var(--claude-brand-glow);
}
```

### Agent メッセージカード (AgentNodeCard)
- 背景: `var(--claude-bg-1)`、border: hairline、radius 12px、shadow なし
- ロール名: sans bold 13px、muted
- 本文: **serif 16px / 1.5** (Claude 返答として)
- 頭に `⏺` ドット (8px)
- 折り返し: 3 行まで表示、「…続きを見る」で展開

### ターミナルカード
- 背景: `var(--claude-bg-1)` (**純黒 #000 禁止**)
- フォント: `var(--font-mono)` 14px
- ANSI オレンジは `--claude-brand` に、他の 16 色はテーマカスタマイズ

### コマンドパレット
- 各行: `<icon16px>  <コマンド名>  <—>  <説明muted>  <kbdショートカット右端>`
- 選択行: `background: var(--claude-brand-glow); border-left: 2px solid var(--claude-brand);`
- マッチ部分は太字化 (背景ハイライトなし)

### Diff (Monaco)
- 追加背景: `rgba(87, 138, 0, 0.10)` (success 10%)
- 削除背景: `rgba(207, 58, 58, 0.10)` (danger 10%)
- ガターの `+`/`-` は前景色のみ、背景丸なし

### エラー表示
- **Modal/Alert 禁止**。インラインで表示
- 構造: `左 2px 赤バー + 淡い赤背景 (5%) + AlertCircle 16px + 本文`
- 重大度 3 段階: `info`(青, Info) / `warn`(琥珀, AlertTriangle) / `error`(赤, AlertCircle)

---

## 8. アイコン

- **lucide-react** (既に導入済み) を使用。heroicons outline 系互換
- stroke-width は `1.75` 推奨 (デフォルト 2 より少し細く → Claude らしさ)
- サイズ: 16 / 20 / 24px の三段階のみ
- 塗り (`fill`) のアイコンはステータスドット以外使わない

---

## 9. 実装優先度

Vibe-Editor 既存 UI を Claude 公式風に寄せる場合の優先順:

1. **最優先** — `tokens.css` に `--claude-*` 変数を追加、`claude-dark`/`claude-light` テーマを上記値で上書き
2. **最優先** — AgentNodeCard の応答本文を **serif** 化 + `⏺` ドット付与
3. **高** — ボタン/入力欄/モーダルの radius・border を本ガイド値に統一
4. **高** — トースト文言を「動詞+目的語」形式・絵文字禁止にリファクタ
5. **中** — スピナー 6 フレーム実装、ステータス動名詞ランダム化
6. **中** — Monaco diff 配色を 10% tint に調整
7. **低** — ターミナル ANSI オレンジを `--claude-brand` にマッピング
8. **低** — プロンプト `›` 擬似要素

---

## 10. 禁止事項 (Claude 公式風を崩す NG リスト)

- 純中立グレー (`#808080`, `#cccccc`) / 青みグレー (`#94a3b8` 等 slate 系) の使用
- `box-shadow` をカードや buttons に付ける (フラットを維持)
- border 2px 以上、独自角丸 (8px, 10px 等)
- 大面積の terra cotta 塗り (ヘッダー全面オレンジ等)
- 絵文字をメッセージ・UI ラベル・トーストに使う
- `**太字**` 見出し (serif 細字で階層を作る)
- 純黒 `#000` / 純白 `#fff` のダーク/ライト基調
- フルスクリーンアラート/ブロッキングモーダルでのエラー通知
- トランジション 400ms 以上の緩慢アニメ

---

## 11. 関連ファイル (触るべき場所)

- `src/renderer/src/styles/tokens.css` — CSS 変数追加
- `src/renderer/src/lib/themes.ts` — テーマ定義に `claude-*` 追加/更新
- `src/renderer/src/styles/components/canvas.css` — AgentNodeCard スタイル
- `src/renderer/src/components/canvas/cards/AgentNodeCard.tsx` — `⏺` マーカー + serif 適用
- `src/renderer/src/components/CommandPalette.tsx` — パレット行レイアウト
- `src/renderer/src/components/EditorView.tsx` — Monaco diff トークン
- `src/renderer/src/lib/i18n.ts` — トースト文言リファクタ

---

## 12. 実測値の出典

- Claude.ai (`claude.ai/login`) DOM の `document.styleSheets` 全走査 — CSS 変数 468 件抽出
- Anthropic Brand Guidelines (`github.com/anthropics/skills` brand-guidelines)
- Claude Code CLI の実機スクリーンショット観察 + [Reverse Engineering Claude's ASCII Spinner (Kyle Martinez)](https://medium.com/@kyletmartinez/reverse-engineering-claudes-ascii-spinner-animation-eec2804626e0)
- Anthropic 公式「Terra Cotta `#da7756` / `#bd5d3a`」公開カラー

値が合わない場合は **Claude.ai 実測を優先**、次に公開ブランドガイド。
