---
name: test-setup-vitest
description: vibe-editor (Tauri 2 + Vite 8 + React 19 + TypeScript 6) にゼロから Vitest + @testing-library/react + Tauri モック を導入し、Renderer 側のユニットテスト基盤を作るための skill。renderer 側 React コンポーネントのテスト・zustand store のテスト・`@tauri-apps/api/core` の `invoke()` モック・`@xyflow/react` Canvas テストの注意点・`monaco-editor` の jsdom スタブ・`xterm.js` のテスト除外戦略・Rust 側 `cargo test` の規約 (`#[tokio::test]` 等) の組み合わせをガイドする。`disable-model-invocation: true` (= 一度導入したら Claude が自動起動はしない、ユーザーが `/test-setup-vitest` で明示起動)。ユーザーが「テストを入れたい」「Vitest を導入」「テスト環境を整える」「unit test 基盤」「TDD したい」「invoke をモックしたい」「テストフレームワークなくて困る」「テストの書き方の規約」等を言ったときに使う。
disable-model-invocation: true
---

# test-setup-vitest

vibe-editor (Tauri 2 + Vite 8 + React 19 + TS 6) に **テスト基盤を一から導入** するときに通すスキル。
Tauri アプリのテストには「Renderer 側 (Vitest)」と「Rust 側 (cargo test)」の 2 系統があり、どちらをどこまでやるかを判断するところから始める。

> **このスキルは `disable-model-invocation: true`** = 一度入れたら Claude は自動起動しない。
> 必要時にユーザーが `/test-setup-vitest` で明示起動する。

---

## 範囲とスコープ判断

vibe-editor で最初に入れる価値があるのは **下記の 3 層** に限る。E2E は重いので後回し:

| 層                          | テスト基盤                       | テスト対象例                                              |
|-----------------------------|----------------------------------|-----------------------------------------------------------|
| Renderer ロジック層         | **Vitest + node 環境**           | zustand store (`canvas.ts` の addCard / pulseEdge 等), `lib/language.ts` の detectLanguage, `lib/themes.ts` の整合性 |
| Renderer UI 層              | **Vitest + jsdom + RTL**         | 純粋な React コンポーネント (Monaco / xterm を含まないもの) |
| Rust 側ロジック層           | **`cargo test`**                 | `commands/atomic_write.rs` / `pty/path_norm.rs` / `commands/files.rs` 等 |

**最初に入れない (理由付き)**:

- **Monaco を含むコンポーネント** — DOM API が jsdom に揃わないことが多く、unit テストが脆い。手動確認 + Playwright (将来) に回す。
- **xterm.js を含むコンポーネント** — WebGL addon (`@xterm/addon-webgl`) が jsdom で動かない。除外。
- **PTY 統合テスト** — portable-pty を CI で動かすのは面倒。Rust の lib 関数だけ `#[tokio::test]` で。
- **E2E (Playwright + tauri-driver)** — セットアップ重く、安定運用にはノウハウが要る。基盤が育ってから別スキル化。

---

## Phase 1: 依存追加

```bash
# Renderer 側 (Vitest + RTL + jsdom)
npm install -D vitest @vitest/ui @testing-library/react @testing-library/jest-dom @testing-library/user-event jsdom

# (任意) happy-dom を jsdom の代替に。RTL が動けばどちらでも可。
# npm install -D happy-dom
```

> **TypeScript 6 + React 19 + Vite 8** という最先端構成なので、各バージョンの最新 stable を使う。
> 古いブログのバージョン指定 (`vitest@1.x` 等) を鵜呑みにしない — 最新の peerDependencies を確認。

`package.json` に scripts 追加:

```jsonc
{
  "scripts": {
    "test": "vitest",
    "test:run": "vitest run",
    "test:ui": "vitest --ui",
    "test:coverage": "vitest run --coverage"
  }
}
```

`coverage` を使うなら `npm install -D @vitest/coverage-v8` も。

---

## Phase 2: Vitest 設定

`vite.config.ts` に test セクションを足す (Vite と Vitest を 1 ファイルで共有するのが Vite 8 系の流儀):

```ts
// vite.config.ts (既存に追記)
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // ... 既存設定
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/renderer/src/test-setup.ts'],
    // Tauri 関連と OS 依存テストは scope を絞る
    include: ['src/renderer/src/**/*.{test,spec}.{ts,tsx}'],
    // monaco / xterm を含むコンポーネントは初期は exclude
    exclude: [
      'src/renderer/src/components/**/{EditorView,Terminal*,DiffViewer*}.test.{ts,tsx}',
      'node_modules',
      'src-tauri',
      'dist',
    ],
    // Tauri モックを物理的に解決させる
    alias: {
      '@tauri-apps/api/core': new URL('./src/renderer/src/test-mocks/tauri-core.ts', import.meta.url).pathname,
      '@tauri-apps/api/event': new URL('./src/renderer/src/test-mocks/tauri-event.ts', import.meta.url).pathname,
    },
  },
});
```

> `import.meta.url` でのパス解決は ESM 前提。CommonJS 構成なら `path.resolve(__dirname, ...)`。

---

