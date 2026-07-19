import { spawnSync } from 'node:child_process';

for (const script of [
  'build/check-review-policy.mjs',
  'build/check-markdown-count-consistency.mjs',
]) {
  const result = spawnSync(process.execPath, [script], {
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
