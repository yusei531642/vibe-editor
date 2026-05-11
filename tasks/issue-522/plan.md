## 実装計画

### ゴール
うまくいったチーム編成 (役職構成 + 各ロール instructions + engine policy + Canvas layout) を 1 セットの「team preset」として `~/.vibe-editor/presets/<id>.json` に保存し、Canvas にドラッグするだけで再構築できるようにする。動的ロール永続化 (#513) と並ぶ「再現性」の柱とする。

### 影響範囲 / 触るファイル
- 新規 `src-tauri/src/commands/team_presets.rs` — `team_presets_list / save / delete / load` IPC
- `src-tauri/src/lib.rs` — invoke_handler に登録、`commands/mod.rs` に追加
- `src/types/shared.ts` — `TeamPreset { id, name, createdAt, engine_policy, roles: PresetRole[], layout?: PresetLayout }`
- `src/renderer/src/lib/tauri-api.ts` — wrapper 追加
- 新規 `src/renderer/src/components/canvas/TeamPresetsPanel.tsx` — 一覧 / 適用 / 保存 / 削除 UI
- `src/renderer/src/components/canvas/StageHud.tsx` — 「現在のチームを preset 化」ボタン
- `src/renderer/src/lib/role-profiles-builtin.ts` — preset 由来の役職を Leader が一括採用するための instructions ヒント
- 新規ディレクトリ `~/.vibe-editor/presets/` (Rust 側で自動作成)

### 実装ステップ
- [ ] Step 1: shared.ts / Rust 構造体 / mod.rs / lib.rs / tauri-api.ts の 5 点同期 (`tauri-ipc-commands` skill 必読)
- [ ] Step 2: ファイル IO + atomic write (`atomic_write` ユーティリティ流用)
- [ ] Step 3: TeamPresetsPanel UI (一覧 / 詳細 / 適用 / 保存 / 削除)
- [ ] Step 4: 適用フロー: Leader を起動 → preset 内 roles を順次 `team_recruit`
- [ ] Step 5: i18n + テーマ対応
- [ ] テスト: round-trip (save → list → load → delete)

### 検証方法
- `npm run typecheck` / `cargo test`
- 手動: 4 名チームを構成 → 「preset として保存」 → 全カード削除 → preset から再構築 → 同じ役職構成が復元される

### リスク・代替案
- リスク: instructions に動的 secret や個人情報が混じる可能性。preset 保存前に確認 dialog で内容を表示。
- 代替案: team-history (#513 と統合) に preset を統合。今回は別ファイル管理にして検索性を優先。

### 想定 PR 構成
- branch: `enhancement/issue-522-team-presets`
- commit 粒度: Rust 1 / TS+UI 1 (合計 2)
- PR title: `enhancement(vibe-team): team preset の保存と再構築機能を追加`
- 本文に `Closes #522`、関連 #513 を記載
