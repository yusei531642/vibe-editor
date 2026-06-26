# Canvas マルチエージェント拡張 & Skill 機能 実装計画

> 対象: Canvas モードで Claude Code / Codex に加え **任意の追加エージェント** を一級ノードとして登録・配置できるようにし、**カードの GUI を刷新**、**Skill 機能を作り込む**。
> 調査: 5本の Explore subagent による並列コードベース調査 + grok-4.3 (`x-ai/grok-4.3`) の設計知見。
> 作成日: 2026-06-26 / ステータス: ドラフト（実装着手前のレビュー用）

---

## 0. ゴール（ユーザー要望の分解）

1. **追加エージェントの拡張性**: Claude / Codex 以外の任意 CLI / API エージェント（例: Gemini CLI, Aider, opencode, 自作 CLI, 各種 API モデル）を、Claude/Codex と同格でキャンバスに追加・配置できる。
2. **見やすいカード GUI**: 「微妙」な現状カードを、状態・役割・種別が一目で分かる高密度ミニマル（Linear / Raycast 風）デザインに刷新。
3. **Skill 機能の作り込み**: SKILL.md をエージェントに紐付け・注入する仕組みを、CLI エージェントにも効かせ、検索 / タグ / 検証 / version 管理 / 有効無効トグルまで揃える。

---

## 1. 現状アーキテクチャ（調査サマリ）

### 1.1 すでにある基盤（=ゼロからではない）

- `settings.customAgents: AgentConfig[]` は **CLI / API 両 runtime を既にサポート**。
  - `AgentConfig = CliAgentConfig | ApiAgentConfig`（discriminated union）— `src/types/shared.ts:57-96`
  - `CliAgentConfig`: `{ id, name, color?, runtime:'cli', command, args, cwd? }`
  - `ApiAgentConfig`: `{ …, runtime:'api', providerId, model, skillIds?, systemPrompt?, toolMode?, … }`
- CLI custom agent の起動は解決済み: `resolveAgentConfig()` が `customAgents.find()` で命令を引く — `src/renderer/src/lib/agent-resolver.ts:22-58`
- Rust 側 allowlist は settings から動的に許可: `SAFE_BASENAMES`(`claude,codex,bash,…`) ∪ `configured_terminal_commands()` — `src-tauri/src/commands/terminal/command_validation.rs:149-204,183-194`
- PTY spawn 本体: `src-tauri/src/commands/terminal.rs:396-501`（allowlist→危険フラグ filter→`spawn_session`）
- 設定永続化 SSOT: `~/.vibe-editor/settings.json`（schemaVersion=12）— `src-tauri/src/commands/settings.rs:46-129,224-262`
- カスタムエージェントの設定 UI: `CustomAgentEditor.tsx`（runtime 切替 / command / args / color / API は skill チェックボックス）
- Custom agent を Canvas で「Leader として起動」する経路は実装済み（Issue #1025）— `src/renderer/src/layouts/CanvasLayout.tsx:308-370`

### 1.2 Canvas ノードモデル

- `CardType = 'terminal' | 'agent' | 'apiAgent' | 'editor' | 'diff' | 'fileTree' | 'changes'` — `src/renderer/src/stores/canvas.ts:42-49`
  - `agent` カード = Claude/Codex の TUI ターミナル（`AgentPayload.agent: 'claude' | 'codex'` **ハードコード** — `components/canvas/cards/AgentNodeCard/types.ts:15`）
  - `apiAgent` カード = API 駆動チャット（`agentConfigId` で `settings.customAgents` を解決）
- 追加フロー: 右クリックメニュー（`Canvas.tsx:309-352`）→ `CanvasLayout` の `addAgent()/addApiAgent()`（`CanvasLayout.tsx:488-523`）→ store `addCard()`（`canvas.ts:401-449`）→ 同 `agentId` は upsert（`canvas-card-identity.ts:56-65`）

### 1.3 Skill 機能

