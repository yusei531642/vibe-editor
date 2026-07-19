import { readFileSync } from 'node:fs';

const activePolicyFiles = [
  'AGENTS.md',
  'CLAUDE.md',
  '.claude/skills/pullrequest/SKILL.md',
  '.claude/skills/issue-plan/SKILL.md',
  '.claude/skills/issue-autopilot-batch/SKILL.md',
  'skills/vibe-autopilot-batch/SKILL.md',
  'skills/vibe-autopilot-batch/references/leader-pipeline-loop.md',
  'skills/vibe-autopilot-batch/references/pipeline-state-schema.md',
];

const forbiddenOperationalPatterns = [
  /CodeRabbitレビュー確認/i,
  /CodeRabbit確認ゲート/i,
  /CodeRabbit.*完了まで待機/i,
  /CodeRabbitレート制限/i,
  /\bcoderabbit_status\b/i,
  /\bcoderabbit_checked\b/i,
];

const allowedLegacyLines = new Set([
  '2. 旧フィールド `coderabbit_status` または旧イベント `coderabbit_checked` がある場合、それらをreviewer通過根拠にしない。`B_completed`以外は`reviewer_status: "PENDING"`として現在のHEADを再レビューし、次回保存時に旧フィールドと旧イベントを除去して`version: "1.1"`へ移行する。',
]);

const failures = [];

for (const path of activePolicyFiles) {
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  lines.forEach((line, index) => {
    if (
      forbiddenOperationalPatterns.some((pattern) => pattern.test(line))
      && !allowedLegacyLines.has(line.trim())
    ) {
      failures.push(`${path}:${index + 1}: 廃止済みCodeRabbitの運用依存: ${line.trim()}`);
    }
  });
}

const claudeEntry = readFileSync(
  '.claude/skills/issue-autopilot-batch/SKILL.md',
  'utf8',
);
for (const staleSource of ['Google Drive', 'folderId:', 'mcp__*__read_file_content']) {
  if (claudeEntry.includes(staleSource)) {
    failures.push(`Claude互換エントリが外部の旧正典を参照しています: ${staleSource}`);
  }
}
const staleMergeRules = [
  'bot レビュー → 自動 merge',
  'PR を bot に merge してもらう',
  'vibe-editor-reviewer (bot) が自動 merge',
];
for (const path of activePolicyFiles) {
  const content = readFileSync(path, 'utf8');
  for (const staleMergeRule of staleMergeRules) {
    if (content.includes(staleMergeRule)) {
      failures.push(`${path}にreviewer自動merge規則が残っています: ${staleMergeRule}`);
    }
  }
}

const workflowContracts = [
  {
    path: 'AGENTS.md',
    required: ['PR を自動マージしない', 'ユーザー明示承認後のマージ'],
  },
  {
    path: 'CLAUDE.md',
    required: ['自動マージしない', 'ユーザーの明示承認'],
  },
  {
    path: '.claude/skills/pullrequest/SKILL.md',
    required: [
      'PR を自動マージしない',
      '現在の `HEAD_SHA` と `commit_id` が一致',
      '全 inline comment と review thread の解決状態',
      'ユーザー明示承認',
    ],
  },
  {
    path: '.claude/skills/issue-autopilot-batch/SKILL.md',
    required: ['自動mergeしない', 'ユーザー明示承認後にmerge'],
  },
];

for (const contract of workflowContracts) {
  const content = readFileSync(contract.path, 'utf8');
  for (const invariant of contract.required) {
    if (!content.includes(invariant)) {
      failures.push(`${contract.path}のreviewer-only契約が欠落しています: ${invariant}`);
    }
  }
}

const loop = readFileSync(
  'skills/vibe-autopilot-batch/references/leader-pipeline-loop.md',
  'utf8',
);
for (const invariant of [
  'reviewer_checked:<HEAD SHA>',
  'reviewer_head_sha',
  'reviewer_review_id',
  'reviewer_reviewed_at',
  'reviewer_unresolved.critical == 0',
  'criticalまたはwarningが1件以上未解決',
  'ユーザーの明示承認',
]) {
  if (!loop.includes(invariant)) {
    failures.push(`reviewer gate invariant is missing: ${invariant}`);
  }
}

if (failures.length > 0) {
  console.error('Reviewer-only policy contract check failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('Reviewer-only policy contract check passed.');
