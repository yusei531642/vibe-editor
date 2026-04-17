# 美的デザイン基準リサーチ — claude.ai / Linear / Vercel

> vive-editor のデザイン刷新用リファレンス。implementer(programmer0/1) が直接 CSS 変数やコンポーネントに落とし込めるよう、具体的なトークンとパターンを集約した。現在のテーマシステム (`src/renderer/src/index.css`) は CSS カスタムプロパティ方式なので、本資料の値はそのまま `--token-name` として取り込める。

---

## 0. 3つのデザイン言語の要約

| サービス | 気質 | キーワード | vive-editor での活かし方 |
|---|---|---|---|
| **claude.ai** | 温かみ・対話的・紙のような質感 | parchment / terracotta / 余白 / 柔らかい角丸 | 既存の `claude-dark` / `claude-light` テーマを軸にリッチ化 |
| **Linear** | 緻密・静謐・ミクロな情報密度 | warm-gray / LCH / 1px border / subtle accent | ダークテーマ (`midnight`, `dark`) のベース |
| **Vercel (Geist)** | 禁欲的・ジオメトリック・白黒のコントラスト | zinc / monochrome / 0.08 borders / 広い余白 | シンプルな `light` テーマ・開発者向け画面 |

3つの共通原則:
1. **飽和度を絞る** — 彩度の高い色はアクセントのみ。neutralで空間を作る。
2. **1px の境界線にこだわる** — 薄い border ≒ 0.06〜0.10 の alpha。
3. **余白は値切らない** — padding は mobile UI 基準の 2倍を目安に。
4. **モーションは軽い spring か長めの ease-out** — バウンドは小さく、でも"生きている"感を出す。

---

## 1. カラーシステム

### 1.1 claude.ai — 暖色パーチメント系

**ライトテーマ（Claude の標準面）**

| トークン | Hex | 用途 |
|---|---|---|
| `--bg` | `#F5F4ED` | ページ背景 (parchment) |
| `--bg-panel` | `#FAF9F2` | パネル・カード背景 |
| `--bg-elev` | `#FFFFFF` | モーダル・ポップオーバー最前面 |
| `--bg-hover` | `rgba(67,51,34,0.05)` | hover highlight |
| `--bg-active` | `rgba(201,100,66,0.12)` | selected row / active tab |
| `--border` | `#E8E3D4` | 1px 境界線 |
| `--border-strong` | `#D6CFBA` | 強調境界 (dividers) |
| `--fg` | `#141413` | primary text |
| `--fg-muted` | `#6B6A63` | 補助テキスト |
| `--fg-subtle` | `#9C9A8F` | placeholder / disabled |
| `--accent` | `#C96442` | terracotta brand, primary button |
| `--accent-hover` | `#B5583A` | accent の hover 状態 |
| `--accent-soft` | `#D97757` | coral, 二次強調 / リンク |
| `--accent-tint` | `rgba(201,100,66,0.10)` | badge / pill の背景 |

**ダークテーマ（"evening conversation"）**

| トークン | Hex | 用途 |
|---|---|---|
| `--bg` | `#141413` | アプリ背景 (warm charcoal) |
| `--bg-panel` | `#1F1E1D` | サイドバー / パネル |
| `--bg-elev` | `#2A2826` | モーダル |
| `--bg-hover` | `rgba(241,239,232,0.05)` | hover |
| `--bg-active` | `rgba(216,90,48,0.14)` | active |
| `--border` | `rgba(241,239,232,0.08)` | 1px border |
| `--border-strong` | `rgba(241,239,232,0.14)` | divider |
| `--fg` | `#F1EFE8` | primary text |
| `--fg-muted` | `#A8A69C` | secondary |
| `--fg-subtle` | `#6F6D64` | tertiary |
| `--accent` | `#D97757` | 暗面では coral が映える |
| `--accent-hover` | `#E88A6A` | |

**鉄則**: claude.ai のニュートラルには *blue-gray が 1色も無い*。全てのグレーに黄〜褐色の 2〜4 のクロマを含ませる (oklch でも `hue 60〜80` に寄せる)。

