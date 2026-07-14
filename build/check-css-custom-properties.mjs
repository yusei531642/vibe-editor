#!/usr/bin/env node
// Issue #1166: CSS custom property typoをCIで検出する。
// CSS declarationとrenderer TS/TSXのinline/setProperty注入をdefinitionとして収集し、
// var(--x) usageに対応するdefinitionが無ければpath:line付きでfailする。

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const rendererRoot = join(repoRoot, 'src', 'renderer', 'src');

// fallback付きの意図的なoptional override。exact nameと理由を必須にし、prefix許可はしない。
const OPTIONAL_CUSTOM_PROPERTIES = new Map([
  ['--accent-danger', 'component-local optional semantic accent'],
  ['--accent-success', 'component-local optional semantic accent'],
  ['--accent-warning', 'component-local optional semantic accent'],
  ['--bg-deep', 'component-local deeper background override'],
  ['--bg-elevated', 'component-local elevated background override'],
  ['--font-mono', 'legacy host-provided font override with fallback'],
  ['--panel-alt', 'component-local alternate panel override'],
  ['--text-faint', 'component-local faint text override'],
  ['--text-muted', 'component-local muted text override'],
  ['--z-popover', 'host z-index override with fallback']
]);

function walk(dir, extensions, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) walk(path, extensions, out);
    else if (extensions.has(extname(name))) out.push(path);
  }
  return out;
}

function lineAt(text, index) {
  return text.slice(0, index).split(/\r?\n/).length;
}

function collectMatches(text, regex) {
  const matches = [];
  for (const match of text.matchAll(regex)) {
    matches.push({ name: match[1], line: lineAt(text, match.index) });
  }
  return matches;
}

export function analyzeCustomProperties(cssSources, scriptSources) {
  const definitions = new Set();
  const usages = [];

  for (const source of cssSources) {
    const text = source.text.replace(/\/\*[\s\S]*?\*\//g, (comment) => ' '.repeat(comment.length));
    for (const match of text.matchAll(/(?:^|[;{]\s*)(--[a-zA-Z0-9-]+)\s*:/gm)) {
      definitions.add(match[1]);
    }
    for (const match of collectMatches(text, /var\(\s*(--[a-zA-Z0-9-]+)/g)) {
      usages.push({ ...match, path: source.path });
    }
  }

  const definitionPatterns = [
    /setProperty\(\s*['"](--[a-zA-Z0-9-]+)['"]/g,
    /['"](--[a-zA-Z0-9-]+)['"]\s+as\s+string\s*\]\s*:/g,
    /['"](--[a-zA-Z0-9-]+)['"]\s*\]\s*:/g,
    /['"](--[a-zA-Z0-9-]+)['"]\s*:/g
  ];
  for (const source of scriptSources) {
    for (const pattern of definitionPatterns) {
      for (const match of collectMatches(source.text, pattern)) definitions.add(match.name);
    }
  }

  const violations = usages.filter(
    ({ name }) => !definitions.has(name) && !OPTIONAL_CUSTOM_PROPERTIES.has(name)
  );
  return { definitions, usages, violations };
}

function selfTest() {
  const missing = analyzeCustomProperties(
    [{ path: 'fixture.css', text: '.x { color: var(--definitely-missing); }' }],
    []
  );
  if (missing.violations.length !== 1 || missing.violations[0].line !== 1) {
    throw new Error('fixture: 未定義tokenをpath:line付きで検出できません');
  }
  const inline = analyzeCustomProperties(
    [{ path: 'fixture.css', text: '.x { color: var(--inline-color); }' }],
    [{ path: 'fixture.tsx', text: "style={{ ['--inline-color' as string]: color }}" }]
  );
  if (inline.violations.length !== 0) {
    throw new Error('fixture: TSX inline custom property定義を認識できません');
  }
  const setProperty = analyzeCustomProperties(
    [{ path: 'fixture.css', text: '.x { color: var(--runtime-color); }' }],
    [{ path: 'fixture.ts', text: "root.style.setProperty('--runtime-color', color);" }]
  );
  if (setProperty.violations.length !== 0) {
    throw new Error('fixture: setProperty定義を認識できません');
  }
  const fallbackMissing = analyzeCustomProperties(
    [{ path: 'fixture.css', text: '.x { color: var(--missing-with-fallback, red); }' }],
    []
  );
  if (fallbackMissing.violations.length !== 1) {
    throw new Error('fixture: fallback付き未定義tokenを検出できません');
  }
  const commented = analyzeCustomProperties(
    [{ path: 'fixture.css', text: '/* var(--comment-only) */ .x { color: red; }' }],
    []
  );
  if (commented.violations.length !== 0) {
    throw new Error('fixture: CSSコメント内のtokenを無視できません');
  }
}

selfTest();

const cssFiles = walk(rendererRoot, new Set(['.css']));
const scriptFiles = walk(rendererRoot, new Set(['.ts', '.tsx']));
const readSources = (files) =>
  files.map((path) => ({
    path: relative(repoRoot, path).replace(/\\/g, '/'),
    text: readFileSync(path, 'utf8')
  }));
const result = analyzeCustomProperties(readSources(cssFiles), readSources(scriptFiles));

if (result.violations.length > 0) {
  console.error(`未定義CSS custom propertyが${result.violations.length}件あります:`);
  for (const violation of result.violations) {
    console.error(`  ${violation.path}:${violation.line} ${violation.name}`);
  }
  process.exit(1);
}

console.log(
  `CSS custom properties OK (${result.usages.length} usages / ${result.definitions.size} definitions)`
);
