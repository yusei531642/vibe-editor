# claude-editor

[English](README.md) · [日本語](README-ja.md)

![claude-editor](docs/screenshot.png)

> [Claude Code](https://claude.com/code) 専用のデスクトップシェル — **温かく、集中できる UI で vibe coding を。**

claude-editor は Electron ベースのデスクトップアプリで、**「コードを書くのは Claude、人間はレビューする」** という一つの思想で設計されています。テキストエディタはありません。メインエリアは diff レビュー専用、右側は常時起動している Claude Code ターミナル、左側は変更ファイルと過去セッションの一覧です。

---

## 機能

- **Claude Code 固定ターミナル** — 右側にドラッグでリサイズ可能な常時起動パネル
- **セッション履歴と復帰** — `~/.claude/projects/*/session.jsonl` を読み込み、クリックで `claude --resume <id>` して過去セッションを継続
- **変更ファイル一覧** — git status 統合、クリックで diff タブをメインに開く
- **差分レビュータブ** — Monaco `DiffEditor`、インライン / サイドバイサイド切替、ピン留め / クローズ / 再オープン
- **コマンドパレット** — `Ctrl+Shift+P` ですべての操作をファジー検索
- **プロジェクト切替** — 任意フォルダをプロジェクトとして開ける、ターミナルは新しい cwd で自動再起動、最近のプロジェクト履歴
- **ターミナルで画像ペースト** — Claude Code ターミナル内で `Ctrl+V` して画像がクリップボードにあれば、一時ファイルに自動保存され、絶対パスがカーソル位置に挿入される（Claude がそのまま読める）
- **テーマ** — `claude-dark`（既定）/ `claude-light` / `dark` / `midnight` / `light`
- **情報密度設定** — `compact` / `normal` / `comfortable`
- **全アイコン SVG** — [lucide-react](https://lucide.dev/)
- **Claude.ai 風デザイン言語** — 温かいダークパレット、Source Serif Pro 見出し、コーラル `#D97757` は主要 CTA のみに最小限使用

---

## 動作要件

- **Node.js 20+**
- **Git** が `PATH` にある
- **Claude Code CLI** (`claude`) が `PATH` にある — [claude.com/code](https://claude.com/code) 参照
- Windows 10+, macOS 12+, または Linux
- Python 3 や C++ ビルドツールは**基本不要**（node-pty は NAPI prebuilds を同梱）

---

## 開発モードで起動

```bash
git clone https://github.com/yusei531642/claude-editor.git
cd claude-editor
npm install
npm run dev
```

Electron ウィンドウが開き、右パネルで Claude Code ターミナルが自動起動します。

---

## ビルド（配布用）

```bash
npm run typecheck        # TypeScript strict チェック
npm run build            # electron-vite ビルド → out/
npm run dist:win         # Windows NSIS インストーラ → release/
npm run dist             # 現在の OS 向けインストーラ
```

Windows ビルドの成果物は `release/claude-editor Setup 0.1.0.exe`（約 100 MB）。展開済みポータブル版は `release/win-unpacked/claude-editor.exe`。

### アイコンの再生成

アイコンのソースは `build/icon.svg`（暗い角丸正方形にセリフの "C"）。Windows `.ico` とマスター PNG を再生成するには:

1. `build/` を HTTP で配信 (例: `py -m http.server 8766`)
2. Chromium 系ブラウザで `http://localhost:8766/render.html` を開き、viewport を 1100×1100 に
3. スクリーンショットを `build/icon-master.png` に保存
4. `npm run icons` を実行

（2段階プロセスになっているのは、librsvg がシステムのセリフフォントを確実に解決できないため。Chromium でレンダリングして正しい "C" のタイポグラフィを得ています。）

---

## アーキテクチャ

```
src/
├── main/                # Electron メインプロセス
│   ├── index.ts         # BrowserWindow、IPC登録、ネイティブメニュー削除
│   └── ipc/
│       ├── app.ts       # getProjectRoot, restart, setWindowTitle
│       ├── dialog.ts    # フォルダ/ファイル選択ダイアログ
│       ├── git.ts       # status + diff (HEAD vs worktree)
│       ├── sessions.ts  # ~/.claude/projects/*/*.jsonl をパース
│       ├── settings.ts  # userData/settings.json 永続化
│       └── terminal.ts  # node-pty spawn/write/resize、画像ペースト保存
├── preload/
│   └── index.ts         # contextBridge.exposeInMainWorld('api', ...)
├── renderer/            # React UI
│   └── src/
│       ├── App.tsx              # 3カラムレイアウト、state 統括
│       ├── components/
│       │   ├── AppMenu.tsx
│       │   ├── ChangesPanel.tsx
│       │   ├── CommandPalette.tsx
│       │   ├── DiffView.tsx
│       │   ├── SessionsPanel.tsx
│       │   ├── SettingsModal.tsx
│       │   ├── Sidebar.tsx
│       │   ├── TabBar.tsx
│       │   ├── TerminalView.tsx
│       │   ├── Toolbar.tsx
│       │   └── WelcomePane.tsx
│       ├── lib/
│       │   ├── commands.ts          # ファジーフィルタ + Command 型
│       │   ├── language.ts          # 拡張子 → Monaco 言語ID
│       │   ├── monaco-setup.ts      # Vite ワーカー配線
│       │   ├── parse-args.ts        # シェルライク引数パーサ
│       │   ├── settings-context.tsx # 設定 React Context
│       │   ├── themes.ts            # CSS 変数テーマ
│       │   └── toast-context.tsx    # トースト通知 + Undo
│       ├── index.css
│       └── main.tsx
└── types/
    ├── ipc.d.ts         # window.api グローバル宣言
    └── shared.ts        # main ↔ renderer 共有型
```

### 設計の制約

- **メインプロセス**がファイルシステム、git、node-pty、ダイアログを独占
- **レンダラー**は純粋な UI — Node.js を直接 import せず、`fs`・`child_process` 不使用
- **すべての IPC** は `contextBridge` 経由 — `window.api.*`
- **TypeScript strict mode** をコードベース全体に適用

### 主なショートカット

| ショートカット | 動作 |
|---|---|
| `Ctrl+Shift+P` | コマンドパレット |
| `Ctrl+,` | 設定を開く |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | diff タブを循環 |
| `Ctrl+W` | アクティブなタブを閉じる |
| `Ctrl+Shift+T` | 最近閉じたタブを復元 |

---

## 設計思想

これはコードエディタではありません。**Claude Code の出力をレビューするための窓**です:

- `CLAUDE.md` は人間が手で書きません — Claude が書きます
- スキルの有効/無効は設定しません — Claude が description ベースで自動読込します
- 関数は自分で書きません — ターミナルで Claude に何がほしいか伝え、Claude が書きます
- あなたは diff をレビューし、承認するか軌道修正し、繰り返します

UI の仕事は**邪魔をしないこと**です。

---

## ライセンス

MIT — [LICENSE](LICENSE) を参照

本プロジェクトは Anthropic とは無関係の非公式プロジェクトです。"Claude Code" は [Anthropic](https://anthropic.com/) の製品です。
