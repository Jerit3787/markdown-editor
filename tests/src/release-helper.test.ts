import { createRequire } from "node:module";
import { describe, it, expect } from "vitest";

// release-helper.cjs is plain, untyped CommonJS (a GitHub Actions script,
// not part of the Worker/client build) — createRequire sidesteps TS's
// module-resolution error for a specifier with no declaration file, which
// a static `import ... from ".cjs"` would hit under this project's strict
// tsconfig.
const require = createRequire(import.meta.url);
const { extractChangelog, parseChangelogSections } = require("../../.github/scripts/release-helper.cjs");

describe("parseChangelogSections", () => {
  it("parses every version heading in file order, newest first", () => {
    const content = `# Changelog

## [1.2.0] - 2026-01-02

### Added

- Second thing.

## [1.1.0] - 2026-01-01

### Added

- First thing.
`;
    expect(parseChangelogSections(content)).toEqual([
      { version: "1.2.0", body: "### Added\n\n- Second thing." },
      { version: "1.1.0", body: "### Added\n\n- First thing." },
    ]);
  });

  it("skips a heading with no body", () => {
    const content = `## [1.0.1] - 2026-01-02

## [1.0.0] - 2026-01-01

### Added

- Initial.
`;
    expect(parseChangelogSections(content)).toEqual([{ version: "1.0.0", body: "### Added\n\n- Initial." }]);
  });
});

describe("extractChangelog", () => {
  const content = `# Changelog

## [1.41.1] - 2026-09-01

### Fixed

- Bug fixes.

## [1.41.0] - 2026-09-01

### Added

- Shared-workspace previews.

## [1.40.5] - 2026-09-01

### Fixed

- Flaky test.
`;

  it("returns just a tag's own body when the preceding version has a real tag", () => {
    expect(extractChangelog(content, "v1.40.5", ["v1.40.5", "v1.41.1"])).toBe("### Fixed\n\n- Flaky test.");
  });

  it("folds an orphaned intermediate version (no tag of its own) into the next real tag, oldest first", () => {
    // v1.41.0 never got its own tag (superseded by v1.41.1 before that
    // branch's merge commit ever became master's HEAD) — its entry should
    // be folded ahead of v1.41.1's own, not skipped and not left dangling.
    const notes = extractChangelog(content, "v1.41.1", ["v1.40.5", "v1.41.1"]);
    expect(notes).toBe("### Added\n\n- Shared-workspace previews.\n\n### Fixed\n\n- Bug fixes.");
  });

  it("folds multiple consecutive orphaned versions", () => {
    const multiOrphan = `## [2.0.0] - 2026-02-01

### Fixed

- Real release.

## [1.0.2] - 2026-01-03

### Fixed

- Orphan two.

## [1.0.1] - 2026-01-02

### Fixed

- Orphan one.

## [1.0.0] - 2026-01-01

### Added

- Initial.
`;
    const notes = extractChangelog(multiOrphan, "v2.0.0", ["v1.0.0", "v2.0.0"]);
    expect(notes).toBe("### Fixed\n\n- Orphan one.\n\n### Fixed\n\n- Orphan two.\n\n### Fixed\n\n- Real release.");
  });

  it("stops folding at the first older version that does have its own real tag", () => {
    expect(extractChangelog(content, "v1.41.1", ["v1.40.5", "v1.41.1"])).not.toContain("Flaky test");
  });

  it("returns null when the tag has no matching CHANGELOG section", () => {
    expect(extractChangelog(content, "v9.9.9", ["v9.9.9"])).toBeNull();
  });

  it("folds every older section when sortedGitTags doesn't list any of them as real tags", () => {
    // Passing a sortedGitTags that omits v1.41.0/v1.40.5 entirely means
    // this function has no way to know either one has a real tag, so it
    // treats both as orphaned and keeps folding to the top of the file —
    // this is why the real caller always passes its actual tag list
    // rather than a partial one.
    const notes = extractChangelog(content, "v1.41.1", ["v1.41.1"]);
    expect(notes).toBe("### Fixed\n\n- Flaky test.\n\n### Added\n\n- Shared-workspace previews.\n\n### Fixed\n\n- Bug fixes.");
  });
});