- IPC: `app_install_vibe_team_skill`（`.claude/skills/vibe-team/SKILL.md` を書く / version-aware ダウングレードガード, 50d4546 / #1108）— `src-tauri/src/commands/vibe_team_skill.rs:215-269`
- API agent への注入: `load_skill_bodies()`（`api_agents/skills.rs:218-248`）→ `build_skills_context()` で `system_prompt` に連結（`api_agents.rs:476+`, 上限 `MAX_SKILL_BYTES=48KB`）
- UI: `SkillImportPanel.tsx`（Claude/Codex から import/remove/list）、`CustomAgentEditor.tsx:111-157`（API agent のみ skill チェックボックス → `skillIds[]`）
- 配置: import 済み = `~/.vibe-editor/skills/<id>/SKILL.md`、プロジェクト = `.claude/skills/<id>/SKILL.md`
- 型: `ApiAgentSkillMeta` / `ApiAgentImportableSkill` / `ApiAgentSkillSource` — `shared.ts`

### 1.4 永続化 / SSOT

| 種類 | SSOT | 場所 |
|---|---|---|
| Custom agents (CLI/API) | `Settings.customAgents` | `settings.json` |
| Builtin (claude/codex) | `settings.{claude,codex}Command/Args` | `settings.json`（customAgents には**入っていない**） |
| Role profiles | `role-profiles.json` + HubState | overrides/custom/dynamic |
| Canvas ノード instance | canvas store (localStorage) | `data.payload.agentId` 等 |
| TeamHub 実行状態 | `team-state/<team>.json(.messages.json)` | in-memory + disk |

---

## 2. 問題点（=作り込みが必要な箇所）

| # | 問題 | 根拠（file:line） |
|---|---|---|
| P1 | `'claude' \| 'codex'` リテラル union が多数のファイルに散在し、カスタム CLI が一級 `agent` ノードになれない | `canvas.ts:105`, `AgentNodeCard/types.ts:15`, `canvas-team-spawn.ts:36`, `CanvasLayout.tsx:244,280,401`, `Canvas.tsx:575` |
| P2 | 型コメントと実装の乖離（`TerminalAgent = string` だが実装は claude/codex 固定） | `shared.ts:784` |
| P3 | カスタム追加 UI が貧弱（leader-only 固定 / API は最初の1個のみ / 「Add API agent here」が i18n 無しハードコード） | `CanvasLayout.tsx:502-523`, `Canvas.tsx:328` |
| P4 | builtin プリセットが leader-claude / leader-codex の2種のみ | `workspace-presets.ts:48-63` |
| P5 | カードのビジュアル弱点（status バッジが弱い・役割視認性低・glass未対応・ヘッダー詰め込み・semantic color 未使用・折りたたみ無し） | `styles/components/canvas.css:818-1106` |
| P6 | **Skill は API agent にしか効かない**（`skillIds` は `ApiAgentConfig` のみ、CLI agent は紐付け不可） | `shared.ts:87`, `CustomAgentEditor.tsx:120` |
| P7 | Skill 管理機能が薄い（検索 / タグ / frontmatter 検証 / version 一般化 / rollback 無し、48KB cap, キャッシュ無し） | `api_agents/skills.rs`, `vibe_team_skill.rs` |
| P8 | カスタムエージェントに `env` / `icon` / `tags` を持たせるフィールドが無い | `shared.ts:57-96` |
| P9 | `engine_policy` は claude/codex のみ判定、custom はスキップ（mixed 扱い） | （Rust engine policy, 調査で確認） |

---

## 3. 設計方針

### 3.1 正規化されたエージェント記述子（AgentDescriptor）

**狙い**: builtin(claude/codex) と custom を**同一の正規型**に解決し、UI / 起動 / Skill 注入はすべてこの型を見る。リテラル union（P1/P2）を撲滅する。

