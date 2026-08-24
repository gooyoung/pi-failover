# GitHub Actions Publish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Confirm that the release-driven npm publish workflow in `pi-keyrouter` matches the approved design based on `pi-langfuse`, while keeping the existing `npm test` gate.

**Architecture:** Reuse the existing single workflow file at `.github/workflows/publish.yml` and compare it against the approved sequence from the design spec. If any mismatch is found, update only that workflow file; otherwise keep the file unchanged and verify the local commands that correspond to the workflow's validation steps.

**Tech Stack:** GitHub Actions YAML, Node.js 24, npm, TypeScript, tsx test runner

## Global Constraints

- Only the release-triggered publish workflow is in scope.
- Preserve the existing `npm test` step before publish.
- Do not add push or pull request CI workflows.
- Do not change package scripts in `package.json`.
- Do not change npm publish strategy, registry, or permissions model.

---

### Task 1: Confirm or update the publish workflow

**Files:**
- Modify if needed: `.github/workflows/publish.yml`
- Reference: `docs/superpowers/specs/2026-08-24-github-actions-publish-design.md`
- Test: local shell validation using `npm run typecheck` and `npm test`

**Interfaces:**
- Consumes: approved publish sequence from `docs/superpowers/specs/2026-08-24-github-actions-publish-design.md`
- Produces: a release workflow with the following ordered steps:
  - `actions/checkout@v4` with `ref: ${{ github.event.release.tag_name }}`
  - `actions/setup-node@v4` with `node-version: 24`
  - `npm ci`
  - `npm run typecheck`
  - `npm test`
  - release tag validation script
  - `npm pack --dry-run`
  - `npm publish --provenance --access public`

- [ ] **Step 1: Read the current workflow and compare it to the approved design**

Run: `sed -n '1,220p' .github/workflows/publish.yml`
Expected: a single release-triggered publish workflow is present for review

- [ ] **Step 2: If the workflow differs, update it to this exact structure**

```yaml
name: Publish to npm

on:
  release:
    types: [published]

permissions:
  contents: read
  id-token: write

jobs:
  publish:
    name: Publish package
    runs-on: ubuntu-latest

    steps:
      - name: Checkout release tag
        uses: actions/checkout@v4
        with:
          ref: ${{ github.event.release.tag_name }}

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 24
          registry-url: 'https://registry.npmjs.org'

      - name: Install dependencies
        run: npm ci

      - name: Typecheck
        run: npm run typecheck

      - name: Test
        run: npm test

      - name: Validate release tag
        run: |
          PACKAGE_VERSION="$(node -p "require('./package.json').version")"
          EXPECTED_TAG="v${PACKAGE_VERSION}"
          RELEASE_TAG="${{ github.event.release.tag_name }}"

          if [ "${RELEASE_TAG}" != "${EXPECTED_TAG}" ]; then
            echo "Release tag ${RELEASE_TAG} does not match package version ${EXPECTED_TAG}."
            exit 1
          fi

      - name: Verify package contents
        run: npm pack --dry-run

      - name: Publish to npm
        run: npm publish --provenance --access public
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

Expected: `.github/workflows/publish.yml` exactly matches the approved release flow

- [ ] **Step 3: Re-read the workflow after any edit**

Run: `sed -n '1,220p' .github/workflows/publish.yml`
Expected: the file contains the exact ordered steps from Step 2

- [ ] **Step 4: Run typecheck**

Run: `npm run typecheck`
Expected: exit code 0 with no TypeScript errors

- [ ] **Step 5: Run tests**

Run: `npm test`
Expected: exit code 0 with all test files passing

- [ ] **Step 6: Optionally confirm packability locally**

Run: `npm pack --dry-run`
Expected: npm reports the package contents without publish errors