### 1.2 Linear — 深いダークに微かな青紫

**ダーク (Linear の主力面)**

| トークン | Hex | 用途 |
|---|---|---|
| `--bg` | `#08090A` | canvas 最背面 |
| `--bg-app` | `#0B0D12` | アプリ背景 |
| `--bg-panel` | `#101216` | sidebar / panel |
| `--bg-elev-1` | `#16181D` | card |
| `--bg-elev-2` | `#1C1E24` | modal |
| `--bg-hover` | `rgba(255,255,255,0.04)` | hover |
| `--bg-active` | `rgba(94,106,210,0.12)` | selected |
| `--border` | `rgba(255,255,255,0.06)` | subtle |
| `--border-strong` | `rgba(255,255,255,0.12)` | divider |
| `--fg` | `#F7F8F8` | primary |
| `--fg-muted` | `#8A8F98` | secondary |
| `--fg-subtle` | `#62666D` | tertiary |
| `--accent` | `#5E6AD2` | Linear 特有のブルーバイオレット |
| `--accent-hover` | `#6E7BDC` | |
| `--accent-soft` | `rgba(94,106,210,0.16)` | tint |

**ライト**

| トークン | Hex |
|---|---|
| `--bg` | `#FFFFFF` |
| `--bg-panel` | `#F4F5F8` |
| `--border` | `rgba(10,10,30,0.08)` |
| `--fg` | `#0F1011` |
| `--fg-muted` | `#6B7280` |
| `--accent` | `#5E6AD2` |

**鉄則**: Linear の"シャープさ"は **ギリギリ見える border (alpha 0.06〜0.08)** と **色がほぼ無い背景** の対比から来る。要素の "浮き" は影ではなく 1px border で作る。ダークモードでも色温度は warm-neutral（完全な青黒にしない）。

### 1.3 Vercel / Geist — 純黒白のジオメトリック

**Gray scale (両モード共通 token、値で切り替え)**

| トークン | Light | Dark |
|---|---|---|
| `--gray-50` | `#FAFAFA` | `#0A0A0A` |
| `--gray-100` | `#F4F4F5` | `#111111` |
| `--gray-200` | `#E4E4E7` | `#1F1F22` |
| `--gray-300` | `#D4D4D8` | `#27272A` |
| `--gray-400` | `#A1A1AA` | `#3F3F46` |
| `--gray-500` | `#71717A` | `#52525B` |
| `--gray-600` | `#52525B` | `#71717A` |
| `--gray-700` | `#3F3F46` | `#A1A1AA` |
| `--gray-800` | `#27272A` | `#D4D4D8` |
| `--gray-900` | `#18181B` | `#E4E4E7` |
| `--gray-950` | `#09090B` | `#FAFAFA` |

**セマンティック**

| 用途 | Light | Dark |
|---|---|---|
| `--bg` | `#FFFFFF` | `#000000` |
| `--bg-panel` | `#FAFAFA` | `#0A0A0A` |
| `--border` | `rgba(0,0,0,0.08)` | `rgba(255,255,255,0.08)` |
| `--border-strong` | `rgba(0,0,0,0.14)` | `rgba(255,255,255,0.14)` |
| `--fg` | `#000000` | `#FFFFFF` |
| `--fg-muted` | `#666666` | `#A1A1A1` |
| `--accent-blue` | `#0070F3` | `#3291FF` |
| `--accent-success` | `#00AC47` | `#0ECB81` |
| `--accent-warning` | `#F5A623` | `#F7B955` |
| `--accent-error` | `#EE0000` | `#FF4C4C` |

**鉄則**: 境界線は **rgba(0,0,0,0.08) / rgba(255,255,255,0.08)** で統一 — これを `0.15` まで濃くすると Vercel 感は消える。radius は 4px か 6px 以下を基本に。影はほとんど使わず、1px border で区切る。

---

## 2. タイポグラフィ

### 2.1 フォントスタック

