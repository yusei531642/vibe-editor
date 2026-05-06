/**
 * AgentNodeCard barrel — 旧 `cards/AgentNodeCard.tsx` の default export 互換層。
 *
 * Issue #487: 単一ファイルだった AgentNodeCard を CardFrame.tsx (枠 / handoff)
 * と TerminalOverlay.tsx (PTY 配線) に分割。Canvas.tsx は引き続き
 *   import AgentNodeCard from './cards/AgentNodeCard';
 * で読めるよう、フォルダ resolution の起点として default を再 export する。
 */
export { default } from './CardFrame';
