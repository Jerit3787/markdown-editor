# Metadata Block HTML-Comment Wrapping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wrap a document's serialized metadata block in an HTML comment so every CommonMark/GFM renderer (GitHub Gist, GitHub repo view) hides it automatically, while it stays fully visible and round-trippable in the raw `.md` source — and keep parsing backward compatible with documents already published in the old bare `Key: Value` format.

**Architecture:** A single existing file, `client/src/mmd-metadata.ts`, owns both directions (`serializeMetadataBlock` writes, `parseMetadataBlock` reads) and is the sole point of change — every consumer (Gist publish, `.md` export, repo-sync push, and the one existing reader in `stores/docs.ts`) already goes through these two functions and needs no changes itself.

**Tech Stack:** TypeScript, Vitest (existing `tests/client/src/mmd-metadata.test.ts`).

**Spec:** `docs/superpowers/specs/2026-09-05-metadata-html-comment-wrapping-design.md`

## Global Constraints

- New format: `<!--\nKey: Value\n...\n-->\n\n` prepended to body (spec's Format section).
- A value containing the literal substring `-->` must not be able to close the wrapping comment early (spec's Escaping section) — implemented by inserting U+200B (zero-width space) between the two dashes and the bracket, reversed on parse.
- `parseMetadataBlock` must still parse the legacy bare `Key: Value` format (no comment wrapper) unchanged, for documents already published under the old format (spec's Parsing section).
- No changes needed anywhere outside `mmd-metadata.ts` (spec's Scope section) — `app.ts`, `repo-sync.ts`, `stores/docs.ts`, and the Doc Info/Edit UI all call only `serializeMetadataBlock`/`parseMetadataBlock` and are unaffected by this plan.
- Patch version bump, `CHANGELOG.md` entry, no What's New entry (spec's Versioning section).

---

### Task 1: Rewrite `mmd-metadata.ts` for comment-wrapped serialization/parsing

**Files:**

- Modify: `client/src/mmd-metadata.ts` (entire file — both exported functions)
- Test: `tests/client/src/mmd-metadata.test.ts` (extend existing file; one existing test is renamed/updated, the rest are additions)

**Interfaces:**

- Consumes: nothing new — `MetadataPair { key: string; value: string }` (already defined in this file) is unchanged.
- Produces: `parseMetadataBlock(text: string): { metadata: MetadataPair[]; body: string }` and `serializeMetadataBlock(metadata: MetadataPair[], body: string): string` — same signatures as today, only their internal behavior changes. Every other file in the repo calls these two functions by name with these exact signatures; neither the names nor the signatures change in this task.

The current file (for reference — this whole file is being replaced):

```ts
export interface MetadataPair {
  key: string;
  value: string;
}

const METADATA_LINE_RE = /^([A-Za-z][\w \t-]*):[ \t]+(.*)$/;
const CONTINUATION_LINE_RE = /^[ \t]+(.*)$/;

export function parseMetadataBlock(text: string): { metadata: MetadataPair[]; body: string } {
  const lines = text.split("\n");
  const metadata: MetadataPair[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === "") {
      i++;
      break;
    }
    const m = METADATA_LINE_RE.exec(line);
    if (!m) break;
    let value = m[2]!;
    let j = i + 1;
    while (j < lines.length && lines[j]!.trim() !== "" && CONTINUATION_LINE_RE.test(lines[j]!)) {
      value += ` ${lines[j]!.trim()}`;
      j++;
    }
    metadata.push({ key: m[1]!.trim(), value });
    i = j;
  }
  if (metadata.length === 0) return { metadata: [], body: text };
  return { metadata, body: lines.slice(i).join("\n") };
}

export function serializeMetadataBlock(metadata: MetadataPair[], body: string): string {
  if (metadata.length === 0) return body;
  const block = metadata.map((m) => `${m.key}: ${m.value}`).join("\n");
  return `${block}\n\n${body}`;
}
```

- [ ] **Step 1: Write the new failing tests**

Replace the file `tests/client/src/mmd-metadata.test.ts` with this full content (the four existing `parseMetadataBlock` tests and the empty-metadata `serializeMetadataBlock` test are kept verbatim since legacy parsing and the empty case are unchanged; the old `"round-trips a single-line-only document exactly"` test is replaced by the `"upgrades a legacy..."` + `"round-trips a wrapped-format document exactly"` pair below, and several new tests are added):

```ts
import { describe, it, expect } from "vitest";
import { parseMetadataBlock, serializeMetadataBlock } from "../../../client/src/mmd-metadata";

describe("parseMetadataBlock", () => {
  it("parses a simple block", () => {
    const { metadata, body } = parseMetadataBlock("Title: My Doc\nAuthor: Jane\n\n# Heading\n");
    expect(metadata).toEqual([
      { key: "Title", value: "My Doc" },
      { key: "Author", value: "Jane" },
    ]);
    expect(body).toBe("# Heading\n");
  });

  it("joins an indented continuation line into the previous value", () => {
    const { metadata, body } = parseMetadataBlock("Title: My Very\n  Long Title\n\nBody text.\n");
    expect(metadata).toEqual([{ key: "Title", value: "My Very Long Title" }]);
    expect(body).toBe("Body text.\n");
  });

  it("returns the body unchanged when there is no metadata block", () => {
    const input = "Just a heading\n\nSome text.\n";
    const { metadata, body } = parseMetadataBlock(input);
    expect(metadata).toEqual([]);
    expect(body).toBe(input);
  });

  it("stops at the first non-matching, non-blank line even with no blank-line separator", () => {
    const { metadata, body } = parseMetadataBlock("Title: My Doc\nThis is a heading\n");
    expect(metadata).toEqual([{ key: "Title", value: "My Doc" }]);
    expect(body).toBe("This is a heading\n");
  });

  it("parses the new HTML-comment-wrapped format", () => {
    const { metadata, body } = parseMetadataBlock("<!--\nTitle: My Doc\nAuthor: Jane\n-->\n\n# Heading\n");
    expect(metadata).toEqual([
      { key: "Title", value: "My Doc" },
      { key: "Author", value: "Jane" },
    ]);
    expect(body).toBe("# Heading\n");
  });

  it("supports an indented continuation line inside the wrapped format", () => {
    const { metadata, body } = parseMetadataBlock("<!--\nTitle: My Very\n  Long Title\n-->\n\nBody.\n");
    expect(metadata).toEqual([{ key: "Title", value: "My Very Long Title" }]);
    expect(body).toBe("Body.\n");
  });

  it("unescapes a value's escaped '-->' when parsing the wrapped format", () => {
    const { metadata, body } = parseMetadataBlock("<!--\nNote: see a--\u200B>b for details\n-->\n\nBody.\n");
    expect(metadata).toEqual([{ key: "Note", value: "see a-->b for details" }]);
    expect(body).toBe("Body.\n");
  });

  it("leaves the document untouched when a leading HTML comment never closes", () => {
    const input = "<!--\nTitle: My Doc\n# Heading\n";
    const { metadata, body } = parseMetadataBlock(input);
    expect(metadata).toEqual([]);
    expect(body).toBe(input);
  });

  it("leaves the document untouched when a leading HTML comment contains no metadata lines", () => {
    const input = "<!--\njust a plain note, not metadata\n-->\n\n# Heading\n";
    const { metadata, body } = parseMetadataBlock(input);
    expect(metadata).toEqual([]);
    expect(body).toBe(input);
  });
});

describe("serializeMetadataBlock", () => {
  it("returns body unchanged when metadata is empty", () => {
    expect(serializeMetadataBlock([], "Body text.\n")).toBe("Body text.\n");
  });

  it("wraps metadata in an HTML comment", () => {
    const result = serializeMetadataBlock(
      [
        { key: "Title", value: "My Doc" },
        { key: "Author", value: "Jane" },
      ],
      "# Heading\n",
    );
    expect(result).toBe("<!--\nTitle: My Doc\nAuthor: Jane\n-->\n\n# Heading\n");
  });

  it("escapes a value containing '-->' so the wrapping comment can't be closed early", () => {
    const serialized = serializeMetadataBlock([{ key: "Note", value: "see a-->b for details" }], "Body.\n");
    expect(serialized).not.toMatch(/see a-->b/);
    const { metadata, body } = parseMetadataBlock(serialized);
    expect(metadata).toEqual([{ key: "Note", value: "see a-->b for details" }]);
    expect(body).toBe("Body.\n");
  });

  it("escapes '-->' found in a key so it can't prematurely close the wrapping comment", () => {
    const serialized = serializeMetadataBlock(
      [
        { key: "Foo-->Bar", value: "x" },
        { key: "Real", value: "y" },
      ],
      "Body.\n",
    );
    // The comment's real closing marker must be the one right before the
    // blank line and body, not one smuggled in from the first pair's key
    // — otherwise "Real: y" and the body itself would leak outside the
    // comment as visible text.
    expect(serialized.endsWith("-->\n\nBody.\n")).toBe(true);
    const closeAt = serialized.indexOf("-->\n\nBody.\n");
    expect(serialized.slice(0, closeAt)).not.toMatch(/-->/);
  });

  it("upgrades a legacy bare-format document to the wrapped format when re-serialized", () => {
    const legacy = "Title: My Doc\nAuthor: Jane\n\nBody text.\n";
    const { metadata, body } = parseMetadataBlock(legacy);
    expect(serializeMetadataBlock(metadata, body)).toBe("<!--\nTitle: My Doc\nAuthor: Jane\n-->\n\nBody text.\n");
  });

  it("round-trips a wrapped-format document exactly", () => {
    const original = "<!--\nTitle: My Doc\nAuthor: Jane\n-->\n\nBody text.\n";
    const { metadata, body } = parseMetadataBlock(original);
    expect(serializeMetadataBlock(metadata, body)).toBe(original);
  });
});
```

- [ ] **Step 2: Run the tests to verify the new ones fail**

Run: `npx vitest run tests/client/src/mmd-metadata.test.ts`

Expected: the four original `parseMetadataBlock` tests and the empty-metadata `serializeMetadataBlock` test still PASS (current code already handles those). Every new test FAILS — the wrapped-format tests fail because current `parseMetadataBlock` doesn't recognize `<!--`, and `serializeMetadataBlock` doesn't produce it; `"upgrades a legacy..."` fails because current `serializeMetadataBlock` produces the bare format, not `<!--\n...\n-->\n\n...`.

- [ ] **Step 3: Replace `client/src/mmd-metadata.ts` with the new implementation**

```ts
export interface MetadataPair {
  key: string;
  value: string;
}

const METADATA_LINE_RE = /^([A-Za-z][\w \t-]*):[ \t]+(.*)$/;
const CONTINUATION_LINE_RE = /^[ \t]+(.*)$/;
const COMMENT_OPEN = "<!--";
const COMMENT_CLOSE = "-->";

// Key and value are both free text with no character restrictions (see the
// Doc Info/Edit UI) — either could legitimately contain the literal
// substring "-->", which would otherwise close the wrapping HTML comment
// early and leak everything after it (including the rest of the metadata
// and the real body) as visible text. Splitting the two dashes from the
// bracket with a zero-width space neutralizes this invisibly, in both
// directions, without rejecting or visibly mangling the field's content.
// A key that needed escaping will no longer match METADATA_LINE_RE's own
// character class on the way back in and so won't round-trip as a parsed
// field — an acceptable loss, since such a key was never a well-formed
// metadata key to begin with; what matters is that the comment itself
// never breaks open.
const ZERO_WIDTH_SPACE = "\u200B";
function escapeCommentClose(text: string): string {
  return text.split(COMMENT_CLOSE).join(`--${ZERO_WIDTH_SPACE}>`);
}
function unescapeCommentClose(text: string): string {
  return text.split(`--${ZERO_WIDTH_SPACE}>`).join(COMMENT_CLOSE);
}

// Shared by both the new wrapped format and the legacy bare format: a run
// of "Key: Value" lines, each optionally followed by indented continuation
// lines that extend the previous value (joined with a space), stopping at
// the first blank or non-matching line. `consumed` is the index (within
// `lines`) of whichever line stopped the scan — a blank line or a
// non-matching line — so the caller can decide what to do with it; it is
// only meaningful when `metadata.length > 0`.
function scanMetadataLines(lines: string[]): { metadata: MetadataPair[]; consumed: number } {
  const metadata: MetadataPair[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === "") break;
    const m = METADATA_LINE_RE.exec(line);
    if (!m) break;
    let value = m[2]!;
    let j = i + 1;
    while (j < lines.length && lines[j]!.trim() !== "" && CONTINUATION_LINE_RE.test(lines[j]!)) {
      value += ` ${lines[j]!.trim()}`;
      j++;
    }
    metadata.push({ key: m[1]!.trim(), value });
    i = j;
  }
  return { metadata, consumed: i };
}

// If `lines[from]` is blank, it's the separator between the metadata block
// and the body — skip past it. Otherwise the block ended because it hit
// non-matching content directly (no separator), which belongs to the body
// and must be preserved.
function skipSeparator(lines: string[], from: number): number {
  return lines[from] === "" ? from + 1 : from;
}

// Metadata must be the very first thing in the document, in one of two
// forms: the new comment-wrapped form (`<!--`, one "Key: Value" line per
// field, `-->`), or — for documents already published before this format
// existed — a bare run of "Key: Value" lines with no comment wrapper at
// all. If neither is present, there is no metadata block.
export function parseMetadataBlock(text: string): { metadata: MetadataPair[]; body: string } {
  const lines = text.split("\n");

  if (lines[0] === COMMENT_OPEN) {
    const closeIndex = lines.indexOf(COMMENT_CLOSE, 1);
    if (closeIndex !== -1) {
      const { metadata } = scanMetadataLines(lines.slice(1, closeIndex));
      if (metadata.length > 0) {
        const unescaped = metadata.map((m) => ({ key: m.key, value: unescapeCommentClose(m.value) }));
        const bodyStart = skipSeparator(lines, closeIndex + 1);
        return { metadata: unescaped, body: lines.slice(bodyStart).join("\n") };
      }
    }
  }

  const { metadata, consumed } = scanMetadataLines(lines);
  if (metadata.length === 0) return { metadata: [], body: text };
  const bodyStart = skipSeparator(lines, consumed);
  return { metadata, body: lines.slice(bodyStart).join("\n") };
}

// Inverse of parseMetadataBlock — always writes the new comment-wrapped
// form (continuation lines are never re-derived; a value is written back
// out as a single line even if it was originally read from a
// continuation), followed by a blank line, prepended to body. Returns body
// unchanged if metadata is empty.
export function serializeMetadataBlock(metadata: MetadataPair[], body: string): string {
  if (metadata.length === 0) return body;
  const block = metadata.map((m) => `${escapeCommentClose(m.key)}: ${escapeCommentClose(m.value)}`).join("\n");
  return `${COMMENT_OPEN}\n${block}\n${COMMENT_CLOSE}\n\n${body}`;
}
```

- [ ] **Step 4: Run the tests to verify they all pass**

Run: `npx vitest run tests/client/src/mmd-metadata.test.ts`

Expected: PASS (all tests, both the original four kept verbatim and every new one).

- [ ] **Step 5: Run the full test suite to confirm nothing else broke**

Run: `npm test`

Expected: PASS — every other test that touches metadata (`gist.ts`, `repo-sync.ts`, `stores/docs.ts` consumers) calls `parseMetadataBlock`/`serializeMetadataBlock` with the same signatures and doesn't hardcode the old bare-line output format anywhere, so no other test file should need changes. If any other test fails, read its assertion first — it means that test was asserting the old literal wire format rather than going through these two functions, which is the actual bug to fix in that test, not in this task's implementation.

- [ ] **Step 6: Typecheck and format**

Run: `npm run typecheck && npm run format`

Expected: both clean (typecheck 0 errors; format may reformat the two files touched in this task — re-run `git diff` to confirm only whitespace/quote-style changes, if any).

- [ ] **Step 7: Commit**

```bash
git add client/src/mmd-metadata.ts tests/client/src/mmd-metadata.test.ts
git commit -m "feat: wrap serialized metadata block in an HTML comment

Hides it from every CommonMark/GFM renderer (GitHub Gist, GitHub repo
view) while keeping it fully visible and round-trippable in the raw
.md source. parseMetadataBlock still recognizes the old bare
Key: Value format (no comment wrapper) for documents already
published before this change."
```

---

### Task 2: Version bump and CHANGELOG

**Files:**

- Modify: `package.json` (version field)
- Modify: `package-lock.json` (both `"version"` fields — the root one and the matching nested one at the top of the file, per this repo's CLAUDE.md: hand-edit both rather than a full `npm install --package-lock-only` regeneration)
- Modify: `CHANGELOG.md` (new entry at the top)

**Interfaces:**

- Consumes: nothing from Task 1's code — this task only touches version/changelog metadata files.
- Produces: nothing consumed by a later task — this is the last content task before final verification.

- [ ] **Step 1: Confirm the current version**

Run: `grep -n '"version"' package.json | head -1`

Expected output: `"version": "1.42.4",` (if a different version is shown because other work has shipped in the meantime, use that version's next patch number — e.g. `1.42.5` → `1.42.6` — everywhere `1.42.5`/`1.42.4` appear below).

- [ ] **Step 2: Bump `package.json`**

In `package.json`, change:

```json
  "version": "1.42.4",
```

to:

```json
  "version": "1.42.5",
```

- [ ] **Step 3: Bump `package-lock.json`**

Run this to update both occurrences (the root package's own version and the matching nested self-reference at the top of the file) without touching any other version string in the lockfile:

```bash
python3 -c "
with open('package-lock.json') as f:
    content = f.read()
content = content.replace('\"version\": \"1.42.4\",', '\"version\": \"1.42.5\",', 2)
with open('package-lock.json', 'w') as f:
    f.write(content)
"
grep -n '"version": "1.42' package-lock.json | head -5
```

Expected: the first two matches now read `1.42.5`; no other line changed.

- [ ] **Step 4: Add the CHANGELOG entry**

In `CHANGELOG.md`, change:

```markdown
## [1.42.4] - 2026-09-05
```

to:

```markdown
## [1.42.5] - 2026-09-05

### Fixed

- **A document's metadata (Title, Author, etc. — set via the Doc Info/Edit panel) showed up as ugly, fully visible plain text at the top of a published Gist, pushed repo file, or exported `.md`.** The serialized block is now wrapped in an HTML comment, which every CommonMark/GFM renderer (GitHub Gist, GitHub's own repo file viewer) already treats as invisible — it stays fully visible and editable in the raw `.md` source, just hidden from rendered views. Metadata already published under the old bare format is still read back correctly when reopened.

## [1.42.4] - 2026-09-05
```

(use today's actual date if it differs from 2026-09-05 by the time this is executed)

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json CHANGELOG.md
git commit -m "chore: bump version to 1.42.5"
```

---

### Task 3: Final verification

**Files:** none (verification only — no file changes in this task).

**Interfaces:** none — this task only runs commands and confirms output.

- [ ] **Step 1: Full test suite**

Run: `npm test`

Expected: all tests pass (the count will be a few more than before this plan, from Task 1's new test cases).

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`

Expected: `0 ERRORS 0 WARNINGS 0 FILES_WITH_PROBLEMS` for the root/server side, and svelte-check reports no errors for the client side.

- [ ] **Step 3: Format check**

Run: `npm run format:check`

Expected: `All matched files use Prettier code style!`

- [ ] **Step 4: Build**

Run: `npm run build`

Expected: build succeeds (`✓ built in ...`); the pre-existing "chunks are larger than 500 kB" warning is unrelated and expected.

- [ ] **Step 5: Report**

Confirm to the user: tests/typecheck/format/build all pass, and hand off per this repo's shipping process in `CLAUDE.md` (push branch, open PR against `master`, wait for CI, merge).