## Phase 3: setupFile と Tauri モック

### `src/renderer/src/test-setup.ts`

```ts
import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// React Testing Library の cleanup
afterEach(() => cleanup());

// jsdom に無い API のスタブ (必要に応じて足す)
// crypto.randomUUID は zustand canvas.ts で使われている (Issue #157)
if (typeof globalThis.crypto?.randomUUID !== 'function') {
  Object.defineProperty(globalThis.crypto, 'randomUUID', {
    value: () => `test-${Math.random().toString(36).slice(2, 12)}`,
  });
}

// matchMedia: テーマ切替 / レイアウトクエリで触る
if (typeof window !== 'undefined' && !window.matchMedia) {
  window.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}

// ResizeObserver: Monaco / xyflow が触るが、これらは exclude しているので軽い stub で十分
if (typeof globalThis.ResizeObserver === 'undefined') {
  // @ts-expect-error: テスト stub
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
```

### `src/renderer/src/test-mocks/tauri-core.ts`

```ts
// @tauri-apps/api/core の invoke() を制御可能なモックに置換する。
// テスト側からハンドラを登録できるようにして、各テストで個別の戻り値を割り当てる。

type InvokeHandler = (args: unknown) => unknown | Promise<unknown>;

const handlers = new Map<string, InvokeHandler>();

export function invoke<T = unknown>(cmd: string, args?: unknown): Promise<T> {
  const h = handlers.get(cmd);
  if (!h) {
    return Promise.reject(new Error(`[mock] invoke "${cmd}" not registered`));
  }
  return Promise.resolve(h(args)).then((v) => v as T);
}

// テスト用ヘルパ — テストファイルの beforeEach で呼ぶ
export const __mock = {
  set(cmd: string, handler: InvokeHandler) {
    handlers.set(cmd, handler);
  },
  reset() {
    handlers.clear();
  },
};
```

### `src/renderer/src/test-mocks/tauri-event.ts`

```ts
// @tauri-apps/api/event の listen() を、emit ヘルパで発火可能なモックに。
type Listener = (e: { payload: unknown }) => void;

const listeners = new Map<string, Set<Listener>>();

export type UnlistenFn = () => void;

export function listen<T = unknown>(
  event: string,
  cb: (e: { payload: T }) => void,
): Promise<UnlistenFn> {
  const set = listeners.get(event) ?? new Set();
  set.add(cb as Listener);
  listeners.set(event, set);
  return Promise.resolve(() => {
    set.delete(cb as Listener);
  });
}

// テスト用ヘルパ — テスト側から push を発火する
export const __event = {
  emit(event: string, payload: unknown) {
    const set = listeners.get(event);
    if (!set) return;
    for (const cb of set) cb({ payload });
  },
  reset() {
    listeners.clear();
  },
};
```

---

## Phase 4: 最初の 3 本のテスト (お手本)

ここから先は **既存ファイルに対する最小サンプル** を 3 本書いて、書き味を確かめる。

### 4.1 純粋関数: `lib/language.ts`

```ts
// src/renderer/src/lib/language.test.ts
import { describe, it, expect } from 'vitest';
import { detectLanguage } from './language';

describe('detectLanguage', () => {
  it('拡張子から Monaco 言語 ID を返す', () => {
    expect(detectLanguage('foo.ts')).toBe('typescript');
    expect(detectLanguage('foo.rs')).toBe('rust');
    expect(detectLanguage('foo.toml')).toBe('ini'); // Issue #77 の代替
  });
  it('Dockerfile はファイル名で特殊判定', () => {
    expect(detectLanguage('path/Dockerfile')).toBe('dockerfile');
  });
  it('未知の拡張子は plaintext', () => {
    expect(detectLanguage('foo.unknown')).toBe('plaintext');
  });
  it('拡張子なしは plaintext', () => {
    expect(detectLanguage('LICENSE')).toBe('plaintext');
  });
});
```

### 4.2 zustand store: `stores/canvas.ts`

```ts
// src/renderer/src/stores/canvas.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { useCanvasStore } from './canvas';

describe('canvas store', () => {
  beforeEach(() => {
    useCanvasStore.getState().clear();
  });

  it('addCard はノード id を返す', () => {
    const id = useCanvasStore.getState().addCard({ type: 'editor', title: 'X' });
    expect(id).toMatch(/^editor-/);
    expect(useCanvasStore.getState().nodes).toHaveLength(1);
  });

  it('removeCard はデフォルトでチームを cascade で消す', () => {
    const a = useCanvasStore.getState().addCard({ type: 'agent', title: 'A' });
    // ... 同じ teamId を持たせる payload で 2 枚目を追加するセットアップ
    useCanvasStore.getState().removeCard(a);
    expect(useCanvasStore.getState().nodes).toHaveLength(0);
  });

  it('removeCard({cascadeTeam:false}) は 1 枚だけ消す', () => {
    const a = useCanvasStore.getState().addCard({ type: 'agent', title: 'A' });
    useCanvasStore.getState().removeCard(a, { cascadeTeam: false });
    expect(useCanvasStore.getState().nodes).toHaveLength(0);
  });
});
```

