#!/usr/bin/env node
// Issue #959: Tauri event payload の `json!` 直渡しを CI で禁止する tripwire。
//
// TeamHub の renderer 向け event は `src-tauri/src/team_hub/events.rs` の named struct を
// payload として emit する。`app.emit("event", json!({ ... }))` を許すと、Rust emit 箇所と
// TS listener interface の二重手書きが再発し、同一 event でも payload shape が分岐する。
//
// 例外が必要な場合は該当行の直前 3 行以内に
//   // team-event-json-exempt: <理由>
// を置く。理由なしの恒久例外は作らない。

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const scanRoots = [
  join(repoRoot, 'src-tauri', 'src', 'team_hub'),
  join(repoRoot, 'src-tauri', 'src', 'commands')
];
const EXEMPT_MARKER = 'team-event-json-exempt';
const EMIT_JSON_PATTERN = /\.emit\s*\(\s*["'][^"']+["']\s*,\s*(?:serde_json::)?json!\s*\(/m;

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
for (const root of scanRoots) {
  for (const file of walk(root)) {
    const rel = relative(repoRoot, file).replace(/\\/g, '/');
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const window = lines.slice(i, i + 8).join('\n');
      if (!EMIT_JSON_PATTERN.test(window)) continue;
      if (!/\.emit\s*\(/.test(lines[i])) continue;
      const lookback = lines.slice(Math.max(0, i - 3), i + 1).join('\n');
      if (lookback.includes(EXEMPT_MARKER)) continue;
      violations.push(`${rel}:${i + 1}: ${lines[i].trim()}`);
    }
  }
}

if (violations.length > 0) {
  console.error(
    '[check-team-event-payloads] app.emit(..., json!(...)) を検出しました。\n' +
      'renderer 向け event payload は src-tauri/src/team_hub/events.rs の named struct を使ってください (Issue #959)。\n'
  );
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}

console.log('[check-team-event-payloads] OK (no direct json! payloads in app.emit)');
