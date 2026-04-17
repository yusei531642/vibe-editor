# ADR-2: 無限キャンバス UI に React Flow 12 (`@xyflow/react`) を採用

**Status**: Accepted
**Date**: 2026-04-17
**Phase**: 0
**PoC**: `experiments/react-flow-load/` (http://localhost:5180)

## Context
Phase 2 で導入する無限キャンバス UI に必要な機能:
- pan / zoom / minimap / 任意ノード配置 / DnD
- ノード子要素として **xterm DOM** を埋め込めること
- ノード数 20〜50 でも 60 fps を維持
- hand-off を **edge** として一級表現できること

## Decision
- **`@xyflow/react` (React Flow) v12** を採用
- ノード型 `terminal` を登録し `<TerminalNode>` を内部で `useRef` + xterm.js インスタンス化
- `useNodesState` / `useEdgesState` を Phase 2 までは直接利用、Phase 3 以降で Zustand と連携
- `onlyRenderVisibleElements` で viewport 外を仮想化 (Phase 4)
- `MiniMap` / `Background` / `Controls` 標準コンポーネント採用

## PoC 実証
- ✅ Vite 5 + React 18 + `@xyflow/react@^12.4.0` + `@xterm/xterm@^6.0.0` で 35 秒インストール、311ms で dev サーバ起動
- ✅ 20 ノード × 各 xterm インスタンス を Grid 配置で 5 列表示
- ✅ 各 xterm が ANSI カラーで `[claude] thinking` `[handoff] planner → programmer` `[error]` `[ok]` を 100ms 間隔で出力
- ✅ MiniMap・Pan/Zoom・ノード ドラッグ動作確認
- ✅ Heap 18〜22 MB (1 ノードあたり ~1MB)
- ⚠️ Playwright headless 計測の FPS は 1 (rAF throttle のため非実測値) → 実ブラウザで再計測必要 (open http://localhost:5180/)

## Phase 2 への引き継ぎ
- `src/renderer/src/components/canvas/Canvas.tsx`: 本 PoC の `App.tsx` を雛形
- `src/renderer/src/components/canvas/cards/TerminalCard.tsx`: 本 PoC の `TerminalNode.tsx` を雛形 (内部に既存 `TerminalView` を埋め込む)
- `nodeTypes` に `editor` / `diff` / `agent` を順次追加

## 却下案
- **Konva** (canvas 描画): xterm DOM を埋め込めない (canvas 内に DOM 配置不可) → NG
- **自前 CSS transform + panzoom**: minimap / edge / DnD を自作するコスト過大
- **react-zoom-pan-pinch**: pan/zoom のみで edge 概念がなく hand-off 表現不能