### 4.3 IPC を伴う React コンポーネント (Tauri モック使用)

```tsx
// src/renderer/src/components/SomePanel.test.tsx
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
// vite alias 経由で test-mocks/tauri-core.ts が解決される
import { __mock } from '@tauri-apps/api/core';
import { SomePanel } from './SomePanel';

describe('<SomePanel />', () => {
  beforeEach(() => __mock.reset());

  it('保存ボタンで settings_save が呼ばれる', async () => {
    let receivedArgs: unknown = null;
    __mock.set('settings_save', (args) => {
      receivedArgs = args;
      return null;
    });
    const user = userEvent.setup();
    render(<SomePanel />);
    await user.click(screen.getByRole('button', { name: /保存/ }));
    await waitFor(() => expect(receivedArgs).not.toBeNull());
  });
});
```

---

## Phase 5: Rust 側のテスト規約

`src-tauri/Cargo.toml` の `[dev-dependencies]` に必要なら追加:

```toml
[dev-dependencies]
tokio = { version = "1", features = ["macros", "rt-multi-thread"] }
tempfile = "3"
```

純粋関数 / I/O を伴う関数のテスト例:

```rust
// src-tauri/src/commands/atomic_write.rs (末尾に)
#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[tokio::test]
    async fn write_then_read_round_trip() {
        let dir = tempdir().unwrap();
        let p = dir.path().join("a.json");
        atomic_write(&p, b"{}").await.unwrap();
        let v = tokio::fs::read(&p).await.unwrap();
        assert_eq!(v, b"{}");
    }
}
```

実行:

```bash
cargo test --manifest-path src-tauri/Cargo.toml
```

> **PTY / portable-pty 統合テストはここで書かない**。OS 依存が強く CI で安定しないため、別フェーズで Playwright + tauri-driver 環境を立てる時にまとめる。

---

## Phase 6: CI への組み込み

`.github/workflows/ci.yml` に test ジョブを追加:

```yaml
- run: npm ci
- run: npm run typecheck
- run: npm run test:run
- run: cargo test --manifest-path src-tauri/Cargo.toml
```

> Renderer テストだけ Linux runner (軽い)、Rust テストは matrix の中で 1 OS だけ走らせる、で OK。
> Windows 固有 (PTY 系) はそもそも除外している前提なのでクロス OS は不要。

---

## Phase 7: テスト規約 (これだけ守る)

- ファイル配置: テスト対象と **同じフォルダ** に `<name>.test.ts(x)`。`__tests__/` フォルダは作らない。
- テスト名: `describe('<対象>', ...)` + `it('<期待される振る舞い>', ...)` の日本語 OK。
- 1 テスト 1 アサーション原則は **しない** (関連アサーションはまとめて 1 テスト)。
- IPC モックは **必ず `beforeEach(() => __mock.reset())`** で初期化 (テスト間の状態漏れ防止)。
- グローバル状態 (zustand) は **必ず `beforeEach(() => store.getState().clear())`** で初期化。
- スナップショットテストは原則使わない (壊れたときに直さず雑に更新する事故が多い)。

---

## やってはいけないこと

- **Monaco / xterm を含むコンポーネントを最初から入れる**: jsdom で挙動が揃わず、テストが flaky になり開発体験が悪化する。明示的に exclude 済 (Phase 2)。
- **PTY を unit test で動かす**: ConPTY / openpty は CI で安定しない。Rust 側 `path_norm.rs` のような純粋関数だけ。
- **Tauri モックを scattered で書く**: `vite.config.ts` の `alias` で 1 か所に集約 (Phase 2)。
- **古いブログを参考にバージョンを固定する**: TS 6 / React 19 / Vite 8 は最新 stable に追従する前提。peerDependencies で確認。
- **E2E (Playwright + tauri-driver) を一気に入れる**: 別スキル化が筋。基盤が安定するまで保留。

---

## 完了判定 (このスキルが言う「終わった」)

1. `npm run test:run` が **0 ファイル / 0 テスト** ではなく、Phase 4 のサンプル 3 本以上が緑で通る。
2. `cargo test --manifest-path src-tauri/Cargo.toml` で 1 つ以上の lib テストが緑。
3. `npm run typecheck` が通る (テストファイルも含めて)。
4. `.github/workflows/ci.yml` に test step が追加され、Actions の最新 run が緑。
5. CLAUDE.md の「実装済み機能」末尾に **「テスト基盤 (Vitest + cargo test)」** の 1 行を足す (将来の自分が忘れないため)。

ここまで揃ったら **issue を 1 件起こして PR にする** (`label-and-issue-workflow` skill 経由でラベル付け、`pullrequest` skill 経由で merge まで)。導入そのものを 1 PR で完結させ、テストの追加は **別 PR** で積み上げる。

---

## 関連 skill

- IPC 関連の関数をテストするときの境界 → **`tauri-ipc-commands`** skill
- PTY のテスト戦略 (このスキルが回避している部分) → **`pty-portable-debugging`** skill
- 完了後の PR を出す → **`pullrequest`** skill
- 全体地図 → **`vibeeditor`** skill
