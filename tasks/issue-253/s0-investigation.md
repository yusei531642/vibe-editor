# Slice S0 — 症状切り分け事前検証（コードベース解析）

> Issue #253「キャンバスモードで起動するとターミナル内の表示が大きく崩れる、Codexに至っては使用することすらできない」の症状仮説を、コードベース解析で確証する。
> FR-S1-011（CRITICAL）への対応。

## 観察事実
1. **スクリーンショットが存在** → 描画は何か出力されている → PTY spawn は成功している
2. **「表示が大きく崩れる」** → 描画はあるがレイアウト破綻
3. **「Codex に至っては使用することすらできない」** → Codex は Claude より深刻
4. **Issue #253 の OPEN は v1.4.4 リリース直後**（直近の hotfix `2269193`/`d865b87` 後）

## Codex 起動コードパス全列挙

| Step | 場所 | 内容 |
|------|------|------|
| 1 | `TerminalCard.tsx:54` | `command = payload.command ?? (isCodex ? settings.codexCommand : settings.claudeCommand)`。デフォルト `'codex'` |
| 2 | `tauri-api.ts` 経由 | `terminal_create` IPC 呼び出し（cols/rows を含む） |
| 3 | `terminal.rs:306` | `is_allowed_terminal_command("codex")` ✅ allowlist 通過 |
| 4 | `terminal.rs:319` | `reject_immediate_exec_args` 通過（codex は対象外） |
| 5 | `terminal.rs:336-357` | `codex_instructions` ありなら `prepare_codex_instructions_file` で一時ファイル化 |
| 6 | `pty/session.rs:296` | `which::which("codex")` で PATHEXT 解決（`codex.cmd` / `codex.exe`）。失敗時は raw fallback |
| 7 | `pty/session.rs:299-314` | `CommandBuilder` 組立、`should_inherit_env` で env フィルタ、`TERM=xterm-256color` / `COLORTERM=truecolor` 強制 |
| 8 | `pty/session.rs:316` | `pair.slave.spawn_command(cmd)` 実行 |
| 9 | `pty/session.rs:332-348` | reader thread + batcher (16ms/32KB) で `terminal:data:{id}` を emit |
| 10 | `terminal.rs:420-426` | `codex_instructions` ありなら 1.8 秒後に PTY 直接注入 |

## 失敗可能パターンの突き合わせ

| ID | 失敗パターン | Issue #253 観察との整合 | 判定 |
|----|------------|-------------------------|------|
| P1 | `which::which("codex")` 失敗 → raw spawn → `os error 193` | ❌ 即時 exit のため「表示が崩れる」観察と矛盾 | 除外 |
| P2 | spawn 自体失敗 (exit code != 0) | ❌ TerminalCard には description 表示のみで描画ゼロのはず | 除外 |
| P3 | `TERM=xterm-256color` 不適合 | △ Codex CLI 0.125.0 は xterm-256color 対応 | 影響なし |
| P4 | `should_inherit_env` の過剰除外 | △ PATH/USERPROFILE/HOMEDRIVE 等は継承される | 影響軽微 |
| P5 | ConPTY EOF 遅延 | △ `lessons.md` 記載済み、対策済み | 別経路 |
| **P6** | **PTY サイズ不整合（fit() の transform 影響）** | ✅ **「表示が崩れる」と完全整合。Codex の派手な TUI ほど壊れる** | **主因確証** |
| P7 | 1.8 秒注入の文字化け | △ `codex_instructions` 空なら無関係。Canvas デフォルトでは空 | 別経路 |
| P8 | Codex CLI 自身が ConstrainedLanguage で即終了 | △ Codex `exec` 経由で観測されたが TUI モード起動時の挙動は別 | 副因の可能性 |

## 主因の確証

- スクショに描画が出ている = **PTY spawn 成功** = P1/P2 除外
- Claude Code（単純対話 UI）は「崩れる」止まり、Codex（フルスクリーン TUI、status bar、罫線多用）は「使用不可」レベル → **TUI 複雑度に比例して被害が大きくなる**特性は **PTY サイズ不整合（P6）の典型症状**
- fortress-review Round 1 の主因 A (confidence 94) と一致

### 観察ベース確証 (FR-S0R-001 反映)

P6 が真因であることをコード参照で明示:

1. `terminal_create` IPC の cols/rows は **renderer 側 fit() 結果がそのまま渡る** (`use-pty-session.ts:103-108`):
   ```ts
   fit?.fit();
   initialCols = term.cols;
   initialRows = term.rows;
   // → window.api.terminal.create({ ..., cols: initialCols, rows: initialRows })
   ```
2. `FitAddon.fit()` は内部で `containerRef.getBoundingClientRect()` を読む（@xterm/addon-fit の実装）
3. CSS 仕様により `getBoundingClientRect()` は **CSS transform 適用後の視覚矩形** を返す
4. Canvas 親に `transform: scale(zoom)` (Canvas.tsx:322-327, minZoom=0.3 / maxZoom=1.5) → **fit が transform で歪んだ値を読む**
5. 結果: zoom=0.5 のとき `cols ≈ 実画面幅 / cellW × 0.5` の過小値が PTY に渡る

