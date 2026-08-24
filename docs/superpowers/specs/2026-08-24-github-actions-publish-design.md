# GitHub Actions Publish Workflow Design

## Goal

Align the current project's npm publish workflow with the `pi-langfuse` repository while preserving the existing `npm test` check in `pi-keyrouter`.

## Scope

This change only covers the GitHub Actions workflow triggered by GitHub Release publication.

In scope:
- Keep a single release-driven publish workflow in `.github/workflows/publish.yml`
- Match the overall structure and release safety checks used by `pi-langfuse`
- Preserve the existing `npm test` step before publish

Out of scope:
- Adding push or pull request CI workflows
- Changing package scripts in `package.json`
- Changing npm publish strategy, registry, or permissions model

## Approach Options

### Option 1: Strictly match `pi-langfuse`

Use the same publish workflow as `pi-langfuse` and remove the `npm test` step.

Trade-off:
- Maximum consistency with the reference repository
- We lose a project-specific validation step already present here

### Option 2: Match reference structure and keep tests

Use the same workflow structure as `pi-langfuse`, but retain the `npm test` step that already exists in `pi-keyrouter`.

Trade-off:
- High consistency with the reference repository
- Keeps current protection for this package

Recommendation: choose this option.

### Option 3: Extend the reference workflow further

Start from Option 2 and add extra GitHub Actions features such as caching or concurrency control.

Trade-off:
- Slightly stronger workflow
- Goes beyond the stated requirement of following the reference repository

## Selected Design

Update `.github/workflows/publish.yml` to keep this release flow:

1. Trigger on `release.published`
2. Checkout the release tag
3. Setup Node.js 24 with npm registry configuration
4. Install dependencies with `npm ci`
5. Run `npm run typecheck`
6. Run `npm test`
7. Validate that `github.event.release.tag_name` matches `v${package.json version}`
8. Run `npm pack --dry-run`
9. Publish with `npm publish --provenance --access public`

## Error Handling

- If dependency installation fails, publishing stops immediately
- If type checking or tests fail, publishing stops before package validation
- If the release tag does not match the package version, publishing stops before packing or publishing
- If `npm pack --dry-run` fails, publishing stops before npm publish

## Verification

Before considering the task complete:
- Verify the workflow file content matches the selected design
- Run the local commands that correspond to workflow validation:
  - `npm run typecheck`
  - `npm test`

## Files Affected

- `.github/workflows/publish.yml`
- `docs/superpowers/specs/2026-08-24-github-actions-publish-design.md`
