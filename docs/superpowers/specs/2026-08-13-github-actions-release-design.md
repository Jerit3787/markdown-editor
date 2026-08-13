# Design Spec: GitHub Actions Automated Release from CHANGELOG.md

**Date**: 2026-08-13
**Status**: Revised & Approved

## Overview
Automate GitHub Release creation whenever a version tag matching `v*` (e.g. `v1.14.0`) is pushed to the repository. The workflow extracts version notes from `CHANGELOG.md`, validates that notes exist, creates a GitHub Release for the triggered tag, and checks for any prior git tags that are missing GitHub Releases to backfill them.

## Workflow Details

### File Path
`.github/workflows/release.yml`

### Triggers & Permissions
- **Trigger**: `push: tags: ['v*']`
- **Permissions**: `contents: write`

### Execution Steps
1. **Checkout Code**: `actions/checkout@v4` with `fetch-depth: 0` (to access all git tags).
2. **Setup Helper Script / Step**:
   - Query existing GitHub releases using `gh release list --limit 1000 --json tagName`.
   - List all repository git tags matching `v*`.
   - For each tag missing a GitHub release (including the newly pushed tag):
     - Strip leading `v` (e.g., `v1.14.0` -> `1.14.0`).
     - Extract the section matching `## [VERSION]` from `CHANGELOG.md` until the next `## [` or EOF.
     - Validate that extracted changelog notes exist and are non-empty.
     - If valid notes exist, create the GitHub Release:
       ```bash
       gh release create "$TAG" --title "$TAG" --notes "$NOTES"
       ```
3. **Logging & Error Handling**:
   - Log skipped tags (e.g. if release already exists or if no changelog notes exist for that tag).

## Verification
- Test changelog parser script locally against `CHANGELOG.md` and existing git tags (`v1.0.0` through `v1.14.0`).
- Validate workflow YAML structure and syntax.