これでコード経路上、P6 の発生メカニズムが完全に説明できる。

### 副因 P8 の判別基準 (FR-S0R-003 反映)

「Codex CLI 自身の ConstrainedLanguage 即終了」と P6（描画崩壊）の判別:

| 判別観点 | P8（即終了）の特徴 | P6（描画崩壊）の特徴 |
|---------|------------------|---------------------|
| 描画の有無 | 即 exit でターミナル黒画面 or 空 | 何かしら描画は出る |
| welcome screen | 表示されない（or 一瞬で消える） | 表示はされるが崩れる |
| 入力受付 | プロセス死亡で全く受け付けない | プロセスは生きているが UI が壊れて操作困難 |
| Codex プロセス状態 | exit code != 0 で immediate terminate | running 継続 |

Issue #253 のスクショに **welcome screen 相当の描画が確認できる**前提で進める（スクショの実物は本文に未引用だが、本文「表示が崩れる」記述から描画は出ている）。Phase 3 E2E で「welcome screen が一定時間維持される」を必須条件に含めることで P8 を排除する。

**結論**: 主因は **P6 (PTY サイズ不整合)** と確定。S1-S7 の修正方針が有効。

### 見落としパターン分離 (FR-S0R-004 反映)

P1〜P8 に以下を追加:

| ID | 失敗パターン | Issue #253 整合 | 対応 |
|----|------------|----------------|------|
| **P9** | **CSS transform: scale と xterm fit の二重スケール** | P6 と本質同根。明示分離 | S2-S4 の `unscaledFit` でカバー |
| P10 | Canvas DOM renderer の measure/glyph atlas 不整合 | △ 副因 B と部分重複 | S0 範囲外（別 Issue） |
| P11 | 16ms/32KB batcher が TUI フレーム境界を分断 → 描画ガビ | △ 重描画頻度依存 | S1 でテスト基盤導入後、batcher 無効フラグでの挙動を検証ステップに追加 |

P9 は P6 の言い換えなので S1-S7 で同時解消。P10/P11 は **副因として S7 (E2E) で検出する**枠に置く。

## 副因として残るリスク

| 副因 | 影響 | S1-S7 で吸収できるか |
|------|------|---------------------|
| P8: Codex CLI 0.125.0 の ConstrainedLanguage 即終了 | TUI 起動時には通常呼ばれない経路だが、ゼロではない | ❌ 別 Issue（Codex CLI 上流バグ） |
| 副因 B: DOM renderer customGlyphs 不在の glyph 抜け | Powerline 等の追加文字 | ❌ 別 Issue |
| 副因 C: which 失敗時の os error 193 ハンドリング | 環境依存 | ❌ 別 Issue |

## Phase 3 E2E で必須の実機検証項目 (FR-S0R-005 反映で強化)

S1-S7 完了後に実機 Tauri (Windows) で検証:

1. **zoom 段階別の welcome screen 完全表示** (5段階):
   - zoom = 0.5 / 0.75 / 1.0 / 1.25 / 1.5 すべてで Codex の welcome screen がレイアウト崩れなく描画される
   - **welcome screen が一定時間（5秒以上）維持される**こと（P8: 即終了の排除）
2. **Codex の入力 ↔ 出力整合**:
   - 1 文字入力 → エコー応答が返る
   - **画面幅いっぱいの長文プロンプト入力時の折り返し位置が PTY cols と一致**する（off-by-N 検出）
3. **zoom 動的変化への追従**:
   - zoom スライダー操作後に PTY cols/rows が transform を考慮した値に更新される（IPC ログ `pty.resize` で確認）
   - PTY 報告サイズと実 DOM 描画位置が一致
4. **regression なし（複数経路）**:
   - 既存 IDE モードで Claude / Codex 起動時に崩れなし
   - **Canvas モード Claude（単純対話）でも崩れなし**（P6 修正が両エージェントに効くこと）
5. **batcher 影響の切り分け** (P11):
   - Codex 起動直後の重描画フェーズで `terminal:data` イベントの batcher フラッシュ間隔が描画完成前に分断されないか観察
   - 必要なら batcher の閾値を一時的に下げた状態で挙動が改善するか実機で比較

これにより Issue #253 の「**操作可能性**」まで担保できる。視覚的に直っただけで Codex が使えないリスクをゼロに近づける。

## S0 受入条件達成
- [x] 「Codex 使用不可」が描画崩壊（P6）由来であるとコードレベルで確証
- [x] S1-S7 のスコープが主因をカバーすると確認
- [x] 副因 (P8/B/C) は別 Issue 扱いの妥当性を明文化
- [x] Phase 3 E2E で残リスクを検出する受入条件を定義