```css
/* Claude.ai 系 — 温かみのある sans */
--font-sans: "Söhne", "Inter", "SF Pro Text", -apple-system, system-ui, sans-serif;
--font-serif: "Söhne Breit", "Tiempos Text", "Iowan Old Style", Georgia, serif;

/* Linear / Vercel 系 — ニュートラルな display */
--font-sans: "Inter", "Inter Display", -apple-system, system-ui, "Segoe UI", sans-serif;
--font-sans-display: "Inter Display", "Inter", sans-serif; /* heading 専用 */
--font-geist: "Geist", "Inter", sans-serif;
--font-mono: "Geist Mono", "JetBrains Mono", "SF Mono", ui-monospace, monospace;
```

**ウェイト運用**

| 要素 | ウェイト |
|---|---|
| body | 400 |
| UI label | 500 |
| button text | 500 〜 550 |
| heading | 600 (`Inter Display` 推奨) |
| strong / KBD | 600 |
| display (hero) | 500 〜 600 (Vercel は 600 止まり、Linear は 500 ベース) |

### 2.2 サイズスケール (rem / px)

```css
--text-11: 0.6875rem;  /* 11px  badge, subscript */
--text-12: 0.75rem;    /* 12px  micro label, timestamp */
--text-13: 0.8125rem;  /* 13px  sidebar item, UI dense */
--text-14: 0.875rem;   /* 14px  body default (Linear/Vercel) */
--text-15: 0.9375rem;  /* 15px  body default (Claude) */
--text-16: 1rem;       /* 16px  base, content */
--text-18: 1.125rem;   /* 18px  subtitle */
--text-20: 1.25rem;    /* 20px  h4 */
--text-24: 1.5rem;     /* 24px  h3 */
--text-32: 2rem;       /* 32px  h2 */
--text-48: 3rem;       /* 48px  h1 */
--text-64: 4rem;       /* 64px  hero */
```

### 2.3 行送り / 字間

```css
--leading-tight: 1.15;   /* headline / display */
--leading-snug: 1.3;     /* subtitle */
--leading-normal: 1.5;   /* body */
--leading-relaxed: 1.625;/* long form */

--tracking-display: -0.04em;  /* 32px+ の heading */
--tracking-heading: -0.02em;  /* 20〜24px */
--tracking-tight:  -0.01em;   /* 14〜18px の UI 基本 */
--tracking-normal:  0;        /* body 16px */
--tracking-wide:    0.02em;   /* 12px 以下の小見出し・オールキャップ */
```

**鉄則**: UI テキストは常に `-0.01em` を入れる。Inter/Geist はデフォルトで字間が広めに感じるため、-0.01 〜 -0.02 を混ぜるとモダンになる。大見出しは `-0.04em` まで攻める。

---

## 3. スペーシング & レイアウト

### 3.1 4px ベースグリッド

```css
--space-0:   0;
--space-1:   4px;
--space-2:   8px;
--space-3:   12px;
--space-4:   16px;
--space-5:   20px;
--space-6:   24px;
--space-8:   32px;
--space-10:  40px;
--space-12:  48px;
--space-16:  64px;
--space-20:  80px;
--space-24:  96px;
--space-32:  128px;
```

- **UI 内部 (Linear/Vercel)**: 4〜16px を多用、リスト行の内 padding は `8px 12px`。
- **コンテンツ / marketing (Vercel)**: section padding は 96〜128px と "多すぎる" くらいで丁度良い。
- **Claude.ai**: やや緩めで、カードの内 padding は `20〜24px`。

### 3.2 定番レイアウト値

| 部位 | 値 |
|---|---|
| Sidebar 幅 (折りたたみ前) | **240〜264px** (Linear 248, Vercel 256, Claude 260) |
| Sidebar 折りたたみ後 | **56px** |
| Header / Toolbar 高さ | **40〜48px** (Linear 40, Vercel 48) |
| Modal 最大幅 | **560〜640px** (dialog) / **720px** (form) |
| Command palette 幅 | **640px** |
| Tooltip 最大幅 | **280px** |
| List row 高さ | **32〜36px** (Linear), **40〜44px** (Claude) |
| Button (md) 高さ | **32px** / padding `0 12px` |
| Button (sm) 高さ | **24〜28px** / padding `0 10px` |

