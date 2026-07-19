import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

const splitRow = (line) =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());

const isSeparatorRow = (line) =>
  splitRow(line).every((cell) => /^:?-{3,}:?$/.test(cell));

const normalizeHeader = (cell) =>
  cell.replace(/[*_`]/g, '').trim().toLowerCase();

const stripMarkup = (cell) =>
  cell.replace(/[*`]/g, '').replace(/\s+/g, ' ').trim();

const parseCount = (cell) => {
  const match = stripMarkup(cell).replaceAll(',', '').match(/\d+/);
  return match ? Number.parseInt(match[0], 10) : null;
};

const identifierTokens = (cell) =>
  [...cell.matchAll(/`([A-Za-z_][A-Za-z0-9_]*)`/g)].map(
    (match) => match[1],
  );

const parseTables = (lines) => {
  const tables = [];

  for (let index = 0; index < lines.length - 1; index += 1) {
    if (!lines[index].trim().startsWith('|') || !isSeparatorRow(lines[index + 1])) {
      continue;
    }

    const headers = splitRow(lines[index]);
    const rows = [];
    let cursor = index + 2;
    while (cursor < lines.length && lines[cursor].trim().startsWith('|')) {
      const cells = splitRow(lines[cursor]);
      if (cells.length === headers.length) {
        rows.push({ cells, line: cursor + 1 });
      }
      cursor += 1;
    }

    tables.push({ headers, rows, startLine: index + 1 });
    index = cursor - 1;
  }

  return tables;
};

const nearestHeading = (lines, beforeLine) => {
  for (let index = beforeLine - 2; index >= 0; index -= 1) {
    if (/^#{1,6}\s+/.test(lines[index])) return lines[index];
  }
  return '';
};

export function checkMarkdownText(text, path = '<markdown>') {
  const lines = text.split(/\r?\n/);
  const tables = parseTables(lines);
  const failures = [];

  for (let summaryIndex = 0; summaryIndex < tables.length; summaryIndex += 1) {
    const summary = tables[summaryIndex];
    const summaryHeaders = summary.headers.map(normalizeHeader);
    const categoryIndex = summaryHeaders.indexOf('カテゴリ');
    const countIndex = summaryHeaders.indexOf('件数');
    if (categoryIndex === -1 || countIndex === -1) continue;

    const detail = tables
      .slice(0, summaryIndex)
      .reverse()
      .find((table) => {
        const headers = table.headers.map(normalizeHeader);
        return headers.includes('#') && headers.includes('lint');
      });
    if (!detail) continue;

    const detailHeaders = detail.headers.map(normalizeHeader);
    const lintIndex = detailHeaders.indexOf('lint');
    const detailRows = detail.rows.filter((row) =>
      /^\d+$/.test(stripMarkup(row.cells[0])),
    );
    const detailTokenSets = detailRows.map(
      (row) => new Set(identifierTokens(row.cells[lintIndex])),
    );

    const entries = summary.rows.map((row) => ({
      label: stripMarkup(row.cells[categoryIndex]),
      expected: parseCount(row.cells[countIndex]),
      line: row.line,
      tokens: identifierTokens(row.cells[categoryIndex]),
    }));
    const tokenEntries = entries.filter(
      (entry) => entry.expected !== null && entry.tokens.length > 0,
    );
    if (tokenEntries.length === 0) continue;

    const matchedDetailRows = new Set();
    for (const entry of tokenEntries) {
      const actualRows = [];
      detailTokenSets.forEach((tokens, index) => {
        if (entry.tokens.some((token) => tokens.has(token))) {
          actualRows.push(index);
          matchedDetailRows.add(index);
        }
      });

      if (entry.expected !== actualRows.length) {
        failures.push(
          `${path}:${entry.line}: ${entry.label}: 集計${entry.expected}件 / 詳細${actualRows.length}件`,
        );
      }
    }

    for (const entry of entries) {
      if (entry.expected === null) continue;
      if (/^(その他|other)$/i.test(entry.label)) {
        const actual = detailRows.length - matchedDetailRows.size;
        if (entry.expected !== actual) {
          failures.push(
            `${path}:${entry.line}: ${entry.label}: 集計${entry.expected}件 / 詳細${actual}件`,
          );
        }
      }
      if (/^(合計|total)$/i.test(entry.label) && entry.expected !== detailRows.length) {
        failures.push(
          `${path}:${entry.line}: ${entry.label}: 集計${entry.expected}件 / 詳細${detailRows.length}件`,
        );
      }
    }

    const heading = nearestHeading(lines, detail.startLine);
    const headingCount = heading.match(/[（(](\d+)\s*件[）)]/);
    if (headingCount && Number.parseInt(headingCount[1], 10) !== detailRows.length) {
      failures.push(
        `${path}:${detail.startLine}: 一覧見出し: 集計${headingCount[1]}件 / 詳細${detailRows.length}件`,
      );
    }
  }

  return failures;
}

const markdownFiles = (root) => {
  if (!existsSync(root)) return [];
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...markdownFiles(path));
    if (entry.isFile() && extname(entry.name).toLowerCase() === '.md') {
      files.push(path);
    }
  }
  return files;
};

export function checkRepositoryMarkdown() {
  const failures = [];
  for (const root of ['tasks', 'docs']) {
    for (const path of markdownFiles(root)) {
      failures.push(
        ...checkMarkdownText(
          readFileSync(path, 'utf8'),
          relative('.', path).replaceAll('\\', '/'),
        ),
      );
    }
  }
  return failures;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const failures = checkRepositoryMarkdown();
  if (failures.length > 0) {
    console.error('Markdown count consistency check failed:');
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }
  console.log('Markdown count consistency check passed.');
}
