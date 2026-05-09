/**
 * Issue #595: Canvas EditorCard の dirty 状態を一元管理する advisory registry。
 *
 * EditorCard.tsx は `content` / `original` をコンポーネントローカル `useState` で
 * 保持するため、× ボタン (`CardFrame` → `useConfirmRemoveCard`) や Canvas Clear
 * (`CanvasLayout`) からは EditorCard を unmount させずに dirty 内容を覗けない。
 * 各 EditorCard が mount 時に「自分の最新 dirty snapshot を返す closure」を
 * このモジュール scope の Map に register することで、削除/Clear 経路から
 * 同期的に「未保存の編集が残っている card 一覧」を取得して confirm dialog を
 * 出せるようにする。
 *
 * 設計メモ:
 *  - subscribers は zustand / React Context ではなく単なる module Map にする。
 *    confirm を出す側はあくまで window.confirm を一発叩きたいだけで、再描画は不要。
 *  - provider は **closure** にして、register 時点の content 値ではなく
 *    呼び出し時点の最新 ref を読み取る (`dirtySnapshotRef.current`)。
 *    これにより EditorCard の content が変わっても再 register せずに済み、
 *    `dirty` が頻繁に変わるたびに registry を作り直す churn を避けられる。
 *  - `__resetEditorCardDirtyRegistry` は test 用 (vitest 各 test 間の汚染防止)。
 */

export interface EditorCardDirtySnapshot {
  /** 表示用ファイル名。relPath が空のときも何か返す (caller 側でフォールバック表示する) */
  relPath: string;
  /** content !== original なら true */
  isDirty: boolean;
}

type SnapshotProvider = () => EditorCardDirtySnapshot;

const providers = new Map<string, SnapshotProvider>();

/**
 * EditorCard が mount 時に呼ぶ。返り値は unregister 用の cleanup 関数。
 * 同 id で既に他 provider が register 済みの場合は新しい provider で上書きする
 * (React の二重マウントなど)。unregister は「自分が登録した provider」と一致する
 * ときだけ削除し、後発の register を巻き込まないようにする。
 */
export function registerEditorCardDirty(
  id: string,
  provider: SnapshotProvider
): () => void {
  providers.set(id, provider);
  return () => {
    if (providers.get(id) === provider) {
      providers.delete(id);
    }
  };
}

export function getEditorCardDirtySnapshot(id: string): EditorCardDirtySnapshot | null {
  const p = providers.get(id);
  return p ? p() : null;
}

/**
 * dirty な editor card の id + relPath 一覧を返す。
 * `ids` 指定時は指定範囲のみ、省略時は全 register 済み card から拾う。
 *
 * 順序は呼び出し時の `ids` の順 (省略時は Map insertion order)。confirm dialog で
 * 「先に開いたファイルから順に表示」したいので Map の挿入順を尊重する。
 */
export function getDirtyEditorCardSnapshots(
  ids?: Iterable<string>
): { id: string; relPath: string }[] {
  const out: { id: string; relPath: string }[] = [];
  if (ids === undefined) {
    for (const [id, provider] of providers) {
      const snap = provider();
      if (snap.isDirty) out.push({ id, relPath: snap.relPath });
    }
    return out;
  }
  for (const id of ids) {
    const provider = providers.get(id);
    if (!provider) continue;
    const snap = provider();
    if (snap.isDirty) out.push({ id, relPath: snap.relPath });
  }
  return out;
}

/** test-only: registry を空にする。本体コードからは呼ばない。 */
export function __resetEditorCardDirtyRegistry(): void {
  providers.clear();
}
