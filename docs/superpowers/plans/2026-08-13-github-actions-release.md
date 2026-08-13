# Automated GitHub Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a GitHub Actions workflow that automatically creates/publishes GitHub Releases based on `CHANGELOG.md` upon pushing `v*` tags, with support for backfilling missing releases for prior tags and validating non-empty changelog notes.

**Architecture:** A Node.js helper script `.github/scripts/release-helper.js` will parse `CHANGELOG.md` for a given tag (or all missing release tags), validate notes existence, and invoke the `gh` CLI to publish releases. The workflow file `.github/workflows/release.yml` runs on tag push triggers using `ubuntu-latest` and `GITHUB_TOKEN`.

**Tech Stack:** Node.js (v18+ / v20+), GitHub CLI (`gh`), GitHub Actions (`actions/checkout@v4`).

## Global Constraints
- Target workflow file: `.github/workflows/release.yml`
- Helper script file: `.github/scripts/release-helper.js`
- Permissions: `contents: write`
- Release notes format: Extracted from `CHANGELOG.md` under `## [VERSION]`

---

### Task 1: Create `.github/scripts/release-helper.js` for Changelog Extraction and Release Backfilling

**Files:**
- Create: `.github/scripts/release-helper.js`
- Test: `.github/scripts/release-helper.test.js`

**Interfaces:**
- Produces: CLI script run via `node .github/scripts/release-helper.js` which parses `CHANGELOG.md` and manages GitHub Releases via `gh`.

- [ ] **Step 1: Write unit test for changelog parsing**

Create `.github/scripts/release-helper.test.js`:
```javascript
const assert = require('assert');
const { extractChangelog } = require('./release-helper');

const sampleChangelog = `
# Changelog

## [1.14.0] - 2026-08-13

### Changed
- What's New carousel feature.

## [1.13.0] - 2026-08-13

### Added
- Threaded comments feature.
`;

const notes114 = extractChangelog(sampleChangelog, 'v1.14.0');
assert(notes114.includes("What's New carousel feature"), 'Should extract v1.14.0 notes');

const notes113 = extractChangelog(sampleChangelog, '1.13.0');
assert(notes113.includes("Threaded comments feature"), 'Should extract 1.13.0 notes');

const notesMissing = extractChangelog(sampleChangelog, 'v9.9.9');
assert.strictEqual(notesMissing, null, 'Should return null for missing versions');

console.log('Changelog parser unit tests passed!');
```

- [ ] **Step 2: Run test to verify it fails (file missing)**

Run: `node .github/scripts/release-helper.test.js`
Expected: FAIL (Cannot find module)

- [ ] **Step 3: Create `.github/scripts/release-helper.js`**

```javascript
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function extractChangelog(content, tagName) {
  const version = tagName.replace(/^v/, '');
  const escapedVersion = version.replace(/\./g, '\\.');
  // Match heading like ## [1.14.0] or ## [1.14.0] - 2026-08-13
  const regex = new RegExp(`##\\s*\\[${escapedVersion}\\][^\n]*\n([\\s\\S]*?)(?=\n##\\s*\\[|\\s*$)`, 'i');
  const match = content.match(regex);
  if (!match || !match[1].trim()) {
    return null;
  }
  return match[1].trim();
}

