---
name: canvas-nodecard-pattern
description: vibe-editor の Canvas モード (@xyflow/react) に新しいカード種 (CardType) や hand-off エッジを追加するときに使う skill。`src/renderer/src/stores/canvas.ts` の `CardType` ユニオン拡張、`CardData` 設計、zustand persist との整合、`CARD_TYPES` validator、`addCard` / `removeCard` の挙動 (cascadeTeam デフォルト、teamLocks, stageView)、Issue #157 (id 衝突 → crypto.randomUUID)、Issue #156 (pulseEdge TTL タイマ管理)、Canvas レンダリング側のコンポーネント追加箇所をカバー。ユーザーが「Canvas に◯◯カードを追加」「新しいノード種」「CardType を増やす」「@xyflow/react に新カスタムノード」「hand-off エッジ」「pulseEdge」「stageView」「teamLocks」「Canvas store を拡張」「ワークスペースプリセットに新カード」等を言ったとき、また `stores/canvas.ts` / `components/canvas/` / `layouts/CanvasLayout*` を編集しそうなときには必ずこの skill を起動すること。
---

# canvas-nodecard-pattern

vibe-editor の Canvas モードは **@xyflow/react + zustand persist** で動いている。
新カード種を足すには **型 / store / レンダラ / ワークスペースプリセット / persist の 5 層**が連動するため、抜けると localStorage から復元時に消える / ノードが render されない / team まとめ動作が崩れる、といった事故が起きる。

> 主要ファイル:
> - `src/renderer/src/stores/canvas.ts` — zustand store (型・validator・addCard / removeCard / pulseEdge / teamLocks / stageView)
> - `src/renderer/src/components/canvas/` — カード種ごとの React コンポーネント
> - `src/renderer/src/layouts/CanvasLayout*.tsx` — ReactFlow ノードの type → component マッピング
> - `src/renderer/src/lib/workspace-presets*` — 初期配置プリセット

---

## 5 層同期

```
┌────────────────────────────────────────────────────────┐
│ 1. canvas.ts: CardType ユニオン + CARD_TYPES 配列      │  型 + 実行時 validator
│ 2. canvas.ts: CardData の payload 型 (必要なら)        │  カード固有データ
│ 3. components/canvas/: <NewCard /> 実装                │  描画
│ 4. CanvasLayout*: nodeTypes に登録                     │  React Flow へのマッピング
│ 5. workspace-presets / addCard 経由で初期配置          │  実際に出るかどうか
└────────────────────────────────────────────────────────┘
```

zustand `persist` で nodes/edges/viewport が localStorage に保存される (canvas.ts:103-)。
**実行時 validator (`CARD_TYPES` / `isCardType`)** が復元時に未知の `cardType` を弾くので、これを増やし忘れると永続化済みの新カードがロード時に消える。

---

## Step 1: `CardType` を拡張 + validator も同時更新

```ts
// src/renderer/src/stores/canvas.ts
export type CardType =
  | 'terminal'
  | 'agent'
  | 'editor'
  | 'diff'
  | 'fileTree'
  | 'changes'
  | 'notes';   // ← 追加

const CARD_TYPES: CardType[] = [
  'terminal', 'agent', 'editor', 'diff', 'fileTree', 'changes',
  'notes',     // ← ここも忘れず追加
];
```

`CARD_TYPES` は **実行時 validator (`isCardType` で使う)**。型と配列の両方を更新するのがセット。型だけ書くと TS は通るが、persist 復元で `notes` カードが falsy 扱いされ消える。

---

## Step 2: `CardData.payload` の型を必要なら拡張

`CardData.payload` は `unknown` で、カード種ごとに何を入れるかは利用側合意。

```ts
// 例: notes カードは {markdown: string, filePath?: string} を持つ
export interface NotesCardPayload {
  markdown: string;
  filePath?: string;
}
```

- `addCard({ type: 'notes', title, payload: { markdown: '' } })` で作る。
- `setCardPayload(id, patch)` で部分更新 (canvas.ts:46-)。
- localStorage の永続スキーマも気にする — payload に巨大データ (画像 base64 等) を入れるなら別 store に切り出す検討。

---

## Step 3: カード本体の React コンポーネント

`src/renderer/src/components/canvas/` にコンポーネントを追加。既存例 (`TerminalCard.tsx` / `EditorCard.tsx` 等) の構造を踏襲:

```tsx
// components/canvas/NotesCard.tsx
import type { NodeProps } from '@xyflow/react';
import type { CardData } from '../../stores/canvas';

export function NotesCard({ id, data }: NodeProps<CardData>) {
  const payload = data.payload as NotesCardPayload | undefined;
  // タイトルバー (drag handle) + 本文 + リサイズ corner
  // CSS は src/renderer/src/styles/components/canvas-card.css の既存クラスを流用
  return (
    <div className="canvas-card">
      <div className="canvas-card__header">{data.title}</div>
      <div className="canvas-card__body">
        {/* Markdown プレビュー or 編集 */}
      </div>
    </div>
  );
}
```

### 必須の作法

