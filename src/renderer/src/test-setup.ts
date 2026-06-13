import '@testing-library/jest-dom/vitest';

class MemoryStorage implements Storage {
  private readonly items = new Map<string, string>();

  get length(): number {
    return this.items.size;
  }

  clear(): void {
    this.items.clear();
  }

  getItem(key: string): string | null {
    return this.items.get(String(key)) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.items.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.items.delete(String(key));
  }

  setItem(key: string, value: string): void {
    this.items.set(String(key), String(value));
  }
}

function defineGlobalStorage(storage: Storage): void {
  if (storage instanceof MemoryStorage) {
    for (const target of [globalThis, window]) {
      Object.defineProperty(target, 'Storage', {
        configurable: true,
        value: MemoryStorage
      });
    }
  }

  for (const target of [globalThis, window]) {
    Object.defineProperty(target, 'localStorage', {
      configurable: true,
      value: storage
    });
  }
}

defineGlobalStorage(new MemoryStorage());

if (typeof HTMLCanvasElement !== 'undefined') {
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    value: function getContext(_contextId: string): null {
      return null;
    }
  });
}

// jsdom には ResizeObserver が無い。Canvas/xterm 系のフックが
// マウント直後に observe を呼ぶため、最低限の no-op polyfill を入れる。
class ResizeObserverPolyfill {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

if (typeof globalThis.ResizeObserver === 'undefined') {
  (globalThis as unknown as { ResizeObserver: typeof ResizeObserverPolyfill }).ResizeObserver =
    ResizeObserverPolyfill;
}