```ts
// 永続化されない “解決済み” 記述子（renderer 内部表現）。
// builtin は settings.{claude,codex}* + 内蔵レジストリから合成し、custom は settings.customAgents から合成する。
export interface ResolvedAgentDescriptor {
  id: string;                       // 'claude' | 'codex' | custom id
  kind: 'builtin' | 'custom';
  runtime: 'cli' | 'api';
  displayName: string;
  // CLI
  command?: string;
  args?: string;                    // テンプレート展開前
  cwd?: string;
  env?: Record<string, string>;     // 新規（P8）
  // 表示
  icon?: string;                    // lucide アイコン名 or glyph
  accentColor?: string;
  tags?: string[];                  // 新規（P8）
  // Skill
  defaultSkillIds?: string[];       // 新規: 定義レベルの既定 skill（cli/api 共通, P6）
  skillInjection?: 'claude-dir' | 'append-flag' | 'prompt-file' | 'none'; // CLI への効かせ方
  // API 固有はサブ型で保持
}
```

**永続化型の拡張（最小差分）**:
- `AgentConfigBase` に `icon?`, `tags?`, `defaultSkillIds?` を追加。
- `CliAgentConfig` に `env?`, `skillIds?`（or `defaultSkillIds` を base へ）, `skillInjection?` を追加。
- builtin は customAgents に入れず、**内蔵レジストリ module** が `settings.{claude,codex}*` から `ResolvedAgentDescriptor` を合成（DoD #7: 状態と不変条件の所有権を単一 module に閉じる）。

**module 所有権（god-file 回避, CLAUDE.md DoD #7）**:
- 新規 `src/renderer/src/lib/agent-registry.ts`（≤500行）が「builtin + custom → `ResolvedAgentDescriptor[]`」解決の単一ソース。
- 既存の分散ヘルパ（`m.agent === 'codex' ? …`）はこの module の `resolveDescriptor(agentId)` / `isCodex(descriptor)` 等に集約。

### 3.2 カード GUI 刷新

**新カードの情報設計**（grok-4.3 案 + 現状 component 分割を踏襲）:

```
┌─────────────────────────────────────────────────────┐
│ [icon] DisplayName            ·CLI·   ● running  [⋯][×]│  ← Header: 種別アイコン+accent / name / runtimeバッジ / 状態ドット+label / actions
├─────────────────────────────────────────────────────┤
│  task: 〇〇を実装中…                                   │  ← Summary（折りたたみ可）: task / elapsed / health
│  ⏱ 3m   ❤ alive                                       │
├─────────────────────────────────────────────────────┤
│  [ xterm / chat 本体 ]                                │  ← Body
├─────────────────────────────────────────────────────┤
│  🧩 pullrequest  🧩 vibeeditor  +2          [Skills▾] │  ← Footer: skill チップ（最大3 + overflow）/ skill 管理入口
└─────────────────────────────────────────────────────┘
```

- **状態表現**: `idle`(灰) / `running`(accent パルス) / `waiting`(warning黄) / `error`(danger赤+アイコン)。semantic token（`--accent-success/-warning/-danger`）を使用。
- **役割/種別**: lucide アイコン + accentColor で区別（avatar の1文字 glyph から脱却）。
- **折りたたみ**: ヘッダーダブルクリックで Summary を collapse（`max-height` トランジション、`display:none` を廃止）。
- **Glass 対応**: `.canvas-agent-card` に `glass-surface` 付与、`tokens.css` のホワイトリストに追加。
- **CSS 配置**: 新規 `styles/components/canvas-agent-card.css`（≤500行）。既存 `canvas.css`(1893行, baseline 済) は触る範囲を最小化。
- スタイリングは **Tailwind 不使用**、`var(--*)` トークン + 機能別 CSS（grok 提案の `text-[13px]`/`ring-2` は CSS 変数へ翻訳）。
- 詳細トーンは `claude-design` skill を参照。

### 3.3 Skill 機能の作り込み

**(a) CLI エージェントへの skill 注入（最重要・要決定）** — 3 案:

| 案 | 方式 | 長所 | 短所 |
|---|---|---|---|
| A. claude-dir materialize | 起動前に `.claude/skills/<id>/SKILL.md`（Codex は `.agents/skills`）へ書き出し、CLI 標準の自動探索に任せる | claude/codex でネイティブに効く / arg 長制限なし | ユーザーのプロジェクトにファイルを書く / cleanup と衝突管理 / version ガード必須（#1108 パターン流用） |
| B. append-flag 注入 | 起動時に `--append-system-prompt "<連結 skill 本文>"` を付与 | ファイルを書かない | Windows のコマンドライン長制限(~32KB) / フラグ非対応 CLI は不可 / 48KB cap |
| C. prompt-file 注入 | temp ファイルに書き `--system-prompt-file` 等で渡す | 長さ制限緩和 | CLI 依存のフラグ / temp 管理 |

