/// <reference types="vite/client" />
import type { Api } from './lib/tauri-api';
import type { JSX as ReactJSX } from 'react';

declare global {
  interface Window {
    api: Api;
  }

  /**
   * React 19 の型定義では JSX namespace が React.JSX に移動した。
   * 既存コードの `JSX.Element` 戻り型を保つため、React 側の JSX 型を
   * global JSX へ橋渡しする。
   */
  namespace JSX {
    type ElementType = ReactJSX.ElementType;
    interface Element extends ReactJSX.Element {}
    interface ElementClass extends ReactJSX.ElementClass {}
    interface ElementAttributesProperty extends ReactJSX.ElementAttributesProperty {}
    interface ElementChildrenAttribute extends ReactJSX.ElementChildrenAttribute {}
    type LibraryManagedAttributes<C, P> = ReactJSX.LibraryManagedAttributes<C, P>;
    interface IntrinsicAttributes extends ReactJSX.IntrinsicAttributes {}
    interface IntrinsicClassAttributes<T> extends ReactJSX.IntrinsicClassAttributes<T> {}
    interface IntrinsicElements extends ReactJSX.IntrinsicElements {}
  }
}

export {};