### 3.3 角丸 (radius)

```css
--radius-xs: 4px;    /* chip, badge, kbd */
--radius-sm: 6px;    /* input, button (Vercel/Linear) */
--radius-md: 8px;    /* card, popover */
--radius-lg: 10px;   /* panel (Claude) */
--radius-xl: 14px;   /* modal */
--radius-2xl: 20px;  /* hero card (Claude), large sheet */
--radius-pill: 9999px;
```

- **Vercel**: 全体に小さめ (0〜6px)。マーケティングでは 0 も多用。
- **Linear**: 6〜8px 中心、モーダルだけ 12px 程度。
- **claude.ai**: 10〜14px で柔らかく、pill (9999px) を badge / avatar で多用。

---

## 4. モーション原則

### 4.1 duration

| トークン | 値 | 用途 |
|---|---|---|
| `--dur-instant` | `120ms` | hover bg, toggle, checkbox |
| `--dur-fast`    | `180ms` | button press, icon morph |
| `--dur-base`    | `240ms` | menu open, tab switch |
| `--dur-slow`    | `320ms` | popover, tooltip, dropdown |
| `--dur-slower`  | `500ms` | modal enter, page transition |
| `--dur-ambient` | `800〜1200ms` | hero fade, ambient effects |

### 4.2 easing 曲線 (cubic-bezier)

```css
/* Linear 風 spring-ish ease-out (最頻出) */
--ease-out-expo: cubic-bezier(0.16, 1, 0.3, 1);

/* Material 標準 emphasized */
--ease-standard: cubic-bezier(0.4, 0, 0.2, 1);

/* 入場アニメ用 (overshoot 無しの smooth) */
--ease-out-quart: cubic-bezier(0.25, 1, 0.5, 1);

/* 退場アニメ用 (先速く・後遅く) */
--ease-in-quart: cubic-bezier(0.5, 0, 0.75, 0); 

/* claude.ai のゆったり */
--ease-gentle: cubic-bezier(0.33, 1, 0.68, 1);

/* Vercel のクリーンなフェード */
--ease-fade: cubic-bezier(0.4, 0.14, 0.3, 1);

/* subtle spring (bounce 弱) — hover scale 等 */
--ease-spring: cubic-bezier(0.34, 1.26, 0.64, 1);
```

### 4.3 state ごとの推奨

| state | duration | easing | プロパティ |
|---|---|---|---|
| **hover** (bg color) | 120ms | `--ease-out-quart` | `background-color`, `color`, `border-color` |
| **hover** (scale/lift) | 180ms | `--ease-spring` | `transform: translateY(-1px)` |
| **focus ring** | 150ms | `--ease-standard` | `box-shadow` |
| **press / active** | 80ms | `--ease-standard` | `transform: scale(0.98)` |
| **enter** (modal/popover) | 240ms | `--ease-out-expo` | `opacity 0→1, transform: translateY(8px)→0` |
| **exit** | 160ms | `--ease-in-quart` | 逆 |
| **tab switch / route** | 180ms | `--ease-out-quart` | opacity + 4px slide |
| **tooltip** | 120ms in / 80ms out | `--ease-standard` | 遅延 400ms 後に発火 |
| **toast** | 320ms | `--ease-out-expo` | translate + fade |

**鉄則**: 
- `transition: all` は **禁止**。プロパティは明示的に列挙 (`transition: background-color 120ms, border-color 120ms`)。
- hover で position が動く要素は transform のみを動かす (layout を揺らさない)。
- 複数要素をカスケードで見せたい時は 30〜60ms の stagger を入れる (Linear のリスト表示等)。

---

## 5. コンポーネントパターン

### 5.1 サイドバーのアクティブ状態

**3つの定番アプローチ**