→ **決定（2026-06-26, capability 駆動）**: 記述子の `skillInjection` で切替。builtin claude は A（materialize, version-aware ガード #1108 を再利用）を既定、append-flag 対応 CLI は B、API は現行の system_prompt 注入を継続、未対応 custom CLI は `none`（将来 B/C をオプトイン）。

**(b) 紐付け粒度**: 定義レベル（`descriptor.defaultSkillIds`）と **ノードインスタンスレベル**（`node.data.payload.skillIds` で上書き）の2層。

**(c) 管理 UI**: skill 一覧に検索 / タグフィルタ / installed インジケータ / 有効無効トグル。カード Footer の `Skills▾` から当該ノードの skill を切替。

**(d) 合成/順序/衝突**: 配列順に連結、同名セクションは後勝ち、`version` で hash 検証。`MAX_SKILL_BYTES` は据え置き＋超過時は明示警告（silent truncation 禁止）。

**(e) frontmatter 検証 / version 一般化**: 全 skill に version frontmatter を標準化、必須セクション検査、破損時 quarantine（既存 safe_load パターン）。

---

## 4. Phase 別実装計画

> 各 Phase は **独立した Issue + PR** に分割（CLAUDE.md: 問題発見→Issue→branch→PR→reviewer bot merge）。新規ファイルは ≤500行（CI ratchet）。

### Phase 0 — Issue 起票 & ガードレール
- **成果物**: GitHub Issue 群（§10 の分割案）。各 Issue に `enhancement`/`refactor` + 領域ラベル（`canvas`/`ui`/`javascript`/`rust`/`persistence` 等）。
- 本計画 md をリポジトリに置き、各 Issue から参照。

### Phase 1 — エージェント識別の正規化（基盤 / リテラル union 撲滅）
- **成果物**:
  - `agent-registry.ts`（builtin+custom → `ResolvedAgentDescriptor`）。
  - `shared.ts` の `TerminalAgent`/`AgentPayload.agent` を `agentId: string` 化、`AgentConfigBase` に `icon?/tags?/defaultSkillIds?`、`CliAgentConfig` に `env?/skillIds?/skillInjection?` 追加。
  - Rust `settings.rs` の `AgentConfig` struct を同期（camelCase）、defaults 追加。
  - 散在リテラル（P1）を registry 経由に置換。
- **触る**: `shared.ts:57-96,784`、`stores/canvas.ts:105`、`AgentNodeCard/types.ts:15`、`canvas-team-spawn.ts:36`、`CanvasLayout.tsx:244,280,401`、`Canvas.tsx:575`、`agent-resolver.ts:22-58`、`settings.rs:185-216`、`tauri-api.ts`。
- **DoD**: `agentId` が string で通り、claude/codex/custom が同一経路で起動。型の5点同期（§5）OK。`npm run typecheck` + `cargo check` green。挙動は現状維持（リグレッション無し）。
- **マイグレーション**: schemaVersion 12→13。旧データは無変換で読めること（`icon` 等は optional）。

### Phase 2 — カード GUI 刷新
- **成果物**: 新 `canvas-agent-card.css`、状態バッジ（icon+semantic color）、役割 lucide アイコン化、glass-surface 対応、折りたたみ、Footer の skill チップ。
- **触る**: `AgentNodeCard/CardPresentation.tsx`、`CardSummary.tsx`、`CardFrame.tsx`、`styles/components/canvas-agent-card.css`(新)、`tokens.css`(glass ホワイトリスト)、type に icon mapping。
- **DoD**: idle/running/waiting/error が一目で判別、種別アイコン表示、全テーマ（dark/light/midnight/glass）で視認性 OK。`npm run dev` 実機確認。
- **不変条件**: Tailwind 不使用 / テーマ切替は `[data-theme]` のみで成立。

