import { readFileSync } from 'node:fs';

const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
const packages = lock.packages ?? {};

const expected = new Map([
  ['zustand', '4.5.7'],
  ['marked', '14.0.0']
]);

const errors = [];
for (const [name, version] of expected) {
  const paths = Object.keys(packages).filter(
    (path) => path === `node_modules/${name}` || path.endsWith(`/node_modules/${name}`)
  );
  const root = packages[`node_modules/${name}`];
  if (paths.length !== 1) {
    errors.push(`${name}: expected one lockfile copy, found ${paths.length} (${paths.join(', ')})`);
  }
  if (root?.version !== version) {
    errors.push(`${name}: expected root ${version}, found ${root?.version ?? 'missing'}`);
  }
}

if (errors.length > 0) {
  console.error('Dependency dedupe violations:\n' + errors.map((error) => `- ${error}`).join('\n'));
  process.exit(1);
}

console.log('Dependency dedupe OK (zustand 4.5.7, marked 14.0.0; one copy each)');