```css
/* (A) claude.ai — 背景 + 薄い accent tint  (主力) */
.sidebar-item[aria-current="page"] {
  background: var(--bg-active);         /* rgba(accent,0.12) */
  color: var(--fg);
  font-weight: 550;
}

/* (B) Linear — 左 2px border + 背景 (ダークに映える) */
.sidebar-item[aria-current="page"] {
  background: rgba(255,255,255,0.04);
  box-shadow: inset 2px 0 0 var(--accent);
  color: var(--fg);
}

/* (C) Vercel — border 無し、bg のみ (禁欲的) */
.sidebar-item[aria-current="page"] {
  background: var(--gray-100);
  color: var(--fg);
}
```

**hover はどれも共通**で:
```css
.sidebar-item:hover { background: var(--bg-hover); }
.sidebar-item:active { transform: scale(0.985); }
```

### 5.2 ツールバー/ヘッダの"ガラス質"

```css
.app-header {
  background: rgba(20, 20, 19, 0.72);        /* --bg を alpha 0.7 に */
  backdrop-filter: saturate(180%) blur(20px);
  -webkit-backdrop-filter: saturate(180%) blur(20px);
  border-bottom: 1px solid var(--border);    /* 0.06〜0.08 */
  /* scroll 時は alpha を 0.85 に上げる */
}
```

- Claude.ai: `saturate(180%) blur(20px)`、非スクロール時は透明。
- Linear: `blur(12px)` 弱めで、border を強調。
- Vercel: `blur(8px)` + `rgba(255,255,255,0.72)` ライト面のみ。

### 5.3 モーダル / コマンドパレット

```css
.backdrop {
  background: rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(8px);             /* Linear 8px, Vercel 4px, Claude 12px */
  animation: fade 180ms var(--ease-out-quart);
}

.modal {
  position: fixed;
  top: 15vh;                               /* コマンドパレットは 12〜15vh */
  left: 50%; transform: translateX(-50%);
  width: min(640px, calc(100vw - 32px));
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: var(--radius-xl);         /* 14px */
  box-shadow: var(--shadow-modal);
  animation: modal-in 240ms var(--ease-out-expo);
}

@keyframes modal-in {
  from { opacity: 0; transform: translate(-50%, 16px) scale(0.98); }
  to   { opacity: 1; transform: translate(-50%, 0)    scale(1); }
}
```

### 5.4 フォーカスリング

```css
/* WCAG 準拠 + 2px offset ring (Linear/Vercel 共通) */
.focusable:focus-visible {
  outline: none;
  box-shadow:
    0 0 0 2px var(--bg),              /* offset 用の背景色 */
    0 0 0 4px var(--accent);          /* accent ring */
  transition: box-shadow 150ms var(--ease-standard);
}

/* claude.ai は ring 内側に soft tint */
.focusable:focus-visible {
  box-shadow:
    0 0 0 3px var(--accent-tint),     /* rgba(accent,0.20) */
    0 0 0 1px var(--accent) inset;
}
```

### 5.5 ノイズ / グレインオーバーレイ

```css
body::before {
  content: "";
  position: fixed; inset: 0;
  pointer-events: none;
  z-index: 1000;
  opacity: 0.015;                          /* 0.012〜0.020 の範囲 */
  background-image: url("data:image/svg+xml;utf8,<svg ...fractalNoise.../>");
  mix-blend-mode: overlay;
}
```

- 0.015 未満だと気づかれないが "高級感" は出る。
- ダークテーマでは `mix-blend-mode: screen` の方が発光感が出る。

### 5.6 Button バリエーション

| type | bg | border | fg | hover |
|---|---|---|---|---|
| **primary** | `var(--accent)` | none | `#fff` | bg を 6% 明るく + `translateY(-1px)` |
| **secondary** | `var(--bg-panel)` | `1px var(--border)` | `var(--fg)` | bg を `--bg-hover` に |
| **ghost** | `transparent` | none | `var(--fg-muted)` | bg → `--bg-hover`, fg → `--fg` |
| **danger** | `transparent` | `1px var(--accent-error)` | `var(--accent-error)` | bg → `rgba(red,0.08)` |

