# Release v1.4.12

## Plan

- Target version: `1.4.12`
- Previous release: `v1.4.11`
- Included local change: Issue #475 Glass canvas root tint adjustment.
- Release path: create a release PR first. Do not merge automatically. Do not push `v1.4.12` tag until PR merge, CI, CodeRabbit, and human approval are complete.

## Next Steps

- [ ] Commit the Issue #475 implementation on `feature/issue-475`.
- [ ] Create `chore/release-1.4.12` from that commit.
- [ ] Bump `package.json`, `package-lock.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, and `src-tauri/Cargo.lock` to `1.4.12`.
- [ ] Run quality gates: typecheck, targeted Vitest, full Vitest, Vite build, Cargo check, locked Cargo check, diff check.
- [ ] Push branch and create the release PR.
- [ ] Wait for CI, CodeRabbit, and human approval before merge/tag/release workflow.

## Progress

- [x] Confirmed latest GitHub release: `v1.4.11`.
- [x] Confirmed current local version: `1.4.11`.
- [x] Confirmed release workflow is triggered by `v*` tag push and creates a draft release.
- [x] Confirmed open PRs are Dependabot-only; no active release PR for `v1.4.12`.

## Verification Results

- Pending.

## Next Tasks

- [ ] Continue with the version bump and release PR creation.
