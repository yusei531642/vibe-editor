# Tier スコアリングテーブル（vibe-fortress-review 版）

## 概要

risk_scorer エージェントが使用する15シグナルのスコアリング定義。
入力（Issue/PR/計画/diff）を分析し、該当シグナルの重みを合算してTierを自動判定する。

---

## シグナルテーブル

| # | カテゴリ | シグナル | 重み | 判定基準 |
|---|---------|---------|------|---------|
| 1 | **データ層** | DB migration | 5 | ALTER TABLE / CREATE TABLE / マイグレーションファイルの存在 |
| 2 | **データ層** | データモデル・型定義変更 | 3 | interface/type の変更、Supabase型再生成 |
| 3 | **データ層** | キャッシュ戦略変更 | 3 | キャッシュ無効化ロジック、TTL変更 |
| 4 | **認証・課金** | 認証/認可ロジック変更 | 5 | auth middleware、JWT、RLS、getUserIdFromRequest |
| 5 | **認証・課金** | 課金・サブスク変更 | 5 | Stripe連携、billingスキーマ、クレジット消費 |
| 6 | **認証・課金** | RLSポリシー変更 | 4 | CREATE/ALTER POLICY、service_role制約変更 |
| 7 | **アーキテクチャ** | 公開API契約変更 | 4 | エンドポイント追加/削除、レスポンス型変更 |
| 8 | **アーキテクチャ** | 新規外部依存の導入 | 2 | package.json に新パッケージ追加 |
| 9 | **アーキテクチャ** | アーキテクチャパターン変更 | 4 | SSE→WebSocket移行、新ミドルウェア層など |
| 10 | **影響範囲** | 変更ファイル6個以上 | 2 | git diff --stat のファイル数 |
| 11 | **影響範囲** | 複数モジュール横断 | 3 | api/ + ui/ + db/ など3層以上に跨る |
| 12 | **影響範囲** | データ経路3本以上 | 3 | SSE + REST + polling + confirmation等 |
| 13 | **運用リスク** | ロールバック困難 | 5 | 破壊的migration、データ変換、外部API契約変更 |
| 14 | **運用リスク** | 過去障害領域 | 3 | git log / Issue履歴で障害が記録された領域 |
| 15 | **運用リスク** | フィーチャーフラグなし | 2 | 本番直接反映（段階的ロールアウト不可） |

---

## Tier 閾値

| Tier | スコア範囲 | エージェント構成 | 想定ケース |
|------|-----------|----------------|-----------|
| **A: 要塞** | **≥ 12** | risk_scorer + codex_analyzer×2 + reviewer_tech + reviewer_scenario + reviewer_security = 6体 | DB migration + 認証 + 課金が絡む変更 |
| **B: 重要** | **6–11** | risk_scorer + codex_analyzer + reviewer_tech + reviewer_scenario = 4体 | API変更 or アーキテクチャ変更 |
| **C: 標準** | **< 6** | risk_scorer + codex_analyzer + reviewer_tech = 3体 | 既存パターン踏襲の機能追加 |

**スコア0の場合:** fortress-review不要。`/sub-review` を推奨して終了。

---

## スコアシミュレーション（代表ケース）

| ケース | 該当シグナル | スコア | Tier |
|--------|------------|--------|------|
| 新画面追加（既存パターン踏襲） | なし or ファイル6+(2) のみ | 0〜2 | C |
| CRUDエンドポイント1本追加 | API契約(4)+ファイル6+(2) | 6 | B |
| DB migration + 新API | DB(5)+API(4)+ファイル6+(2) | 11 | B |
| 認証変更 + RLS + 課金 | 認証(5)+課金(5)+RLS(4) | 14 | A |
| 全面リアーキテクチャ | 多数該当 | 20+ | A |
| 既存画面のCSS修正 | なし | 0 | sub-review推奨 |

---

## カテゴリ別スコア上限

| カテゴリ | シグナル数 | 最大スコア |
|---------|-----------|----------|
| データ層 | 3 | 11 |
| 認証・課金 | 3 | 14 |
| アーキテクチャ | 3 | 10 |
| 影響範囲 | 3 | 8 |
| 運用リスク | 3 | 10 |
| **合計** | **15** | **53** |

---

## risk_scorer チェックリスト

risk_scorer エージェントは以下のチェックリストを順に確認する:

```
- [ ] DB migration が含まれるか（ALTER/CREATE TABLE、マイグレーションファイル）
- [ ] データモデル・型定義の変更があるか
- [ ] キャッシュ戦略の変更があるか
- [ ] 認証/認可ロジックの変更があるか
- [ ] 課金・サブスクリプション関連の変更があるか
- [ ] RLSポリシーの変更があるか
- [ ] 公開API契約（型・レスポンス形式）の変更があるか
- [ ] 新規外部依存の導入があるか
- [ ] アーキテクチャパターンの変更があるか
- [ ] 変更ファイルが6個以上か
- [ ] 複数モジュール（3層以上）を横断するか
- [ ] データ経路が3本以上影響を受けるか
- [ ] ロールバックが困難か
- [ ] 過去に障害が発生した領域か
- [ ] フィーチャーフラグなしの本番直接反映か
```

---

## risk_scorer 期待出力形式

```json
{
  "signals": [
    {
      "number": 1,
      "name": "DB migration",
      "category": "data",
      "weight": 5,
      "hit": true,
      "evidence": "20260502_alter_users.sql: ALTER TABLE users ADD COLUMN ..."
    },
    {
      "number": 2,
      "name": "データモデル・型定義変更",
      "category": "data",
      "weight": 3,
      "hit": false,
      "evidence": null
    }
  ],
  "total_score": 14,
  "tier": "A",
  "breakdown": {
    "data": 8,
    "auth_billing": 5,
    "architecture": 0,
    "scope": 0,
    "operations": 1
  },
  "recommended_agents": [
    "codex_analyzer x2",
    "reviewer_tech",
    "reviewer_scenario",
    "reviewer_security"
  ]
}
```

---

## 手動上書き

`--tier A|B|C` オプションでスコアリング結果を上書き可能。
上書き時もスコアリング自体は実行し、判定結果に `"override": true` を付与して記録する。
