---
name: vibeeditor
description: vibe-editor (Tauri 2 + React 18 製の Claude Code / Codex 専用エディタ) で作業する際に必ず参照するプロジェクト全体ガイド。アーキテクチャ (Rust 側コマンド / React 側 UI / IPC 経由)、ディレクトリ構成、命名規則、頻出コマンド (npm run dev / typecheck / build)、テーマ・i18n・設定永続化・PTY・Canvas モード・自動アップデート等の実装パターンと注意点をまとめる。vibe-editor リポジトリ内で「機能追加」「バグ修正」「リファクタ」「IPC コマンドを足す」「設定項目を追加」「テーマを足す」「Canvas を触る」「ターミナル/PTY を触る」「セッション履歴」「TeamHub」「shared.ts に型を足す」「tauri-api.ts」「@tauri-apps/api/core」「invoke / listen」等のキーワードや作業に少しでも触れるとき、また vibe-editor プロジェクトでコードを書く前に必ずこの skill を起動すること。
---

# vibeeditor

vibe-editor (Tauri 2 + Vite 5 + React 18 + TypeScript 5.6) で開発するときに最初に読み込むナビゲーションスキル。
個別タスクのフローは別 skill (pullrequest / vibe-team / claude-design など) に委譲し、ここでは「どこに何があるか」「どのレイヤを触るか」を素早く判断するための地図を提供する。

---

## アーキテクチャの大原則

**3 レイヤ構成** (この境界を曖昧にしない):

```
┌─────────────────────────────────────────────────┐
│ Renderer (src/renderer/) — UI 描画のみ           │
│   React 18 + TS strict + zustand + Monaco        │
│   状態: hooks + Context (Settings, Toast)        │
│        + zustand (canvas / ui)                   │
└──────────────────┬──────────────────────────────┘
                   │ window.api (tauri-api.ts 互換層)
                   │ ↓ invoke() / listen()
┌──────────────────┴──────────────────────────────┐
│ Tauri main (src-tauri/) — Rust                  │
│   ファイル I/O / git / PTY / 設定 / TeamHub /    │
│   updater / dialog                              │
│   commands/ にすべての IPC handler を集約        │
└─────────────────────────────────────────────────┘
```

- **Renderer から OS リソース (fs, child_process, network) に直接触らない**。必ず Rust 側コマンドを足してから `window.api` 経由で呼ぶ。
- **Rust 側は `src-tauri/src/commands/<領域>.rs` に handler を書き、`#[tauri::command]` を付けて main.rs (または builder) に登録**。
- **共有型は `src/types/shared.ts` に定義**し、Rust 側は `serde(rename_all = "camelCase")` で同名構造体をマッピング。片側だけ変更しないこと。

---

## ディレクトリ早見表

| 触りたいもの                       | 場所                                                         |
|------------------------------------|--------------------------------------------------------------|
| Rust IPC コマンド                  | `src-tauri/src/commands/{app,git,terminal,settings,dialog,sessions,team_history,files}.rs` |
| PTY / xterm 連携 (portable-pty)    | `src-tauri/src/pty/`                                         |
| マルチエージェント socket hub      | `src-tauri/src/team_hub/`                                    |
| 自動アップデート                   | `src-tauri/src/updater*` (tauri-plugin-updater)              |
| React コンポーネント (汎用)        | `src/renderer/src/components/`                               |
| Canvas モード専用 React            | `src/renderer/src/components/canvas/`                        |
| レイアウト (CanvasLayout 等)       | `src/renderer/src/layouts/`                                  |
| zustand store                      | `src/renderer/src/stores/{ui,canvas}.ts`                     |
| Tauri 互換 API ラッパ              | `src/renderer/src/lib/tauri-api.ts`                          |
| 設定 Context                       | `src/renderer/src/lib/settings-context.tsx`                  |
| テーマ (CSS 変数)                  | `src/renderer/src/lib/themes*` + `src/renderer/src/styles/`  |
| i18n (ja/en)                       | `src/renderer/src/lib/i18n*`                                 |
| コマンドパレット定義               | `src/renderer/src/lib/commands*`                             |
| ワークスペースプリセット           | `src/renderer/src/lib/workspace-presets*`                    |
| 機能別 CSS                         | `src/renderer/src/styles/components/`                        |
| 共有型 (TS / Rust 両用)            | `src/types/shared.ts`                                        |

---

## よく使うコマンド

```bash
npm run dev          # = cargo tauri dev (Rust ビルド込み起動)
npm run build        # = cargo tauri build (リリースビルド)
npm run typecheck    # tsc --noEmit
npm run dev:vite     # レンダラーだけ vite で起動 (UI 単体確認用)
```

- 修正完了の最低ライン: **`npm run typecheck` が通ること**。Rust を触ったなら **`cargo check --manifest-path src-tauri/Cargo.toml`** も。
- UI 変更を加えたら基本は `npm run dev` で実機確認 (CLAUDE.md の「動作の証明」原則)。`dev:vite` だけでは Tauri 固有 API が動かないので最終確認にならない。

---

## 新しい IPC コマンドを足すレシピ (頻出)