全 button:
```css
height: 32px; padding: 0 12px;
border-radius: var(--radius-sm);          /* 6px */
font-size: var(--text-13); font-weight: 500;
letter-spacing: -0.01em;
transition: background-color 120ms, border-color 120ms, transform 120ms var(--ease-spring);
```

---

## 6. 影の階層 (layered shadows)

**Light 面 (Claude/Vercel)**

```css
--shadow-xs:     0 1px 2px  rgba(17,17,17,0.04);
--shadow-sm:     0 1px 3px  rgba(17,17,17,0.06),
                 0 1px 2px  rgba(17,17,17,0.04);
--shadow-md:     0 4px 12px rgba(17,17,17,0.08),
                 0 2px 4px  rgba(17,17,17,0.04);
--shadow-lg:     0 12px 24px rgba(17,17,17,0.10),
                 0 4px 8px   rgba(17,17,17,0.06);
--shadow-xl:     0 20px 40px rgba(17,17,17,0.14),
                 0 8px 16px  rgba(17,17,17,0.08);
--shadow-modal:  0 24px 48px rgba(17,17,17,0.18),
                 0 2px 8px   rgba(17,17,17,0.08),
                 0 0 0 1px   rgba(17,17,17,0.06);   /* 最後の 1px が "linework" */
--shadow-popover: 0 0 0 1px  var(--border),
                  0 12px 24px rgba(17,17,17,0.14),
                  0 2px 6px   rgba(17,17,17,0.06);
```

**Dark 面 (Linear)**

ダークでは drop shadow は効きにくいので、**inset highlight + inner border** で "浮き" を作る:

```css
--shadow-dark-sm: 0 1px 2px rgba(0,0,0,0.4),
                  inset 0 1px 0 rgba(255,255,255,0.04);
--shadow-dark-md: 0 6px 16px rgba(0,0,0,0.5),
                  0 1px 2px  rgba(0,0,0,0.3),
                  inset 0 1px 0 rgba(255,255,255,0.05);
--shadow-dark-modal: 0 24px 64px rgba(0,0,0,0.6),
                     0 2px 8px   rgba(0,0,0,0.4),
                     0 0 0 1px   rgba(255,255,255,0.08),
                     inset 0 1px 0 rgba(255,255,255,0.06);
```

**鉄則**: 影は **必ず 2〜3 層** で構成する。1層だけだと「安っぽいカード」になる。上の層ほど近距離 (ブラー半径小・alpha 高)、下の層ほど遠距離 (ブラー半径大・alpha 低)。

---

## 7. 参考にすべき実装ディテール 15選

1. **Linear のサイドバー active は左 2px の inset shadow で表現**  
   `box-shadow: inset 2px 0 0 var(--accent)` — border-left と違ってレイアウトを動かさない。

2. **Linear の list row hover は 80ms の micro delay を入れる**  
   マウスが通過しただけでは発火しないよう `transition-delay: 80ms` を hover bg にだけ設定。

3. **Vercel は input の focus ring を box-shadow で 2層**  
   `box-shadow: 0 0 0 1px var(--accent), 0 0 0 4px rgba(0,112,243,0.16)` — ring の内側に濃い 1px、外側に薄い 4px glow。

4. **Vercel の border は常に rgba alpha 0.08**  
   `rgba(255,255,255,0.08)` と `rgba(0,0,0,0.08)` を `--border` として統一。これが失われると一気に安っぽくなる。

5. **claude.ai は "ring shadow" で interactive state を示す**  
   drop shadow ではなく `box-shadow: 0 0 0 4px var(--accent-tint)` の ring を hover/focus で付ける。

6. **claude.ai の neutral には 1色も cool-gray が無い**  
   oklch で `hue 60〜80` に全グレーを寄せる。`#737373` ではなく `#7B7970` を使うイメージ。

