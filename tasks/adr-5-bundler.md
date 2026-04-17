# ADR-5: 配布バンドラは Tauri NSIS bundler

**Status**: Provisionally Accepted (本番検証は Phase 1 完了後)
**Date**: 2026-04-17
**Phase**: 0
**PoC**: `experiments/bundle-test/` (ドキュメントのみ)

## Context
現 electron-builder NSIS で:
- アイコン (build/icon.ico)
- デスクトップ + スタートメニューショートカット
- トレイ常駐
- シングルインスタンス
- アンインストール時 appData 保持
- ユニコードインストーラ
- 多言語インストーラ (EN/JA)
- カスタム installer.nsh

を実現。Tauri 移行でこれらを同等に再現する必要がある。

## Decision
- **Tauri 2 bundler の NSIS target** を採用
- `tauri.conf.json > bundle.windows.nsis`:
  ```json
  {
    "installMode": "perUser",
    "languages": ["English", "Japanese"],
    "shortcuts": { "desktop": true, "startMenu": true }
  }
  ```
- アイコンは `bundle.icon` 配列に既存 build/icon-{32,128,256}.png + icon.ico を流用
- トレイは `tauri.conf.json > app.trayIcon` + Rust `TrayIconBuilder`
- シングルインスタンスは `tauri-plugin-single-instance` 採用
- アンインストール時 `~/.vibe-editor/` 保持はカスタム NSIS template で
- 多言語インストーラはカスタム template (electron-builder の installer.nsh 移植)

## 目標値
| 項目 | 現 electron | Tauri 目標 |
|---|---|---|
| インストーラサイズ | ~120 MB | < 30 MB |
| 起動時間 | ~1.5 s | < 500 ms |
| メモリ常駐 | 200〜500 MB | < 100 MB |
| 配布 SHA | electron-builder | tauri build |

## PoC ステータス
- ✅ tauri.conf.json スキーマ確定 (experiments/bundle-test/README.md)
- ⚠️ 完全な Tauri アプリが必要 = Phase 1 と統合検証
- 📝 Phase 1 完了時に `cargo tauri build --bundles nsis` で実物確認

## Phase 1 への引き継ぎ
- `src-tauri/tauri.conf.json`: 完全な bundle セクション
- `src-tauri/Cargo.toml`: `tauri-plugin-single-instance = "2"`
- `installer.nsh` (現 build/installer.nsh): Tauri 形式に移植
- アンインストール挙動の検証スクリプト (Phase 1 e2e に追加)

## 却下案
- **MSI bundler のみ**: パッケージ管理ツールフレンドリーだがエンドユーザー向け体験で NSIS が優位
- **AppImage / Flatpak (Linux)**: 現状 Windows 専用なので Phase 1 では NSIS のみ、Phase 4 で検討
- **electron-builder を残す sidecar 戦略**: ハイブリッド方針に反する