### Phase 3 — 追加エージェント UX（追加導線の作り込み）
- **成果物**:
  - 右クリック「Add agent…」→ **任意の custom agent を選べるピッカー**（leader-only / first-only を解消、P3）。
  - メニューラベルの i18n 化（`Canvas.tsx:328`）。
  - builtin プリセット拡張（pair / custom 構成, P4）。
  - `CustomAgentEditor` に icon / tags / env（CLI）入力欄追加。
- **触る**: `Canvas.tsx:309-352`、`CanvasLayout.tsx:488-557`、`workspace-presets.ts:48-63`、`CustomAgentEditor.tsx`、i18n。
- **DoD**: 任意の登録済みエージェントをキャンバスに追加でき、複数 API agent も選択可能。

### Phase 4 — Skill システムの作り込み
- **成果物**:
  - CLI エージェントへの skill 注入（§3.3(a) capability 駆動、推奨案を実装）。
  - ノードインスタンス単位の skill トグル（Footer `Skills▾`）。
  - skill 管理 UI 強化（検索 / タグ / installed / version 表示）。
  - frontmatter 検証 + version frontmatter 標準化 + 破損 quarantine。
- **触る**: `api_agents/skills.rs`、`vibe_team_skill.rs`(materialize+ガード)、新規 `commands/skills.rs`（共通ロード）、`SkillImportPanel.tsx`、`CustomAgentEditor.tsx`、`shared.ts`(skill 型)、CardFrame の args 組み立て(`CardFrame.tsx:215-249`)。
- **DoD**: claude CLI に skill を効かせられる（materialize 経路で実証）、複数 skill 合成、version ガードがダウングレードを防ぐ、検索/タグが動く。security（traversal/symlink/サイズ上限）維持。
- **不変条件**: skill 注入は Rust 側で実行、renderer は OS リソース直接非アクセス。version-aware 上書きガード（#1108）を CLI materialize に適用。

### Phase 5 — 仕上げ / 高度化
- tags/capability フィルタ、レイアウト保存、テスト拡充、ドキュメント（README / docs）更新。engine_policy の custom 対応検討（P9）。

---

## 5. 型の5点同期チェックリスト（毎 PR）

新規/変更フィールドごとに以下を**必ず**揃える（vibeeditor skill の不変式）:

1. `src/types/shared.ts`（TS 型, camelCase）
2. `src-tauri/src/commands/settings.rs` の Rust struct（`#[serde(rename_all="camelCase")]`）
3. Rust `Default`（defaults）
4. `src/renderer/src/lib/settings-context.tsx`（load/migrate）
5. 設定モーダル UI（`CustomAgentEditor.tsx` 等）

加えて IPC を増やす場合は `tauri-api.ts` wrapper + `invoke_handler!` 登録 + `commands/mod.rs` 宣言（rust-ipc-reviewer の5点）。

---

## 6. マイグレーション / 後方互換

- `schemaVersion` 12→13。新フィールドはすべて optional にし、旧 `settings.json` を無変換で読める状態を保つ。
- builtin を customAgents に昇格させない（既存ユーザーの settings 構造を壊さない）。registry 側で合成する。
- canvas store（localStorage）の `payload.agent` 旧値は registry の `resolveDescriptor` でフォールバック解決。
- Skill: 既存 `~/.vibe-editor/skills` と `.claude/skills` の配置はそのまま、version frontmatter は段階導入（無印は従来挙動）。

---

## 7. 落とし穴 / リスク（grok-4.3 + コードベース）

- **PTY ライフサイクル**: 親終了後 zombie / IDE 突然停止（#1098 既知）。spawn は client-generated id + `subscribeEventReady` で pre-subscribe（Issue #285/#291）。
- **起動コマンド注入の安全性**: `argsTemplate` のプレースホルダ展開は **ホワイトリスト**（`{skillPrompt}` 等の既知トークンのみ置換）。任意文字列の shell 展開を許さない。`reject_danger_flags` を skill 注入フラグが誤って弾かれないか検証。
- **allowlist**: custom command は `configured_terminal_commands()` で settings 由来のみ許可（既存の安全策を維持）。
- **Windows コマンドライン長**: append-flag 方式は長さ制限に注意 → materialize / prompt-file を優先。
- **engine_policy**: custom agent はポリシー対象外（P9）。Phase 5 で扱う。
- **god-file / file-size ratchet**: 新規 module/CSS は ≤500行。`canvas.css` への追記は最小化、新 CSS ファイルへ。
- **Claude 署名禁止**（CLAUDE.md #6）: commit / PR に Claude 署名・生成元クレジットを入れない。

