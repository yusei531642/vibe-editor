# ADR-4: 自動更新は tauri-plugin-updater + GitHub Releases

**Status**: Provisionally Accepted (本番検証は Phase 1 完了後)
**Date**: 2026-04-17
**Phase**: 0
**PoC**: `experiments/updater-test/` (ドキュメントのみ)

## Context
現状は `electron-updater` で GitHub Releases から差分更新。Tauri 移行で同等以上の体験を維持する必要がある。

## Decision
- **`tauri-plugin-updater` v2** を採用
- エンドポイント: `https://github.com/yusei531642/vibe-editor/releases/latest/download/latest.json`
- Tauri updater 専用 keypair (cargo tauri signer generate) を生成
  - 公開鍵 → `tauri.conf.json > plugins.updater.pubkey`
  - 秘密鍵 + パスワード → GitHub Actions Secrets
- Windows code-signing 証明書は別物 (現運用継承)
- `tauri-action@v0` で CI ビルド + `latest.json` 自動生成

## PoC ステータス
- ✅ アーキテクチャ + tauri.conf.json スキーマ確定
- ⚠️ **本物の GitHub Release を作らないと完全検証できない**
- 📝 Phase 1 完了時にプレリリース `v0.1.0-tauri-alpha` を切って:
  1. アップデート検出
  2. ダウンロード
  3. 署名検証
  4. インストーラ起動
  5. 自動再起動
  を一気通貫で確認

## Phase 1 への引き継ぎ
- `src-tauri/Cargo.toml`: `tauri-plugin-updater = "2"`
- `src-tauri/src/lib.rs`: `.plugin(tauri_plugin_updater::Builder::new().build())`
- `src-tauri/tauri.conf.json`: updater プラグイン設定 (experiments/updater-test/README.md 参照)
- `.github/workflows/release.yml`: tauri-action 採用、`TAURI_SIGNING_PRIVATE_KEY` Secret 投入

## 却下案
- **electron-updater 互換 sidecar**: ハイブリッド方針に反する
- **Sparkle (macOS)/WinSparkle**: クロスプラットフォーム統一性に欠ける
- **自前更新サーバ**: 運用コスト過大、GitHub Releases で十分