function processReleases() {
  const changelogPath = path.join(process.cwd(), 'CHANGELOG.md');
  if (!fs.existsSync(changelogPath)) {
    console.error('CHANGELOG.md not found');
    process.exit(1);
  }
  const changelogContent = fs.readFileSync(changelogPath, 'utf8');

  // Get current ref tag if present
  const currentTag = process.env.GITHUB_REF_NAME || '';
  
  let existingReleases = [];
  try {
    const ghOutput = execSync('gh release list --limit 1000 --json tagName', { encoding: 'utf8' });
    existingReleases = JSON.parse(ghOutput).map(r => r.tagName);
  } catch (err) {
    console.warn('Could not fetch existing releases via gh CLI:', err.message);
  }

  let tagsToProcess = [];
  if (currentTag && currentTag.startsWith('v')) {
    tagsToProcess.push(currentTag);
  }
  
  // Get all local git tags matching v*
  try {
    const gitTags = execSync('git tag -l "v*"', { encoding: 'utf8' })
      .split('\n')
      .map(t => t.trim())
      .filter(Boolean);
    for (const tag of gitTags) {
      if (!tagsToProcess.includes(tag)) {
        tagsToProcess.push(tag);
      }
    }
  } catch (err) {
    console.warn('Could not list git tags:', err.message);
  }

  console.log(`Checking ${tagsToProcess.length} tag(s)...`);

  for (const tag of tagsToProcess) {
    if (existingReleases.includes(tag)) {
      console.log(`Release for ${tag} already exists. Skipping.`);
      continue;
    }

    const notes = extractChangelog(changelogContent, tag);
    if (!notes) {
      console.log(`No changelog notes found for ${tag}. Skipping.`);
      continue;
    }

    console.log(`Creating GitHub Release for ${tag}...`);
    const tempNotesFile = path.join(process.cwd(), `.release_notes_${tag}.md`);
    fs.writeFileSync(tempNotesFile, notes, 'utf8');

    try {
      execSync(`gh release create "${tag}" --title "${tag}" --notes-file "${tempNotesFile}"`, {
        stdio: 'inherit'
      });
      console.log(`Successfully published release for ${tag}.`);
    } catch (err) {
      console.error(`Failed to create release for ${tag}:`, err.message);
    } finally {
      if (fs.existsSync(tempNotesFile)) {
        fs.unlinkSync(tempNotesFile);
      }
    }
  }
}

if (require.main === module) {
  processReleases();
}

module.exports = { extractChangelog, processReleases };
```

- [ ] **Step 4: Run unit test to verify it passes**

Run: `node .github/scripts/release-helper.test.js`
Expected: PASS ("Changelog parser unit tests passed!")

- [ ] **Step 5: Commit helper script and test**

```bash
git add .github/scripts/release-helper.js .github/scripts/release-helper.test.js
git commit -m "feat: add release helper script for parsing CHANGELOG.md and managing releases"
```

---

### Task 2: Create GitHub Actions Workflow `.github/workflows/release.yml`

**Files:**
- Create: `.github/workflows/release.yml`

- [ ] **Step 1: Write `.github/workflows/release.yml`**

```yaml
name: Release

on:
  push:
    tags:
      - 'v*'

permissions:
  contents: write

jobs:
  release:
    name: Create GitHub Release
    runs-on: ubuntu-latest

    steps:
      - name: Checkout repository
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Process releases and backfill missing
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: node .github/scripts/release-helper.js
```

- [ ] **Step 2: Verify YAML syntax**

Run: `node -e "const yaml = require('yaml'); const fs = require('fs'); yaml.parse(fs.readFileSync('.github/workflows/release.yml', 'utf8')); console.log('YAML valid!');"` (or test using standard parser).

- [ ] **Step 3: Commit workflow file**

```bash
git add .github/workflows/release.yml
git commit -m "ci: add release workflow triggered on v* tags"
```

---

### Task 3: Test Local Execution & Verification

**Files:**
- Verify: `.github/scripts/release-helper.js` against real `CHANGELOG.md`

- [ ] **Step 1: Test `extractChangelog` against real `CHANGELOG.md`**

Run: `node -e "const { extractChangelog } = require('./.github/scripts/release-helper'); const fs = require('fs'); const content = fs.readFileSync('CHANGELOG.md', 'utf8'); console.log(extractChangelog(content, 'v1.14.0'));"`
Expected: Prints the changelog section for v1.14.0.

- [ ] **Step 2: Clean up test files if any**

Run: `rm -f .github/scripts/release-helper.test.js` if temporary, or keep unit test for regression check. (Keeping unit test is recommended).

- [ ] **Step 3: Final Commit and status check**

Run: `git status`
Expected: Clean working tree.