- **drag handle** はヘッダ部に絞る (`className="canvas-card__header nodrag-children"` のような既存パターン) — 本文をドラッグしたらノードが動いてしまう。
- **resize** は @xyflow/react の `<NodeResizer />` を使う (既存カード参照)。
- **focus** したときに ReactFlow の selection を妨げない: `onPointerDown` で `event.stopPropagation()` を **使い分ける** (テキスト選択は許す、ノード移動は止める)。
- **delete キー** は ReactFlow の `deleteKeyCode` で扱われる。中で textarea を持つカードはデフォルトを止める処理が必要 (既存 EditorCard 参照)。

---

## Step 4: CanvasLayout で `nodeTypes` に登録

`layouts/CanvasLayout*.tsx` (またはその近辺) で React Flow の `nodeTypes` マップに追加:

```tsx
import { NotesCard } from '../components/canvas/NotesCard';

const nodeTypes = {
  terminal: TerminalCard,
  agent: AgentCard,
  editor: EditorCard,
  diff: DiffCard,
  fileTree: FileTreeCard,
  changes: ChangesCard,
  notes: NotesCard,   // ← 追加
};
```

> ノードの `type` は zustand 側 `cardType` と **同じキー**にする (=React Flow のノード type と CardType が 1:1)。

---

## Step 5: 初期配置 / プリセット / コマンドパレット

新カードを「ユーザーが追加できる」ようにするには、最低 1 経路を用意:

- **コマンドパレット**: `lib/commands*` に「Notes カードを追加」を登録 → `useCanvasStore.getState().addCard({ type: 'notes', title: '...' })` を呼ぶ。
- **ワークスペースプリセット**: `lib/workspace-presets*` のプリセット定義に追加 → `addCards([...])` で複数を 1 トランザクションで配置。
- **コンテキストメニュー / ボタン**: 既存 UI に追加導線がある場合のみ。

i18n (タイトル表示) が必要なら `lib/i18n*` に翻訳キーも追加。

---

## teamLocks / stageView との整合

カードが **チーム単位で動く** かどうかを決める:

- `teamLocks[teamId]` が `true` (デフォルト) なら、同じ teamId のカードがまとまって動く。
- `removeCard(id)` のデフォルトは **`cascadeTeam: true`** (canvas.ts:38-41) — × ボタンで「チーム全員消す」が起きるので、新カードが team 所属する場合は確認ダイアログ等を入れる。
- 「1 枚だけ消したい」UI (例: `team_dismiss` で 1 名解雇) は `removeCard(id, { cascadeTeam: false })` で呼ぶ。

stageView (`'stage' | 'list' | 'focus'`) の各表示モードで、新カードが正しくレイアウトされるか確認。`focus` モードは選択カードだけ拡大表示するので新カードが落ちないかチェック。

---

## pulseEdge (一時 hand-off エッジ)

別エージェント間の「一時的な可視化」用エッジを足す場合は `pulseEdge(edge, ttlMs)` を使う。
**直接 `edges` を append しない** — Issue #156 の TTL タイマ管理 (canvas.ts:94-101) を経由しないと、タイマがリークする。

```ts
useCanvasStore.getState().pulseEdge({
  id: `pulse-${from}-${to}`,
  source: from,
  target: to,
  animated: true,
  // ...
}, 1500);
```

同じ `edge.id` への連続 pulse は古い timer を clear して上書きされる (canvas.ts:97-100)。

---

## ID 衝突 (Issue #157) を踏まないために

`addCard` 内の `newId(prefix)` は `crypto.randomUUID()` ベース (canvas.ts:86-92)。
**自前で `Date.now() + counter` を組み立てない** — リロード後の counter リセットで衝突する歴史的バグ (Issue #157)。

---

## Step 6: 検証

```bash
npm run typecheck
npm run dev
```

実機:

1. コマンドパレットから新カードを追加。
2. 位置を動かす / リサイズ / 内容入力。
3. **アプリ再起動** → カードが localStorage から復元されるか (`CARD_TYPES` 漏れていると復元時に消える)。
4. team locked の他カードと一緒に動くか / 単独で動かす UI もあるか。
5. `clear()` で全消去後、addCards 経由のプリセットで一括配置。
6. stageView を `stage` / `list` / `focus` に切替えて新カードが破綻しないか。
7. delete キー / × ボタン / `removeCard(.., {cascadeTeam: false})` の挙動確認。

---

## やってはいけないこと

- **`CardType` 型だけ追加して `CARD_TYPES` 配列を放置**: persist 復元で消える silent バグ。
- **`edges` を直接書き換える hand-off**: TTL リークで再描画が止まる (Issue #156)。
- **id を自前で組み立てる**: `crypto.randomUUID()` ベース (`newId`) を使う (Issue #157)。
- **巨大な payload を `CardData.payload` に詰める**: localStorage の容量が逼迫する (画像は別 store / 別永続化に切り出す)。
- **`removeCard(id)` を「1 枚だけ消したい」用途で呼ぶ**: cascadeTeam: true がデフォルトなのでチーム全滅する。`{ cascadeTeam: false }` を明示する。
- **新カードの drag handle を本文全体にする**: 中で text 選択ができなくなる。

---

## 関連 skill

- 全体の地図 → **`vibeeditor`** skill
- TeamHub / マルチエージェント coordination → **`vibe-team`** skill
- カード見た目を Claude.ai 風に → **`claude-design`** skill
