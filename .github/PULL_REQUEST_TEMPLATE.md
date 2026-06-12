<!-- Issue #939: バグ修正 PR に再発防止テストを要求するテンプレート。 -->

## Summary

<!-- 何を・なぜ変更したか。バンドル PR は「#N: 何を直したか」を 1 行ずつ列挙する。 -->

Closes #

## 再発防止 (バグ修正 PR は必須)

<!-- 該当しない場合 (docs / chore 等) はセクションごと削除してよい。 -->

- [ ] 同じバグを再現する regression テスト (unit / lint / CI ゲート) を追加した
- [ ] 追加できない場合、その理由と代替の再発防止策 (型での禁止 / ratchet / tripwire 等) を下に書いた

<!-- テストを追加できない理由 / 代替策: -->

## Test plan

<!-- 実施した検証 (typecheck / cargo check / 手動確認の手順と結果) を箇条書きで。 -->

- [ ] `npm run typecheck`
- [ ] `npm run lint`
- [ ] `cargo check --manifest-path src-tauri/Cargo.toml` (Rust を触った場合)
