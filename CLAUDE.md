# vibe-editor

Electronベースの Claude Code 専用エディタ。

## アーキテクチャ原則
- メインプロセス: ファイルI/O、git操作、node-ptyのみ
- レンダラー: UI描画のみ。Node.jsモジュールを直接importしない
- IPC通信: contextBridgeを必ず経由する

## コーディング規約
- TypeScript strict mode
- コンポーネントは src/renderer/components/ に配置
- IPCハンドラは src/main/ipc/ にまとめる
- 型定義は src/types/ に集約

## よく使うコマンド
- 開発起動: `npm run dev`
- ビルド: `npm run build`
- パッケージング: `npm run dist`

## 実装フェーズ
- [x] Phase 1: Scaffold + Monaco + ファイルツリー
- [ ] Phase 2: CLAUDE.md管理UI（テンプレート、スキル切り替え）
- [ ] Phase 3: git diff ビューア
- [ ] Phase 4: ターミナル統合（xterm.js + node-pty）
- [ ] Phase 5: Claude Codeのトークン使用量可視化

## 注意
- node-ptyはnativeモジュールなので electron-rebuild を忘れずに
- Monaco EditorはCDNではなくnpmパッケージを使う