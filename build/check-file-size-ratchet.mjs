#!/usr/bin/env node
// Issue #939: ファイルサイズ ratchet。巨大ファイルの「再肥大化」を CI で止める。
//
// 背景: god-file 分割 (#731/#734/#736/#738) は「ファイルを分ける」が完了条件だったため、
// 分割で生まれたモジュールが上限なしに再肥大化した (recruit.rs は誕生時 1252 行)。
// 行数を継続的に減らす強制はしない代わり、「現状より悪化したら fail」する ratchet 方式で
// 単調増加だけを機械的に止める。
//
// ルール:
//   - 対象: src/**/*.{ts,tsx} (".d.ts" 除く) と src-tauri/src/**/*.rs
//   - 新規ファイルは LIMIT (500 行) 以下であること
//   - 既存の超過ファイルは build/file-size-baseline.json に「現在行数」で固定 (免除)
//   - baseline 値を超えて肥大化したら fail。縮小した場合は baseline の更新を促す (fail はしない)
//
// baseline の更新:
//   node build/check-file-size-ratchet.mjs --update-baseline
//   で現状から再生成する。**値を引き上げる更新は、分割が本当に不可能な理由を
//   PR 説明に書くこと** (review で弾く運用)。引き下げはいつでも歓迎。
//
// 制限: 行数は複雑さの代理指標にすぎない。これは「1000 行超ファイルが単調増加し続ける」
// 状態を止める tripwire であり、責務分割の質 (不変条件が単一モジュールに閉じているか) は
// review / 分割 Issue の DoD 側で担保する。

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const LIMIT = 500;
const BASELINE_PATH = join(repoRoot, 'build', 'file-size-baseline.json');

const SCAN_ROOTS = [
  { root: join(repoRoot, 'src'), exts: ['.ts', '.tsx'], excludeSuffix: ['.d.ts'] },
  { root: join(repoRoot, 'src-tauri', 'src'), exts: ['.rs'], excludeSuffix: [] }
];

function walk(dir, exts, excludeSuffix, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      walk(p, exts, excludeSuffix, out);
    } else if (
      exts.some((e) => name.endsWith(e)) &&
      !excludeSuffix.some((e) => name.endsWith(e))
    ) {
      out.push(p);
    }
  }
  return out;
}

function countLines(file) {
  return readFileSync(file, 'utf8').split(/\r?\n/).length;
}

function collect() {
  const result = new Map(); // repo-relative posix path -> lines
  for (const { root, exts, excludeSuffix } of SCAN_ROOTS) {
    for (const file of walk(root, exts, excludeSuffix)) {
      const rel = relative(repoRoot, file).replace(/\\/g, '/');
      result.set(rel, countLines(file));
    }
  }
  return result;
}

const current = collect();

if (process.argv.includes('--update-baseline')) {
  const baseline = {};
  for (const [rel, lines] of [...current.entries()].sort()) {
    if (lines > LIMIT) baseline[rel] = lines;
  }
  writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + '\n');
  console.log(
    `file-size-baseline.json を再生成しました (${Object.keys(baseline).length} 件が ${LIMIT} 行超)`
  );
  process.exit(0);
}

let baseline;
try {
  baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
} catch (err) {
  console.error(`baseline (${BASELINE_PATH}) を読めません: ${err.message}`);
  console.error('node build/check-file-size-ratchet.mjs --update-baseline で生成してください。');
  process.exit(1);
}

const violations = [];
const shrunk = [];
for (const [rel, lines] of current) {
  const allowed = Math.max(LIMIT, baseline[rel] ?? 0);
  if (lines > allowed) {
    violations.push({ rel, lines, allowed });
  } else if (baseline[rel] !== undefined && lines < baseline[rel]) {
    shrunk.push({ rel, lines, pinned: baseline[rel] });
  }
}
// 削除 / リネームされたファイルが baseline に残ると、同名で再作成されたとき
// 過去の上限を引き継いでしまう。掃除も ratchet の一部として fail させる。
const stale = Object.keys(baseline).filter((rel) => !current.has(rel));

if (shrunk.length > 0) {
  console.log('縮小されたファイルがあります。baseline の引き下げを歓迎します:');
  for (const { rel, lines, pinned } of shrunk) {
    console.log(`  ${rel}: ${pinned} -> ${lines} 行`);
  }
  console.log('  (node build/check-file-size-ratchet.mjs --update-baseline)');
}

if (violations.length > 0 || stale.length > 0) {
  if (violations.length > 0) {
    console.error(`\nファイルサイズ ratchet 違反が ${violations.length} 件あります:\n`);
    for (const { rel, lines, allowed } of violations) {
      console.error(`  ${rel}: ${lines} 行 (上限 ${allowed})`);
    }
    console.error(`
新規ファイルは ${LIMIT} 行以下、既存ファイルは baseline (build/file-size-baseline.json)
の行数を超えないでください。まず責務の切り出し (別モジュールへの分割) を検討し、
どうしても分割できない場合のみ --update-baseline で上限を引き上げ、
その理由を PR 説明に明記してください。`);
  }
  if (stale.length > 0) {
    console.error(`\nbaseline に存在しないファイルの entry が残っています (削除/リネーム済み?):\n`);
    for (const rel of stale) console.error(`  ${rel}`);
    console.error('\n--update-baseline で掃除してください。');
  }
  process.exit(1);
}

console.log(
  `file-size ratchet OK (${current.size} ファイル, baseline 免除 ${Object.keys(baseline).length} 件)`
);
