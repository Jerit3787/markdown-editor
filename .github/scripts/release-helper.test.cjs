const assert = require("assert");
const { extractChangelog, sortTags, appendComparisonLink, getRepoSlug } = require("./release-helper.cjs");

const sampleChangelog = `
# Changelog

## [1.14.0] - 2026-08-13

### Changed
- What's New carousel feature.

## [1.13.0] - 2026-08-13

### Added
- Threaded comments feature.
`;

const notes114 = extractChangelog(sampleChangelog, "v1.14.0");
assert(notes114.includes("What's New carousel feature"), "Should extract v1.14.0 notes");

// Test tag sorting
const unsortedTags = ["v1.14.0", "v1.2.0", "v1.10.0", "v1.0.0", "v1.4.5", "v1.4.10"];
const sorted = sortTags(unsortedTags);
assert.deepStrictEqual(sorted, ["v1.0.0", "v1.2.0", "v1.4.5", "v1.4.10", "v1.10.0", "v1.14.0"]);

// Test comparison link appending
const allTags = ["v1.0.0", "v1.13.0", "v1.14.0"];
const notesWithLink = appendComparisonLink(notes114, "v1.14.0", allTags, "Jerit3787/markdown-editor");
assert(notesWithLink.includes("**Full Changelog**: https://github.com/Jerit3787/markdown-editor/compare/v1.13.0...v1.14.0"));

const firstTagLink = appendComparisonLink("Initial release", "v1.0.0", allTags, "Jerit3787/markdown-editor");
assert(firstTagLink.includes("**Full Changelog**: https://github.com/Jerit3787/markdown-editor/commits/v1.0.0"));

console.log("Changelog parser and comparison link unit tests passed!");
