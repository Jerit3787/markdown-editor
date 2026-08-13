const assert = require('assert');
const { extractChangelog } = require('./release-helper.cjs');

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
