# Release v1.4.12

## Plan

- Target version: `1.4.12`
- Previous release: `v1.4.11`
- Included local change: Issue #475 Glass canvas root tint adjustment.
- Release path: create a release PR first. Do not merge automatically. Do not push `v1.4.12` tag until PR merge, CI, CodeRabbit, and human approval are complete.

## Next Steps

- [ ] Commit the Issue #475 implementation on `feature/issue-475`.
- [ ] Create `chore/release-1.4.12` from that commit.
- [x] Bump `package.json`, `package-lock.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, and `src-tauri/Cargo.lock` to `1.4.12`.
- [x] Run quality gates: typecheck, targeted Vitest, full Vitest, Vite build, Cargo check, locked Cargo check, locked Cargo test, diff check.
- [ ] Push branch and create the release PR.
- [ ] Wait for CI, CodeRabbit, and human approval before merge/tag/release workflow.

## Progress

- [x] Confirmed latest GitHub release: `v1.4.11`.
- [x] Confirmed current local version: `1.4.11`.
- [x] Confirmed release workflow is triggered by `v*` tag push and creates a draft release.
- [x] Confirmed open PRs are Dependabot-only; no active release PR for `v1.4.12`.
- [x] Committed Issue #475 implementation: `b67ef26`.
- [x] Created release branch: `chore/release-1.4.12`.
- [x] Updated app versions to `1.4.12`.
- [x] Created release PR: https://github.com/yusei531642/vibe-editor/pull/477
- [x] Merged latest `origin/main` after PR reported `DIRTY`; conflicts were limited to `tasks/lessons.md` and `tasks/todo.md`.

## Verification Results

- [x] `cargo check --manifest-path src-tauri\Cargo.toml`: PASS
- [x] `npm run test -- src/renderer/src/styles/__tests__/glass-css-contract.test.ts`: PASS (6 tests)
- [x] `npm run typecheck`: PASS
- [x] `npm run test`: PASS (31 files / 205 tests after `origin/main` merge)
- [x] `npm run build:vite`: PASS
- [x] `cargo check --locked --manifest-path src-tauri\Cargo.toml`: PASS
- [x] `cargo test --locked --manifest-path src-tauri\Cargo.toml`: PASS (101 tests)
- [x] `git diff --check`: PASS

## Next Tasks

- [x] Commit the release bump.
- [x] Push `chore/release-1.4.12`.
- [x] Create the release PR.
- [ ] After PR merge and human approval, push `v1.4.12` tag to trigger the draft release workflow.
