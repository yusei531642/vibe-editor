import { readFileSync } from 'node:fs';

const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
const release = readFileSync('.github/workflows/release.yml', 'utf8');

const failures = [];
const requireMatch = (source, pattern, message) => {
  if (!pattern.test(source)) failures.push(message);
};

requireMatch(ci, /^\s{2}workflow_call:\s*$/m, 'ci.yml must support workflow_call');
for (const command of [
  'npm run typecheck',
  'npm test',
  'cargo clippy --locked',
  'cargo test --locked',
]) {
  if (!ci.includes(command)) failures.push(`ci.yml quality gate is missing: ${command}`);
}

requireMatch(release, /^\s{2}validate-release-ref:\s*$/m, 'release.yml must validate the release ref');
requireMatch(release, /\[\[ "\$\{GITHUB_REF\}" != refs\/tags\/v\* \]\]/, 'release ref must be restricted to v* tags');
requireMatch(release, /git merge-base --is-ancestor "\$\{GITHUB_SHA\}" origin\/main/, 'release commit must be an ancestor of main');
requireMatch(release, /^\s{2}quality-gate:\s*\r?\n(?:.|\r?\n)*?uses: \.\/\.github\/workflows\/ci\.yml/m, 'release.yml must call the reusable CI workflow');
requireMatch(release, /^\s{2}build:\s*\r?\n\s{4}needs:\s*\r?\n\s{6}- validate-release-ref\s*\r?\n\s{6}- quality-gate\s*$/m, 'build must depend on ref validation and the quality gate');
requireMatch(release, /- Linux:\s+`\.AppImage` \/ `\.deb` \/ `\.rpm`/, 'release body must list the RPM artifact');

const signingStep = release.indexOf('TAURI_SIGNING_PRIVATE_KEY:');
const buildJob = release.indexOf('\n  build:');
if (signingStep === -1 || buildJob === -1 || signingStep < buildJob) {
  failures.push('signing credentials must only be used inside the gated build job');
}

if (failures.length > 0) {
  console.error('Release workflow contract check failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('Release workflow contract check passed.');
