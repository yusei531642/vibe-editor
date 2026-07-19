import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { checkMarkdownText } from './check-markdown-count-consistency.mjs';

const fixture = (name) =>
  readFileSync(new URL(`./fixtures/markdown-count-consistency/${name}`, import.meta.url), 'utf8');

test('PR #380相当の6件対7件とその他1件対0件を検出する', () => {
  const failures = checkMarkdownText(
    fixture('pr-380-invalid.md'),
    'pr-380-invalid.md',
  );

  assert.ok(
    failures.some((failure) =>
      failure.includes('doc_lazy_continuation: 集計6件 / 詳細7件'),
    ),
  );
  assert.ok(
    failures.some((failure) => failure.includes('その他: 集計1件 / 詳細0件')),
  );
});

test('PR #382相当の一致する文書は指摘しない', () => {
  assert.deepEqual(
    checkMarkdownText(fixture('pr-382-valid.md'), 'pr-382-valid.md'),
    [],
  );
});

test('件数集計ではない通常のMarkdown表は対象外にする', () => {
  const markdown = [
    '# 通常表',
    '',
    '| 項目 | 値 |',
    '|---|---|',
    '| retry | 3 |',
  ].join('\n');

  assert.deepEqual(checkMarkdownText(markdown, 'ordinary.md'), []);
});
