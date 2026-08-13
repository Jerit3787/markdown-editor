# Design Spec: GitHub Actions Automated Release from CHANGELOG.md

**Date**: 2026-08-13
**Status**: Approved

## Overview
Automate GitHub Release creation whenever a version tag matching `v*` (e.g. `v1.14.0`) is pushed to the repository. The workflow extracts the corresponding version section from `CHANGELOG.md` and creates a published GitHub Release using the official `gh` CLI.

## Workflow Details

### File Path
`.github/workflows/release.yml`

### Triggers & Permissions
- **Trigger**: `push: tags: ['v*']`
- **Permissions**: `contents: write`

### Execution Steps
1. **Checkout Code**: `actions/checkout@v4`
2. **Extract Changelog Section**:
   - Extract version string from `GITHUB_REF_NAME` (stripping leading `v` if present, e.g. `v1.14.0` -> `1.14.0`).
   - Parse `CHANGELOG.md` starting from `## [<VERSION>]` up to the next `## [` heading.
   - Output extracted release notes to `RELEASE_NOTES.md`.
   - Provide a fallback release note if the version heading is not found in `CHANGELOG.md`.
3. **Publish GitHub Release**:
   - Run `gh release create` using `GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}`.
   - Title release as `${{ github.ref_name }}`.
   - Attach `RELEASE_NOTES.md` as the release body.

## Verification
- Test changelog extraction logic locally or via sample script with `CHANGELOG.md`.
- Verify workflow file syntax.
