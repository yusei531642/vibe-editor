# demo.gif 撮影ガイド (20 秒)

README 冒頭に貼る `docs/demo.gif` を作るための撮影台本 + 変換コマンド。

## コンセプト

**「1 人が指示 → 複数エージェントが自律的に協調する」を 20 秒で見せる。**
視聴者の 9 割は README をスクロールせず GIF だけ見て判断するので、1 秒目から絵として強い場面にする。

## 撮影の前提

- 解像度: **1280 × 720** (16:9)。GitHub 上でも等倍で読めるサイズ。
- FPS: **15 fps** (GIF の天井。これ以上は無意味にサイズ肥大)。
- カラーテーマ: `claude-dark` (デフォルト。トーンが落ち着いていて読みやすい)。
- 密度: `comfortable` (文字が読みやすい)。
- ウィンドウ: Canvas モードでスタート。`Ctrl+Shift+M` で切替。

## 20 秒の絵コンテ

| 時間 | 画 | 意図 |
|---|---|---|
| 0.0–2.0s | Canvas に **Leader / Programmer / Researcher / Reviewer** の 4 ノードが既に並んでる状態。カーソルが Leader 入力欄に入る | 「チーム構成がある」を一瞬で見せる |
| 2.0–4.5s | Leader に短い日本語指示をタイプ: `認証 API にレート制限を付けて、テストも` | 人間がやるのは言葉だけ、が伝わる |
| 4.5–8.5s | Leader が `team_assign_task` で Programmer と Researcher に割り振る様子 → Canvas 上にハンドオフの線がアニメーション | **これが一番のキラーショット**。他の AI エディタにない画 |
| 8.5–13.0s | Programmer ターミナルに `[Team ← leader]` が注入され、コード生成が始まる。同時に Researcher も動いてる (分割画面) | "同時に" 動いてることを見せる |
| 13.0–16.5s | Reviewer に結果が `team_send` で飛んで、Reviewer が diff をレビューする様子 (左に Monaco diff) | レビューサイクルまで完結してる |
| 16.5–20.0s | Canvas 全景にズームアウト、4 ノード間のメッセージ線が一瞬ハイライト → 終わり | 「これ全部が 1 つのアプリ」 |

**タイピングは遅めで**。速すぎると何やってるか読めない。1 文字 80–120ms 目安。

## 撮影手順

### 1. 録画

Windows なら **ShareX** 推奨 (無料, MP4/GIF 両対応, 領域指定簡単)。

```
ShareX → Capture → Screen recording (GIF) or (Video)
→ 領域: ウィンドウを 1280x720 にスナップしてから領域指定
→ 出力: MP4 (H.264, 15 fps) を推奨。GIF 化は後工程で。
```

Mac は **Kap** または **QuickTime + ffmpeg**。
Linux は **Peek** が一番ラク。

### 2. MP4 → GIF 変換 (`gifski` 推奨)

`gifski` は現時点で最も品質/サイズ比が優れた GIF エンコーダ。`ffmpeg` のパレット方式より 2〜3 倍綺麗。

```bash
# インストール (Windows: scoop / Mac: brew / cargo install gifski)
scoop install gifski         # or
brew install gifski          # or
cargo install gifski

# 変換 (1280 幅 / 15 fps / 20 秒想定, 品質 90)
ffmpeg -i demo.mp4 -vf "fps=15,scale=1280:-1:flags=lanczos" frames/frame-%04d.png
gifski -o docs/demo.gif --fps 15 --quality 90 --width 1280 frames/frame-*.png
rm -rf frames
```

目標サイズ: **3–6 MB**。GitHub README で普通に表示される上限の感覚値。超えたら:
- `--quality 80` に下げる
- `--width 960` に縮小
- 尺を 18 秒に削る

### 3. `ffmpeg` 単体で済ませたい場合 (gifski なし)

```bash
# 2-pass パレット方式。gifski より若干ノイジーだが追加ツール不要。
ffmpeg -i demo.mp4 -vf "fps=15,scale=1280:-1:flags=lanczos,palettegen=stats_mode=diff" -y palette.png
ffmpeg -i demo.mp4 -i palette.png -lavfi "fps=15,scale=1280:-1:flags=lanczos [x]; [x][1:v] paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" -y docs/demo.gif
rm palette.png
```

### 4. 配置

```
vibe-editor/
└── docs/
    ├── demo.gif        ← ここ (README が参照)
    └── screenshot.png
```

完成したら README をリロードして描画確認。

## 撮り直しチェックリスト

- [ ] 最初の 2 秒で「何のアプリか」わかる？ (Canvas モード + 4 ノード)
- [ ] ハンドオフの線のアニメーションが映ってる？
- [ ] タイピング速度で読める？ (早すぎないか)
- [ ] ループした時の繋ぎ目が違和感ない？ (最終フレームと最初のフレームが近いとキレイに loop する)
- [ ] ファイルサイズ 6 MB 以下？
- [ ] カーソルのチカチカを録れてる？ (録画ソフトによっては消える)