1. `src/types/shared.ts` に Request / Response 型を追加 (camelCase)。
2. `src-tauri/src/commands/<領域>.rs` に同名構造体を `#[derive(Serialize, Deserialize)] #[serde(rename_all = "camelCase")]` で追加。
3. `#[tauri::command] async fn ...` を実装し、`tauri::Builder` の `invoke_handler!` に登録。
4. `src/renderer/src/lib/tauri-api.ts` に `window.api.<名前>` のラッパを追加 (引数・戻り値型は shared.ts のものを使う)。
5. 呼び出し側 React から `window.api.xxx(...)` で利用。
6. `npm run typecheck` で両側の型整合を確認。

イベント (Rust → Renderer の push) を足す場合は、`tauri::Manager::emit` + Renderer 側で `listen()`。tauri-api.ts に薄い subscribe ヘルパを足すと書き味が揃う。

---

## レンダラー側の状態管理ルール

| 用途                                | 何を使うか                              |
|-------------------------------------|-----------------------------------------|
| グローバル設定 (テーマ/フォント等)  | `SettingsContext` (永続化は Rust 経由)  |
| トースト通知                        | `ToastContext`                          |
| Canvas のノード/エッジ              | zustand `canvas` store                  |
| UI 状態 (パネル開閉、選択タブ等)    | zustand `ui` store                      |
| 個別画面のローカル state            | `useState` / `useReducer`               |

- **新しい永続設定**を追加するなら: `shared.ts` の Settings 型 → Rust の `Settings` struct → defaults → SettingsContext → 設定モーダル UI、の 5 点セット。漏れやすいので必ずチェック。
- 設定ファイルは `~/.vibe-editor/settings.json`。手元で挙動を見るときは直接編集して再起動するのが速い。

---

## スタイリング規約 (Tailwind なし)

- 機能ごとに `src/renderer/src/styles/components/<feature>.css` を作って読み込む。
- 色・spacing・radius は **CSS カスタムプロパティ** で。`var(--color-fg)` など。テーマは `:root[data-theme="..."]` で切り替わる。
- デザイン詳細 (Linear/Raycast 風 + Claude.ai 風) は `claude-design` skill 側に集約されているので、見た目を整えるときはそちらを必ず参照すること。

---

## 既存の主要機能と触る場所

| 機能                          | 主に触る場所                                                            |
|-------------------------------|-------------------------------------------------------------------------|
| ファイルツリー / Monaco diff  | `components/` 配下のツリー & DiffViewer 系                              |
| ターミナル (最大 10 タブ)     | `src-tauri/src/pty/` + `components/Terminal*`                           |
| セッション履歴                | `src-tauri/src/commands/sessions.rs` + `~/.claude/projects/<encoded>/`  |
| コマンドパレット (Ctrl+Shift+P) | `src/renderer/src/lib/commands*` + `components/CommandPalette*`        |
| テーマ切替 (5 種)             | `lib/themes*` + `styles/themes/`                                        |
| i18n (ja/en)                  | `lib/i18n*`                                                             |
| 設定モーダル                  | `components/SettingsModal*`                                             |
| TeamHub (複数エージェント)    | `src-tauri/src/team_hub/` + `components/team*`                          |
| 画像ペースト                  | xterm 入力ハンドラ + Rust 側 temp-file 書き出し                         |
| 自動アップデート              | `tauri-plugin-updater` (GitHub Releases)                                |
| Canvas モード                 | `components/canvas/` + `stores/canvas.ts` + `layouts/CanvasLayout*`     |

---

## 触るときの注意点

- **`src-tauri/target/` と `src-tauri/gen/schemas/` は gitignore 済み**。間違ってコミットしない。
- **Monaco は CDN ではなく npm パッケージ** (選択的インポートで 27 言語のみ)。新言語が必要なら登録漏れチェック。
- **node-pty 系の electron-rebuild は不要** (portable-pty を使っているので)。Electron 文脈の解決策をそのまま持ち込まない。
- **OS は Windows 11**。Rust 側のパス処理・改行・PTY 周りは Windows ネイティブを優先動作確認する。
- **ショートカット**は CLAUDE.md の表が正。新しいショートカットを足したら `commands*` と CLAUDE.md の両方を更新する。

---

## 関連 skill

- **PR を出す / レビュー対応 / merge まで見届ける** → `pullrequest` skill (必ずこちらを使う)
- **複数 issue をまとめて修正する** → `issue-fix` skill
- **何度も試したのに直らない最終手段の修正** → `finalfix` skill
- **UI を Claude.ai / Claude Code 風にする** → `claude-design` skill
- **TeamHub を絡めたマルチエージェント作業** → `vibe-team` skill

---

## 起動時にやること

1. 触るレイヤ (Rust / Renderer / 両方) を最初に決める。
2. 「ディレクトリ早見表」で対象ファイルを特定。
3. IPC を新設するなら「新しい IPC コマンドを足すレシピ」を順に。
4. 仕上げに `npm run typecheck` (+ Rust 触ったなら `cargo check`)。
5. UI を変えたら `npm run dev` で実機確認まで責任を持つ。