---

## 8. grok-4.3 知見の反映ポイント

- `AgentDescriptor` 正規型 + リテラル union を `agentId: string` へ置換し schemaVersion で migrate（§3.1, Phase1）。
- カード = Header(icon+accent+name+runtime badge+状態) / Body / Footer(skill チップ +N)（§3.2）。
- Skill は `argsTemplate {skillPrompt}` プレースホルダ注入を基本、定義レベル `defaultSkillIds` + インスタンス上書き、後勝ち合成 + version 検証（§3.3）。
- 落とし穴: PTY graceful shutdown / argsTemplate ホワイトリスト / allowlist / 後方互換 / **materialize より引数注入を優先**（§7）。
  - ※ ただし claude/codex は `.claude/skills` 自動探索がネイティブなため、本計画では builtin に限り materialize 案 A も候補に残す（§9 で決定）。

---

## 9. 決定事項 / 未決事項

**決定（2026-06-26）**:
1. **CLI への skill 注入方式**: **capability 駆動**（記述子 `skillInjection`）。builtin claude は materialize(A)、対応 CLI は append-flag(B)、未対応は none。
2. **スコープ/優先度**: **Phase 1→2→3→4 を順に一気通貫**。各 Phase は独立 Issue+PR。

**未決（実装中に確定）**:
3. **builtin の扱い**: claude/codex を将来 customAgents へ統合表示するか、registry 合成のままにするか（暫定: registry 合成のまま）。
4. **追加エージェントの初期同梱**: Gemini CLI / Aider / opencode 等のビルトインプリセットを同梱するか（command 名のみ、ユーザー環境にインストール前提）。

---

## 10. Issue 分割案（Phase 対応）

| Issue 候補 | type | 領域ラベル |
|---|---|---|
| エージェント識別の正規化（AgentDescriptor / リテラル union 撲滅） | `refactor` | `javascript` `rust` `canvas` `persistence` |
| Canvas エージェントカード GUI 刷新 | `enhancement` | `canvas` `ui` |
| 追加エージェント追加導線の作り込み（ピッカー / i18n / プリセット） | `enhancement` | `canvas` `ui` `i18n` |
| Skill 機能の作り込み（CLI 注入 / 管理 UI / 検証 / version） | `enhancement` | `rust` `javascript` `persistence` |
| 仕上げ（tags フィルタ / レイアウト保存 / engine_policy / docs） | `enhancement` | `canvas` `documentation` |

---

## 11. 参照ファイル早見表

- 型: `src/types/shared.ts:57-96,214-339,784,794-882`
- Canvas: `stores/canvas.ts:42-49,105`, `components/canvas/Canvas.tsx:309-352,575`, `layouts/CanvasLayout.tsx:308-557`, `lib/workspace-presets.ts:48-63`, `lib/canvas-team-spawn.ts:36`
- カード: `components/canvas/cards/AgentNodeCard/{CardFrame,CardPresentation,CardSummary,types}.tsx`, `styles/components/canvas.css:818-1106`, `styles/tokens.css`
- 起動: `lib/agent-resolver.ts:22-58`, `src-tauri/src/commands/terminal.rs:396-501`, `terminal/command_validation.rs:149-204`
- Skill: `src-tauri/src/commands/vibe_team_skill.rs:215-269`, `api_agents/skills.rs:218-248`, `api_agents.rs:476+`, `components/settings/{SkillImportPanel,CustomAgentEditor}.tsx`
- 永続化: `src-tauri/src/commands/settings.rs:46-129,185-262`, `lib/settings-context.tsx:70-139`, `commands/role_profiles.rs:18-42`