7. **Linear の modal は enter 時に 8px だけ下から上に移動**  
   `translateY(8px)→0` + `opacity 0→1`、240ms `cubic-bezier(0.16,1,0.3,1)`。大きな移動は野暮。

8. **Vercel の button press は scale(0.98)**  
   `transform: scale(0.98)` を `:active` で 80ms。触感フィードバックが出る。

9. **Linear のコマンドパレットは `top: 12vh` 固定**  
   中央 (`top: 50%`) ではなく上寄り。タイプ中にキーボードが被らない。

10. **claude.ai の送信ボタンは `aspect-ratio: 1 / 1` の circle**  
    `border-radius: 9999px`、`--accent` fill、hover で `scale(1.04)` + `--ease-spring`。

11. **Vercel のリンクは hover で `text-decoration-thickness` を 1px→2px にアニメート**  
    `text-decoration: underline; text-decoration-color: transparent` で初期状態を隠し、hover で `text-decoration-color: currentColor`。

12. **Linear の tooltip は `opacity + translateY(-2px)` のみで 120ms**  
    scale は使わない。大きく動かないことが "静謐さ" の正体。

13. **Claude / Linear は 1px の hairline を `transform: scaleY(0.5)` で 0.5px 表現** (Retina のみ)  
    ```css
    .hairline::after { transform: scaleY(0.5); transform-origin: top; }
    ```
    より繊細な divider が作れる。

14. **全サービス共通: body に `font-feature-settings: "cv11", "ss01", "ss03"` を入れる**  
    Inter の stylistic set を有効化すると、一段モダンに見える (特に小文字 a, l の形)。

15. **Linear の dropdown menu はキーボードフォーカス時のみ border を太くする**  
    マウスでは border 透明、`:focus-visible` で `1px solid var(--accent)` を出す。キーボード操作を "二級市民扱いしない" ための配慮。

---

## 8. vive-editor への適用順序 (implementer 向けメモ)

現在の `src/renderer/src/index.css` は既にトークン化されているので、**値の更新だけで多くが改善する**。推奨順:

1. **border alpha の見直し** — 現状の border を全て `rgba(*,*,*,0.06〜0.08)` に揃える (section 1.3)。
2. **影を layered に** — 現行は 1〜2 層なので section 6 の 3層版に差し替え。
3. **easing を 2 種類に統一** — `--ease-out-expo` と `--ease-standard` を導入、個別 transition はこの 2 つから選ぶ。
4. **フォーカスリング導入** — 現状は outline 依存の箇所があれば section 5.4 の 2層 box-shadow に置換。
5. **claude-dark テーマの warm-neutral 化** — `--fg-muted` の cool グレー値 (`#9C9A92` など) を section 1.1 の値に寄せる。
6. **Command Palette / Modal の enter animation** — `translateY(8px)→0` + `opacity`、240ms `--ease-out-expo` で統一。
7. **Sidebar active state を "左 2px inset shadow" に** — Linear 系で一番差がつく。
8. **最後にノイズオーバーレイ (opacity 0.015)** — 全面に被せて質感を追加。

---

## 参考ソース

- [Vercel Geist — Colors](https://vercel.com/geist/colors)
- [Vercel Design System Breakdown (SeedFlip)](https://seedflip.co/blog/vercel-design-system)
- [How we redesigned the Linear UI](https://linear.app/now/how-we-redesigned-the-linear-ui)
- [A calmer interface for a product in motion (Linear)](https://linear.app/now/behind-the-latest-design-refresh)
- [Linear Brand Guidelines](https://linear.app/brand)
- [Claude Brand Colors (Mobbin)](https://mobbin.com/colors/brand/claude)
- [shadcn/ui Claude theme](https://www.shadcn.io/theme/claude)
- [Rise of Linear style design (Medium)](https://medium.com/design-bootcamp/the-rise-of-linear-style-design-origins-trends-and-techniques-4fd96aab7646)
- [Josh Comeau — Springs and Bounces in Native CSS](https://www.joshwcomeau.com/animation/linear-timing-function/)
- [Motion — Easing functions](https://motion.dev/docs/easing-functions)
