## 実装計画

### ゴール
動的ロール定義 (`team_recruit` で生成された label / description / instructions / engine など) を `~/.vibe-editor/role-profiles.json` の新セクション `dynamic[]` に永続化し、アプリ再起動 / Canvas 復元時に「未知のロール」へ fallback しないようにする。

### 影響範囲 / 触るファイル
- `src/types/shared.ts` — `RoleProfilesFile` に `dynamic?: DynamicRoleEntry[]` を追加 / `DynamicRoleEntry` の正式型化
- `src-tauri/src/commands/role_profiles.rs` (もしくは該当箇所) — load/save で dynamic を round-trip
- `src-tauri/src/team_hub/protocol/dynamic_role.rs` — Hub 起動時 / team 登録時に保存済み定義を `replace_dynamic_roles()` 経由で投入する hook
- `src/renderer/src/lib/role-profiles-context.tsx` — file load 時に `dynamic[]` を memory cache に投入。`team:role-created` event 受信時にも file 側へ非同期で persist
- `src/renderer/src/lib/tauri-api.ts` — role_profiles wrapper に dynamic フィールド対応
- `.claude/skills/vibe-team/SKILL.md` — Leader / HR の動的ロール採用フローに「永続化される旨」を明記

### 実装ステップ
- [ ] Step 1: shared.ts の型を拡張 (`tauri-ipc-commands` skill 5 点同期)
- [ ] Step 2: role_profiles.rs の load/save ロジックを dynamic 対応に拡張、後方互換 (古い JSON は dynamic 無しで OK)
- [ ] Step 3: RoleProfilesContext に file persist 経路を追加 (team:role-created event を捕捉して `window.api.roleProfiles.save()`)
- [ ] Step 4: アプリ起動時、TeamHub に既存 dynamic 定義を replay する関数を呼ぶ
- [ ] Step 5: Canvas 復元シナリオで role_id だけ残っているケースの自己修復: dynamic から再構成
- [ ] テスト: load/save round-trip / 復元シナリオ

### 検証方法
- `npm run typecheck` / `cargo test`
- 手動: 動的ロールを 1 つ作成 → 全てのセッションを閉じる → アプリ再起動 → role-profiles.json に dynamic が残っていることを確認 → Canvas restore で「未知のロール」にならないこと

### リスク・代替案
- リスク: dynamic を file に persist することで「使い捨てロール」のゴミが溜まる。 expires_at (任意) を追加 + Settings から手動削除を可能に。
- 代替案: `~/.vibe-editor/dynamic-roles/<team_id>.json` に分割保存。 role-profiles.json への統合を避けられるが管理経路が増える。今回は単一ファイル拡張を採用。

### 想定 PR 構成
- branch: `fix/issue-513-persist-dynamic-roles`
- commit 粒度: 1 commit (型同期 + IO + context 反映)
- PR title: `fix(vibe-team): 動的ロール定義を role-profiles.json に永続化し再起動後も復元可能にする`
- 本文に `Closes #513`、関連 #522 を記載
