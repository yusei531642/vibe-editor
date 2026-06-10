#!/usr/bin/env node
// Issue #948: 永続化ファイルの「生 serde parse 握り潰し読込」を CI で検出する tripwire。
//
// #936 の根本原因は、新しい永続化ストアを書く開発者が `serde_json::from_*(...).ok()`
// (parse 失敗を黙って捨てて default に倒す) を最も簡単な前例としてコピーできること。
// この形は「破損 JSON → 黙って default 読込 → 次回 save で正常データを backup 無しに
// 上書き消失」のデータ消失バグを既定で内包する。読み込みは必ず
// `crate::commands::safe_load` (退避してから default に倒す共通基盤) を経由すること。
//
// 例外 (外部ツール所有ファイルの read-only 参照 / socket プロトコル行 など、
// 「破損→default→上書き消失」経路が構造的に存在しないもの) は、該当行または直前行に
//   // safe-load-exempt: <理由>
// を書いて明示的に opt-out する。理由なしの exempt は review で弾く運用。
//
// 制限: 行単位 (直後 2 行まで連結) の regex 検査なので、`.ok()` を 3 行以上離して書けば
// すり抜けられる。これは「うっかりコピーされる支配的パターン」を止める tripwire であり、
// 完全な静的解析ではない。

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const scanRoot = join(repoRoot, 'src-tauri', 'src');

// safe_load 実装自身 (doc コメントでアンチパターンを説明している) は対象外。
const EXEMPT_FILES = new Set(['commands/safe_load.rs'.replace(/\//g, '/')]);

const PATTERN = /serde_json::from_(slice|str)\b[\s\S]{0,200}?\.ok\(\)/;
const EXEMPT_MARKER = 'safe-load-exempt';

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (name.endsWith('.rs')) out.push(p);
  }
  return out;
}

const violations = [];
for (const file of walk(scanRoot)) {
  const rel = relative(scanRoot, file).replace(/\\/g, '/');
  if (EXEMPT_FILES.has(rel)) continue;
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    // 複数行 statement (`from_slice::<T>(&bytes)\n    .ok()`) も拾うため直後 2 行を連結する。
    const window = lines.slice(i, i + 3).join('\n');
    if (!PATTERN.test(window)) continue;
    if (!/serde_json::from_(slice|str)\b/.test(lines[i])) continue; // 起点行のみ報告
    // exempt マーカーは該当行または直前 3 行以内 (複数行コメントで理由を書けるように)。
    const lookback = lines.slice(Math.max(0, i - 3), i + 1).join('\n');
    if (lookback.includes(EXEMPT_MARKER)) continue;
    violations.push(`${rel}:${i + 1}: ${lines[i].trim()}`);
  }
}

if (violations.length > 0) {
  console.error(
    '[check-safe-load] 永続化ファイルの生 serde parse 握り潰し (`serde_json::from_*(...).ok()`) を検出しました。\n' +
      '`crate::commands::safe_load::safe_load_or_quarantine` / `safe_parse_or_quarantine` を使うか、\n' +
      '永続化ファイルの読込でない場合は該当行の直前に `// safe-load-exempt: <理由>` を書いてください (Issue #948)。\n'
  );
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}
console.log('[check-safe-load] OK (no raw serde parse of persisted files)');
