# Preview links & wikilinks — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the preview resolve `[text](doc-name)` markdown links to documents (or show an explicit unresolved state) instead of dead page navigations, and stop `[[Name]]` inside code spans/fences from being rewritten and rendered literally — extending the same code-awareness to the rename cascade and backlink scans.

**Architecture:** One shared dependency-free `markdown-code.ts` "skip code segments" helper (client + hand-mirrored Worker copy), consumed by the four wikilink scan/rewrite sites and by `math-preview.ts`. A new `doc-link.ts` classifies/resolves a markdown-link href against the doc list. A new pure `preview-link-render.ts` (`renderLink`) owns the whole `renderer.link` decision so it is unit-testable without mounting `Preview.svelte`.

**Tech Stack:** TypeScript, Svelte 5, marked 18, DOMPurify, Vitest (`unit` project — all new tests are pure-function / jsdom, none need the `components` browser project), Playwright.

**Spec:** `docs/superpowers/specs/2026-09-08-preview-links-wikilinks-design.md`

## Global Constraints

- **Dual-copy convention:** `client/src/markdown-code.ts` and `src/markdown-code.ts` are hand-synced identical files (same as `wikilink-rewrite.ts` / `version-grouping.ts`). Each carries a header comment pointing at the other. Client and Worker code never cross-import.
- **`client/tsconfig.json`** has `strictNullChecks`/`noImplicitAny` **off**; the root `tsconfig.json` (covers `src/**`, `tests/src/**`) is full strict. New `src/markdown-code.ts` must pass strict.
- **Never `git add src/worker.ts`** — this plan doesn't touch it; keep the dev-login patch out of every commit (`git status` before every `git add`, add explicit paths).
- Commit trailer: `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>` only. PR body ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- User-facing change → **minor version bump** happens in the final task, not before (per `CLAUDE.md`).
- Branch: continue on `docs/preview-links-spec` (already holds the spec commit; PR #184). Rename the PR in the final task.
- Existing behaviour that must not regress: a real `[[Name]]` outside code still renders `.wikilink` / `.wikilink-missing` with create-on-click; `math-preview.test.ts` stays green; `wikilink-rename-cascade` e2e (`tests/e2e/local/wikilink-rename-cascade.spec.ts`) stays green.

---

## File Structure

**Create:**
- `client/src/markdown-code.ts` — code-segment helper (client copy)
- `src/markdown-code.ts` — identical Worker copy
- `client/src/doc-link.ts` — `classifyLinkHref` / `resolveDocRef` / `looksLikeExternalDomain`
- `client/src/preview-link-render.ts` — `renderLink` / `withBlankTarget`
- `tests/client/src/markdown-code.test.ts`
- `tests/src/markdown-code.test.ts` — Worker-copy smoke test (mirrors `tests/src/wikilink-rewrite.test.ts`)
- `tests/client/src/doc-link.test.ts`
- `tests/client/src/preview-link-render.test.ts`
- `tests/e2e/local/preview-links.spec.ts`
- `tests/scripts/manual-testing/capture-preview-links-screenshot.mjs`
- `client/public/whats-new/preview-links.png`

**Modify:**
- `client/src/math-preview.ts` — import `CODE_SEGMENT_RE` from `./markdown-code` (drop the local copy)
- `client/src/wikilinks.ts` — `transformWikilinks` + `findBacklinks` code-aware
- `client/src/wikilink-rewrite.ts` — `rewriteWikilinkReferences` + `findWikilinkOccurrences` code-aware
- `src/wikilink-rewrite.ts` — `rewriteWikilinkReferences` code-aware (Worker)
- `client/src/components/Preview.svelte` — `renderer.link` → `renderLink`; click handler also matches `.doc-ref-missing`
- `tests/client/src/wikilinks.test.ts`, `tests/client/src/wikilink-rewrite.test.ts`, `tests/src/wikilink-rewrite.test.ts`, `tests/src/workspace-room.test.ts` — extend
- `CHANGELOG.md`, `client/src/whats-new-entries.ts`, `package.json`, `package-lock.json`, `ROADMAP.md`, `docs/TEST-COVERAGE.md`

---

## Task 1: `markdown-code.ts` — the shared "skip code" helper

**Files:**
- Create: `client/src/markdown-code.ts`, `src/markdown-code.ts` (identical), `tests/client/src/markdown-code.test.ts`, `tests/src/markdown-code.test.ts`

**Interfaces:**
- Produces:
  - `CODE_SEGMENT_RE: RegExp` — `/(```[\s\S]*?```|`[^`\n]*`)/g` (the exact regex `math-preview.ts` uses today)
  - `replaceOutsideCode(text: string, pattern: RegExp, replacer: (match: string, ...groups: string[]) => string): string`
  - `codeSegmentRanges(text: string): Array<{ from: number; to: number }>`
  - `isInsideCode(ranges: Array<{ from: number; to: number }>, from: number, to: number): boolean`

- [ ] **Step 1: Write the failing test** — `tests/client/src/markdown-code.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { replaceOutsideCode, codeSegmentRanges, isInsideCode, CODE_SEGMENT_RE } from "../../../client/src/markdown-code";

const upper = (m: string) => m.toUpperCase();

describe("replaceOutsideCode", () => {
  it("applies the replacer outside code, verbatim inside", () => {
    expect(replaceOutsideCode("a `x b x` c x", /x/g, upper)).toBe("a `x b x` c X");
  });
  it("skips a fenced block spanning lines", () => {
    const src = "x\n```\nx x\n```\nx";
    expect(replaceOutsideCode(src, /x/g, upper)).toBe("X\n```\nx x\n```\nX");
  });
  it("handles adjacent code spans", () => {
    expect(replaceOutsideCode("`x``x` x", /x/g, upper)).toBe("`x``x` X");
  });
  it("passes capture groups through to the replacer", () => {
    expect(replaceOutsideCode("[[A]] `[[B]]`", /\[\[([^\]]+)\]\]/g, (_m, n) => `<${n}>`)).toBe("<A> `[[B]]`");
  });
  it("leaves text with no code untouched by an unmatched pattern", () => {
    expect(replaceOutsideCode("plain text", /zzz/g, upper)).toBe("plain text");
  });
});

describe("codeSegmentRanges / isInsideCode", () => {
  it("reports each code segment's [from,to)", () => {
    const src = "ab `cd` ef `gh`";
    const r = codeSegmentRanges(src);
    expect(r).toEqual([{ from: 3, to: 7 }, { from: 11, to: 15 }]);
    expect(src.slice(r[0]!.from, r[0]!.to)).toBe("`cd`");
  });
  it("isInsideCode is true only for an overlapping range", () => {
    const r = codeSegmentRanges("xx `yy` zz");
    expect(isInsideCode(r, 4, 6)).toBe(true);   // inside `yy`
    expect(isInsideCode(r, 0, 2)).toBe(false);  // before
    expect(isInsideCode(r, 8, 10)).toBe(false); // after
  });
  it("an unterminated fence yields no range (regex needs a closing fence)", () => {
    expect(codeSegmentRanges("``` open forever")).toEqual([]);
  });
});

it("CODE_SEGMENT_RE matches the math-preview shape", () => {
  expect(CODE_SEGMENT_RE.source).toBe("(```[\\s\\S]*?```|`[^`\\n]*`)");
});
```

- [ ] **Step 2: Run — expect failure**

Run: `npx vitest run --project=unit tests/client/src/markdown-code.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `client/src/markdown-code.ts`**

```ts
// Splits markdown text on code regions so a pre-parse transform never
// touches sample syntax the user typed inside `code` or a ```fence```.
// Hand-mirrored as src/markdown-code.ts for the Worker (client and Worker
// code don't cross-import in this repo) — same convention as
// wikilink-rewrite.ts / version-grouping.ts.
//
// Scope: fenced ```...``` (across lines) and inline `...` (one line).
// Indented 4-space code blocks and unbalanced backticks are NOT handled
// — a known limitation shared with math-preview.ts, which consumes
// CODE_SEGMENT_RE from here.
export const CODE_SEGMENT_RE = /(```[\s\S]*?```|`[^`\n]*`)/g;

// String.prototype.replace's function form, but only over the parts of
// `text` outside a code segment. Splitting on a *capturing* regex
// interleaves the code segments at odd indices — left verbatim.
export function replaceOutsideCode(
  text: string,
  pattern: RegExp,
  replacer: (match: string, ...groups: string[]) => string,
): string {
  return text
    .split(CODE_SEGMENT_RE)
    .map((segment, i) => (i % 2 === 1 ? segment : segment.replace(pattern, replacer as (substring: string, ...args: unknown[]) => string)))
    .join("");
}

// Absolute [from, to) of every code segment, in document order.
export function codeSegmentRanges(text: string): Array<{ from: number; to: number }> {
  const re = new RegExp(CODE_SEGMENT_RE.source, "g");
  const ranges: Array<{ from: number; to: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    ranges.push({ from: m.index, to: m.index + m[0].length });
    if (m[0].length === 0) re.lastIndex++;
  }
  return ranges;
}

export function isInsideCode(ranges: Array<{ from: number; to: number }>, from: number, to: number): boolean {
  return ranges.some((r) => from < r.to && to > r.from);
}
```

- [ ] **Step 4: Create `src/markdown-code.ts`** — byte-identical except the header comment's direction:

Same file, first comment line changed to:
```ts
// Duplicate of client/src/markdown-code.ts (kept in sync by hand — same
// pattern as wikilink-rewrite.ts / version-grouping.ts). Consumed by
// src/wikilink-rewrite.ts for the Worker's wikilink-rename endpoint.
```
Body (the four exports) identical.

- [ ] **Step 5: Worker-copy smoke test** — `tests/src/markdown-code.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { replaceOutsideCode, codeSegmentRanges } from "../../src/markdown-code";

describe("markdown-code (Worker copy)", () => {
  it("replaceOutsideCode skips a code span", () => {
    expect(replaceOutsideCode("a `x` x", /x/g, (m) => m.toUpperCase())).toBe("a `x` X");
  });
  it("codeSegmentRanges finds a fenced block", () => {
    const src = "p\n```\nq\n```\n";
    const [r] = codeSegmentRanges(src);
    expect(src.slice(r!.from, r!.to)).toBe("```\nq\n```");
  });
});
```

- [ ] **Step 6: Run tests + typecheck**

Run: `npx vitest run --project=unit tests/client/src/markdown-code.test.ts tests/src/markdown-code.test.ts` — PASS
Run: `npm run typecheck` — clean

- [ ] **Step 7: Commit**

```bash
git add client/src/markdown-code.ts src/markdown-code.ts tests/client/src/markdown-code.test.ts tests/src/markdown-code.test.ts
git commit -m "$(cat <<'EOF'
feat(markdown): shared "skip code segments" helper (client + Worker copy)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `math-preview.ts` consumes the shared regex

**Files:**
- Modify: `client/src/math-preview.ts`
- Test: existing `tests/client/src/math-preview.test.ts` (must stay green — no new test)

**Interfaces:**
- Consumes: `CODE_SEGMENT_RE` from `./markdown-code`

- [ ] **Step 1: Replace the local constant**

In `client/src/math-preview.ts`, delete:
```ts
const CODE_SEGMENT_RE = /(```[\s\S]*?```|`[^`\n]*`)/g;
```
and its 3-line lead comment, and add to the import block at the top:
```ts
import { CODE_SEGMENT_RE } from "./markdown-code";
```
Leave `extractMathSpans`'s `rawMarkdown.split(CODE_SEGMENT_RE)` call as-is.

- [ ] **Step 2: Run the math suite + typecheck**

Run: `npx vitest run --project=unit tests/client/src/math-preview.test.ts` — PASS (unchanged behaviour)
Run: `npm run typecheck` — clean

- [ ] **Step 3: Commit**

```bash
git add client/src/math-preview.ts
git commit -m "$(cat <<'EOF'
refactor(math-preview): use the shared CODE_SEGMENT_RE

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: G2 — wikilink scans & rewrites skip code

**Files:**
- Modify: `client/src/wikilinks.ts`, `client/src/wikilink-rewrite.ts`, `src/wikilink-rewrite.ts`
- Test: `tests/client/src/wikilinks.test.ts`, `tests/client/src/wikilink-rewrite.test.ts`, `tests/src/wikilink-rewrite.test.ts`, `tests/src/workspace-room.test.ts` (all extend)

**Interfaces:**
- Consumes: `replaceOutsideCode`, `codeSegmentRanges`, `isInsideCode` from `./markdown-code` (client) / `./markdown-code` (Worker)
- Produces (signatures unchanged): `transformWikilinks(content)`, `findBacklinks(name, docs, excludeId?)`, `rewriteWikilinkReferences(content, old, new)`, `findWikilinkOccurrences(content, name)`

- [ ] **Step 1: Failing tests — `tests/client/src/wikilinks.test.ts`** (append to the existing `describe`s)

```ts
describe("transformWikilinks — code awareness", () => {
  it("leaves [[X]] inside an inline code span verbatim", () => {
    expect(transformWikilinks("run `[[Secret]]` now")).toBe("run `[[Secret]]` now");
  });
  it("leaves [[X]] inside a fenced block verbatim", () => {
    expect(transformWikilinks("```\n[[InFence]]\n```")).toBe("```\n[[InFence]]\n```");
  });
  it("still rewrites [[X]] outside code on a line with a code span", () => {
    expect(transformWikilinks("`code` then [[Doc]]")).toBe("`code` then [Doc](wikilink:Doc)");
  });
});

describe("findBacklinks — code awareness", () => {
  const docs = [
    { id: "1", name: "Target", content: "", updatedAt: 0, createdAt: 0, workspaceId: "w" },
    { id: "2", name: "RealRef", content: "see [[Target]]", updatedAt: 0, createdAt: 0, workspaceId: "w" },
    { id: "3", name: "CodeOnly", content: "example: `[[Target]]`", updatedAt: 0, createdAt: 0, workspaceId: "w" },
  ];
  it("counts a prose [[Target]] but not a code-only one", () => {
    expect(findBacklinks("Target", docs).map((d) => d.id)).toEqual(["2"]);
  });
});
```

- [ ] **Step 2: Failing tests — `tests/client/src/wikilink-rewrite.test.ts`** (append)

```ts
describe("rewriteWikilinkReferences — code awareness", () => {
  it("does not rename [[Old]] inside a fenced block", () => {
    const src = "[[Old]]\n```\n[[Old]]\n```";
    expect(rewriteWikilinkReferences(src, "Old", "New")).toBe("[[New]]\n```\n[[Old]]\n```");
  });
  it("does not rename [[Old]] inside an inline code span", () => {
    expect(rewriteWikilinkReferences("`[[Old]]` and [[Old]]", "Old", "New")).toBe("`[[Old]]` and [[New]]");
  });
});

describe("findWikilinkOccurrences — code awareness", () => {
  it("skips an in-code occurrence, keeps correct offsets for the rest", () => {
    const content = "`[[Old]]` x [[Old]] y";
    const occ = findWikilinkOccurrences(content, "Old");
    expect(occ).toEqual([{ from: 12, to: 19 }]);
    expect(content.slice(occ[0]!.from, occ[0]!.to)).toBe("[[Old]]");
  });
});
```

- [ ] **Step 3: Failing test — `tests/src/wikilink-rewrite.test.ts`** (append inside the existing `describe`)

```ts
it("does not rewrite [[Old]] inside a code span (Worker copy)", () => {
  expect(rewriteWikilinkReferences("`[[Old]]` and [[Old]]", "Old", "New")).toBe("`[[Old]]` and [[New]]");
});
```

- [ ] **Step 4: Failing test — `tests/src/workspace-room.test.ts`** (add after the "rewrites the room's live content" test, ~line 845)

```ts
it("leaves a [[Old]] inside a code span untouched", async () => {
  const room = new WorkspaceRoom(fakeState(), fakeEnvWithSecret);
  await room.state.storage.put("access", { owner: "alice", generalAccess: "restricted", requireAccount: false, role: "viewer", invited: [] });
  const docRoom = await room.loadDocRoom("docA");
  docRoom.doc.transact(() => docRoom.doc.getText("content").insert(0, "`[[Old]]` and [[Old]]"), "storage");
  const cookie = await encryptSession(fakeEnvWithSecret, { token: "gh-token", username: "alice" });
  const request = new Request("https://example.com/w/ws1/docs/docA/wikilink-rename", {
    method: "POST",
    headers: { Cookie: `mde_gh_session=${cookie}`, "Content-Type": "application/json" },
    body: JSON.stringify({ oldName: "Old", newName: "New" }),
  });
  const res = await room.handleWikilinkRenameRequest(request, "docA");
  expect(res.status).toBe(200);
  expect(docRoom.doc.getText("content").toString()).toBe("`[[Old]]` and [[New]]");
});
```

- [ ] **Step 5: Run — expect all four files failing on the new cases**

Run: `npx vitest run --project=unit tests/client/src/wikilinks.test.ts tests/client/src/wikilink-rewrite.test.ts tests/src/wikilink-rewrite.test.ts tests/src/workspace-room.test.ts`
Expected: the new tests FAIL, existing ones PASS.

- [ ] **Step 6: Implement — `client/src/wikilinks.ts`**

```ts
import type { Doc } from "./types";
import { codeSegmentRanges, isInsideCode, replaceOutsideCode } from "./markdown-code";

const WIKILINK_RE = /\[\[([^[\]\n]+)\]\]/g;

export function transformWikilinks(content: string): string {
  return replaceOutsideCode(content, WIKILINK_RE, (_match, name: string) => `[${name}](wikilink:${encodeURIComponent(name)})`);
}

export function resolveWikilinkTarget(name: string, docs: Doc[]): Doc | undefined {
  return docs.find((d) => d.name === name);
}

// A [[targetName]] reference that is NOT inside a code span / fence.
function hasWikilinkOutsideCode(content: string, targetName: string): boolean {
  if (!content.includes(`[[${targetName}]]`)) return false; // fast reject
  const ranges = codeSegmentRanges(content);
  const re = /\[\[([^[\]\n]+)\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) {
    if (m[1] === targetName && !isInsideCode(ranges, m.index, m.index + m[0].length)) return true;
  }
  return false;
}

export function findBacklinks(targetName: string, docs: Doc[], excludeId?: string): Doc[] {
  return docs.filter((d) => d.id !== excludeId && hasWikilinkOutsideCode(d.content, targetName));
}
```

(Keep the existing doc comments where they still apply; update the `findBacklinks` comment to say "outside code spans/fences".)

- [ ] **Step 7: Implement — `client/src/wikilink-rewrite.ts`**

```ts
import { codeSegmentRanges, isInsideCode, replaceOutsideCode } from "./markdown-code";

const WIKILINK_RE = /\[\[([^[\]\n]+)\]\]/g;

export function rewriteWikilinkReferences(content: string, oldName: string, newName: string): string {
  return replaceOutsideCode(content, WIKILINK_RE, (match, name: string) => (name === oldName ? `[[${newName}]]` : match));
}

export interface WikilinkOccurrence {
  from: number;
  to: number;
}

export function findWikilinkOccurrences(content: string, name: string): WikilinkOccurrence[] {
  const ranges = codeSegmentRanges(content);
  const re = /\[\[([^[\]\n]+)\]\]/g;
  const occurrences: WikilinkOccurrence[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) {
    if (m[1] === name && !isInsideCode(ranges, m.index, m.index + m[0].length)) {
      occurrences.push({ from: m.index, to: m.index + m[0].length });
    }
  }
  return occurrences;
}
```

Keep the file's existing header comment; add a line noting it now imports from `./markdown-code` (which also has a Worker copy).

- [ ] **Step 8: Implement — `src/wikilink-rewrite.ts`**

```ts
import { replaceOutsideCode } from "./markdown-code";

const WIKILINK_RE = /\[\[([^[\]\n]+)\]\]/g;

export function rewriteWikilinkReferences(content: string, oldName: string, newName: string): string {
  return replaceOutsideCode(content, WIKILINK_RE, (match, name: string) => (name === oldName ? `[[${newName}]]` : match));
}
```

(Preserve/adjust the "Duplicate of client/src/wikilink-rewrite.ts" header comment.)

- [ ] **Step 9: Run tests + typecheck + build**

Run: `npx vitest run --project=unit tests/client/src/wikilinks.test.ts tests/client/src/wikilink-rewrite.test.ts tests/src/wikilink-rewrite.test.ts tests/src/workspace-room.test.ts` — PASS
Run: `npm run typecheck` — clean (strict for `src/**` — check `src/wikilink-rewrite.ts` + `src/markdown-code.ts`)
Run: `npm test` — whole suite green (catches any `math-preview` / `wikilink-rename-cascade` unit fallout)

- [ ] **Step 10: Commit**

```bash
git add client/src/wikilinks.ts client/src/wikilink-rewrite.ts src/wikilink-rewrite.ts tests/client/src/wikilinks.test.ts tests/client/src/wikilink-rewrite.test.ts tests/src/wikilink-rewrite.test.ts tests/src/workspace-room.test.ts
git commit -m "$(cat <<'EOF'
fix(wikilinks): never rewrite [[Name]] inside code spans or fences (G2)

transformWikilinks, rewriteWikilinkReferences (client + Worker),
findWikilinkOccurrences and findBacklinks all now skip code regions, so a
[[X]] typed as literal sample text is left alone in the preview, the
rename cascade and the backlinks panel.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `doc-link.ts` — classify & resolve a markdown-link href

**Files:**
- Create: `client/src/doc-link.ts`, `tests/client/src/doc-link.test.ts`

**Interfaces:**
- Consumes: `Doc` from `./types`
- Produces:
  - `type LinkHrefKind = "external" | "anchor" | "absolute" | "doc-ref"`
  - `classifyLinkHref(href: string): LinkHrefKind`
  - `resolveDocRef(href: string, docs: Doc[]): Doc | undefined`
  - `looksLikeExternalDomain(ref: string): boolean` — `ref` is a decoded, `./`-stripped href

- [ ] **Step 1: Write the failing test** — `tests/client/src/doc-link.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { classifyLinkHref, resolveDocRef, looksLikeExternalDomain } from "../../../client/src/doc-link";
import type { Doc } from "../../../client/src/types";

const d = (over: Partial<Doc>): Doc => ({ id: "x", name: "N", content: "", updatedAt: 0, createdAt: 0, workspaceId: "w", ...over });

describe("classifyLinkHref", () => {
  it.each([
    ["#section", "anchor"],
    ["/assets/x.png", "absolute"],
    ["//cdn.example.com/x", "external"],
    ["https://example.com", "external"],
    ["mailto:a@b.com", "external"],
    ["tel:+1234", "external"],
    ["My Note", "doc-ref"],
    ["./docs/notes.md", "doc-ref"],
    ["notes", "doc-ref"],
  ] as const)("%s -> %s", (href, kind) => {
    expect(classifyLinkHref(href)).toBe(kind);
  });
});

describe("resolveDocRef", () => {
  const docs = [
    d({ id: "1", name: "Design Notes" }),
    d({ id: "2", name: "API", repoPath: "docs/api.md" }),
  ];
  it("matches an exact document name", () => {
    expect(resolveDocRef("Design Notes", docs)?.id).toBe("1");
  });
  it("matches a %20-encoded name", () => {
    expect(resolveDocRef("Design%20Notes", docs)?.id).toBe("1");
  });
  it("matches a name with a .md suffix stripped", () => {
    expect(resolveDocRef("Design Notes.md", docs)?.id).toBe("1");
  });
  it("matches a repoPath, with and without ./", () => {
    expect(resolveDocRef("docs/api.md", docs)?.id).toBe("2");
    expect(resolveDocRef("./docs/api.md", docs)?.id).toBe("2");
  });
  it("matches a repoPath basename against a doc name", () => {
    expect(resolveDocRef("./notes/Design Notes.md", docs)?.id).toBe("1");
  });
  it("returns undefined for no match", () => {
    expect(resolveDocRef("Nope", docs)).toBeUndefined();
  });
});

describe("looksLikeExternalDomain", () => {
  it.each([
    ["example.com", true],
    ["docs.example.com/page", true],
    ["my-site.io", true],
    ["notes.md", false],
    ["My Note", false],
    ["docs/notes", false],
    ["plainword", false],
    ["1.2.3.4", false],
  ] as const)("%s -> %s", (ref, expected) => {
    expect(looksLikeExternalDomain(ref)).toBe(expected);
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `npx vitest run --project=unit tests/client/src/doc-link.test.ts` — FAIL (module not found)

- [ ] **Step 3: Implement** — `client/src/doc-link.ts`

```ts
import type { Doc } from "./types";

export type LinkHrefKind = "external" | "anchor" | "absolute" | "doc-ref";

// A URL scheme prefix: http:, https:, mailto:, tel:, ftp:, ... The
// preview's renderer.link checks the "wikilink:" scheme itself, before
// this is ever called.
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const MD_EXT_RE = /\.(?:md|markdown)$/i;
const DOCISH_EXT_RE = /\.(?:md|markdown|txt)$/i;

export function classifyLinkHref(href: string): LinkHrefKind {
  if (href.startsWith("#")) return "anchor";
  if (href.startsWith("//")) return "external"; // protocol-relative
  if (href.startsWith("/")) return "absolute";
  if (SCHEME_RE.test(href)) return "external";
  return "doc-ref";
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function normalizeRef(href: string): string {
  const decoded = safeDecode(href);
  return decoded.startsWith("./") ? decoded.slice(2) : decoded;
}

export function resolveDocRef(href: string, docs: Doc[]): Doc | undefined {
  const ref = normalizeRef(href);
  const refNoMd = ref.replace(MD_EXT_RE, "");
  const refAsRepoPath = MD_EXT_RE.test(ref) ? ref : `${ref}.md`;
  const baseNoMd = (ref.split("/").pop() ?? ref).replace(MD_EXT_RE, "");
  return (
    docs.find((doc) => doc.name === ref) ??
    docs.find((doc) => doc.name === refNoMd) ??
    docs.find((doc) => doc.repoPath === ref) ??
    docs.find((doc) => doc.repoPath === refAsRepoPath) ??
    docs.find((doc) => doc.name === baseNoMd)
  );
}

// A doc-ref that resolved to nothing: does it read as a bare website
// domain the author meant to link out to? (example.com,
// docs.example.com/page — but not notes.md, "My Note", docs/notes)
export function looksLikeExternalDomain(ref: string): boolean {
  if (/\s/.test(ref)) return false;
  if (DOCISH_EXT_RE.test(ref)) return false;
  const host = ref.split("/")[0] ?? "";
  if (!host.includes(".")) return false;
  const tld = host.split(".").pop() ?? "";
  return /^[a-z]{2,}$/i.test(tld);
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run --project=unit tests/client/src/doc-link.test.ts` — PASS
Run: `npm run typecheck` — clean

- [ ] **Step 5: Commit**

```bash
git add client/src/doc-link.ts tests/client/src/doc-link.test.ts
git commit -m "$(cat <<'EOF'
feat(doc-link): classify and resolve a markdown-link href to a document

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: `preview-link-render.ts` — the whole `renderer.link` decision

**Files:**
- Create: `client/src/preview-link-render.ts`, `tests/client/src/preview-link-render.test.ts`

**Interfaces:**
- Consumes: `Doc` from `./types`; `resolveWikilinkTarget` from `./wikilinks`; `classifyLinkHref` / `resolveDocRef` / `looksLikeExternalDomain` from `./doc-link`
- Produces:
  - `interface RenderLinkDeps { docs: Doc[]; renderDefault: (href: string, title: string | null, text: string, tokens: unknown[]) => string; escapeHtml: (s: string) => string; }`
  - `renderLink(href: string, title: string | null, text: string, tokens: unknown[], deps: RenderLinkDeps): string`
  - `withBlankTarget(anchorHtml: string): string`

- [ ] **Step 1: Write the failing test** — `tests/client/src/preview-link-render.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { renderLink, withBlankTarget, type RenderLinkDeps } from "../../../client/src/preview-link-render";
import type { Doc } from "../../../client/src/types";

const doc = (over: Partial<Doc>): Doc => ({ id: "x", name: "N", content: "", updatedAt: 0, createdAt: 0, workspaceId: "w", ...over });
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const renderDefault = (href: string, _t: string | null, text: string) => `<a href="${esc(href)}">${text}</a>`;
const deps = (docs: Doc[]): RenderLinkDeps => ({ docs, renderDefault, escapeHtml: esc });

describe("withBlankTarget", () => {
  it("adds target+rel to a bare anchor", () => {
    expect(withBlankTarget('<a href="https://x.com">x</a>')).toBe('<a target="_blank" rel="noopener noreferrer" href="https://x.com">x</a>');
  });
  it("leaves an anchor that already has target alone", () => {
    const html = '<a target="_self" href="x">x</a>';
    expect(withBlankTarget(html)).toBe(html);
  });
});

describe("renderLink", () => {
  it("wikilink: scheme, resolved -> .wikilink with data-doc-name", () => {
    const out = renderLink("wikilink:Recipes", null, "Recipes", [], deps([doc({ name: "Recipes" })]));
    expect(out).toBe('<a href="#" class="wikilink" data-doc-name="Recipes">Recipes</a>');
  });
  it("wikilink: scheme, unresolved -> .wikilink-missing", () => {
    const out = renderLink("wikilink:Ghost", null, "Ghost", [], deps([]));
    expect(out).toContain('class="wikilink wikilink-missing"');
  });
  it("doc-ref that resolves -> .wikilink with the RESOLVED name", () => {
    const out = renderLink("api.md", null, "the API", [], deps([doc({ id: "2", name: "API", repoPath: "api.md" })]));
    expect(out).toBe('<a href="#" class="wikilink" data-doc-name="API">the API</a>');
  });
  it("doc-ref, no doc, domain-like -> external https:// in a new tab", () => {
    const out = renderLink("example.com", null, "site", [], deps([]));
    expect(out).toBe('<a target="_blank" rel="noopener noreferrer" href="https://example.com">site</a>');
  });
  it("doc-ref, no doc, not domain-like -> .doc-ref-missing, no data-doc-name", () => {
    const out = renderLink("Some Draft", null, "draft", [], deps([]));
    expect(out).toContain('class="wikilink wikilink-missing doc-ref-missing"');
    expect(out).toContain('data-doc-ref="Some Draft"');
    expect(out).toContain('title="No document named &quot;Some Draft&quot;"');
    expect(out).not.toContain("data-doc-name");
  });
  it("real external link -> default renderer + target", () => {
    const out = renderLink("https://example.com/a", "t", "x", [], deps([]));
    expect(out).toBe('<a target="_blank" rel="noopener noreferrer" href="https://example.com/a">x</a>');
  });
  it("anchor and absolute -> untouched default renderer", () => {
    expect(renderLink("#top", null, "top", [], deps([]))).toBe('<a href="#top">top</a>');
    expect(renderLink("/x.png", null, "img", [], deps([]))).toBe('<a href="/x.png">img</a>');
  });
  it("escapes the link text and the ref", () => {
    const out = renderLink("a<b>", null, "<script>", [], deps([]));
    expect(out).toContain("&lt;script&gt;");
    expect(out).toContain('data-doc-ref="a&lt;b&gt;"');
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `npx vitest run --project=unit tests/client/src/preview-link-render.test.ts` — FAIL

- [ ] **Step 3: Implement** — `client/src/preview-link-render.ts`

```ts
import type { Doc } from "./types";
import { resolveWikilinkTarget } from "./wikilinks";
import { classifyLinkHref, looksLikeExternalDomain, resolveDocRef } from "./doc-link";

export interface RenderLinkDeps {
  docs: Doc[];
  // marked's default link renderer, already bound to the active Renderer.
  renderDefault: (href: string, title: string | null, text: string, tokens: unknown[]) => string;
  escapeHtml: (s: string) => string;
}

const WIKILINK_SCHEME = "wikilink:";

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// marked's default link renderer emits a single predictable
// `<a href="..."[ title="..."]>` opening tag — a targeted insert after
// `<a ` is enough (covered by tests), no HTML parse needed.
export function withBlankTarget(anchorHtml: string): string {
  if (/<a\s[^>]*\btarget=/.test(anchorHtml)) return anchorHtml;
  return anchorHtml.replace(/<a\s/, '<a target="_blank" rel="noopener noreferrer" ');
}

export function renderLink(
  href: string,
  title: string | null,
  text: string,
  tokens: unknown[],
  deps: RenderLinkDeps,
): string {
  const { docs, renderDefault, escapeHtml } = deps;

  if (href.startsWith(WIKILINK_SCHEME)) {
    const name = safeDecode(href.slice(WIKILINK_SCHEME.length));
    const cls = resolveWikilinkTarget(name, docs) ? "wikilink" : "wikilink wikilink-missing";
    return `<a href="#" class="${cls}" data-doc-name="${escapeHtml(name)}">${escapeHtml(text)}</a>`;
  }

  const kind = classifyLinkHref(href);
  if (kind === "doc-ref") {
    const hit = resolveDocRef(href, docs);
    if (hit) {
      return `<a href="#" class="wikilink" data-doc-name="${escapeHtml(hit.name)}">${escapeHtml(text)}</a>`;
    }
    const ref = safeDecode(href).replace(/^\.\//, "");
    if (looksLikeExternalDomain(ref)) {
      return withBlankTarget(renderDefault(`https://${ref}`, title, text, tokens));
    }
    return `<a href="#" class="wikilink wikilink-missing doc-ref-missing" data-doc-ref="${escapeHtml(ref)}" title="No document named &quot;${escapeHtml(ref)}&quot;">${escapeHtml(text)}</a>`;
  }

  if (kind === "external") {
    return withBlankTarget(renderDefault(href, title, text, tokens));
  }

  return renderDefault(href, title, text, tokens); // anchor / absolute
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run --project=unit tests/client/src/preview-link-render.test.ts` — PASS
Run: `npm run typecheck` — clean

- [ ] **Step 5: Commit**

```bash
git add client/src/preview-link-render.ts tests/client/src/preview-link-render.test.ts
git commit -m "$(cat <<'EOF'
feat(preview): renderLink — document-aware markdown links (G1)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Wire `renderLink` into `Preview.svelte` + click handler + e2e

**Files:**
- Modify: `client/src/components/Preview.svelte`
- Create: `tests/e2e/local/preview-links.spec.ts`

**Interfaces:**
- Consumes: `renderLink` from `../preview-link-render`; existing `escapeHtml`, `get`, `docsStore`, `resolveWikilinkTarget`, `createDoc`, `switchDoc as storeSwitchDoc`

- [ ] **Step 1: Replace the `renderer.link` block**

In `client/src/components/Preview.svelte`, add to the imports:
```ts
  import { renderLink } from "../preview-link-render";
```
(`escapeHtml` is already imported at line 16; `transformWikilinks` / `resolveWikilinkTarget` from `../wikilinks` stay.)

Replace the current `renderer.link` assignment (lines ~74–81) with:
```ts
    const defaultLinkRenderer = marked.Renderer.prototype.link.bind(renderer);
    const renderDefault = (href: string, title: string | null, text: string, tokens: unknown[]) =>
      defaultLinkRenderer({ type: "link", raw: href, href, title, text, tokens: tokens as never });
    renderer.link = ({ href, title, text, tokens }) =>
      renderLink(href, title ?? null, text, (tokens ?? []) as unknown[], { docs: get(docsStore), renderDefault, escapeHtml });
```

- [ ] **Step 2: Extend the click handler**

In `initWikilinkNavigation()` (~line 386), replace the body:
```ts
  function initWikilinkNavigation() {
    hostEl!.addEventListener("click", (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>(".wikilink, .doc-ref-missing");
      if (!el) return;
      e.preventDefault();

      if (el.classList.contains("doc-ref-missing")) {
        // A [text](ref) link that matched no document. A clean bare name
        // offers to create it (parity with an unresolved [[wikilink]]); a
        // path / filename form is a dead end we don't want to
        // materialise as a doc literally named "docs/notes.md".
        const ref = el.getAttribute("data-doc-ref") ?? "";
        if (ref && !ref.includes("/") && !/\.[a-z0-9]+$/i.test(ref)) createDoc({ name: ref });
        return;
      }

      const name = el.getAttribute("data-doc-name");
      if (!name) return;
      const target = resolveWikilinkTarget(name, get(docsStore));
      if (target) {
        storeSwitchDoc(target.id);
      } else {
        createDoc({ name });
      }
    });
  }
```

- [ ] **Step 3: Build + typecheck**

Run: `npm run typecheck` — clean
Run: `npm run build` — succeeds

- [ ] **Step 4: Write the e2e** — `tests/e2e/local/preview-links.spec.ts`

```ts
import { test, expect } from "./support/fixtures";

// NOTE: marked rejects a link destination containing a raw space —
// `[a](Design Notes)` is literal text, not a link (pre-existing marked
// behaviour, out of scope). A space-containing target must be written
// `[a](Design%20Notes)` or `[a](<Design Notes>)`; resolveDocRef decodes
// it. These tests use the `%20` form and a space-free name.

test("G1: a [text](Doc%20Name) link navigates to that document in-app", async ({ page }) => {
  await page.evaluate(async () => {
    const { createDoc, switchDoc } = await import("/src/stores/docs.ts");
    createDoc({ id: "pl-target", name: "Design Notes" });
    switchDoc("e2e-doc-1");
  });
  await page.click("#editor-mount .cm-content");
  await page.keyboard.type("See [the notes](Design%20Notes) here.");
  await expect(page.locator("#preview a.wikilink")).toHaveText("the notes");
  await page.click("#preview a.wikilink");
  await expect.poll(() => page.evaluate(() => new URL(location.href).pathname)).toContain("pl-target");
});

test("G1: an unresolved [text](ref) shows the dashed affordance and does not navigate", async ({ page }) => {
  await page.click("#editor-mount .cm-content");
  await page.keyboard.type("[a draft](SomeDraftDoc)");
  const link = page.locator("#preview a.doc-ref-missing");
  await expect(link).toHaveAttribute("title", /No document named/);
  const before = page.url();
  await link.click();
  expect(page.url()).toBe(before);
});

test("G1: a bare-domain link opens in a new tab", async ({ page }) => {
  await page.click("#editor-mount .cm-content");
  await page.keyboard.type("[our site](example.com)");
  const link = page.locator('#preview a[href="https://example.com"]');
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", /noopener/);
});

test("G2: [[Name]] inside an inline code span renders literally", async ({ page }) => {
  await page.click("#editor-mount .cm-content");
  await page.keyboard.type("use `[[Secret]]` verbatim");
  await expect(page.locator("#preview code")).toHaveText("[[Secret]]");
  await expect(page.locator("#preview")).not.toContainText("wikilink:");
});
```

- [ ] **Step 5: Run e2e**

Run: `npm run test:e2e:local -- preview-links` (sandbox browser caveat from `CLAUDE.md` applies)
Expected: 4 pass. Then run the wikilink regression file too:
Run: `npm run test:e2e:local -- slash-and-wikilinks wikilink-rename-cascade` — still green.

- [ ] **Step 6: Commit**

```bash
git add client/src/components/Preview.svelte tests/e2e/local/preview-links.spec.ts
git commit -m "$(cat <<'EOF'
fix(preview): resolve inter-document markdown links, open external links in a new tab (G1)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Release — 1.X.0

**Files:**
- Modify: `CHANGELOG.md`, `client/src/whats-new-entries.ts`, `package.json`, `package-lock.json`, `ROADMAP.md`, `docs/TEST-COVERAGE.md`
- Create: `tests/scripts/manual-testing/capture-preview-links-screenshot.mjs`, `client/public/whats-new/preview-links.png`

- [ ] **Step 1: Full local verification**

```bash
npm test
npm run typecheck
npm run format        # then re-stage anything it touched
npm run build
npm run test:e2e:local
npm run test:e2e:collab
```
All green. `git diff --quiet src/worker.ts` → clean.

- [ ] **Step 2: `CHANGELOG.md`**

Determine the next minor from `package.json` (`1.50.0` at plan time → `1.51.0` unless something shipped in between — check `git log origin/master` / `CHANGELOG.md` head). Add at the top:

```markdown
## [1.51.0] - <YYYY-MM-DD>

### Fixed

- **Links between documents now work.** A markdown link like `[the spec](Design Notes)` or `[api](docs/api.md)` opens that document instead of navigating to a dead `/d/…` page; one that matches no document shows a dashed "no such document" style instead of a broken link.
- **`[[wikilink]]` syntax no longer leaks into code samples.** A `[[Name]]` typed inside `` `inline code` `` or a ``` ``` ``` fence is left exactly as written in the preview, and a document rename no longer edits `[[Name]]` mentions inside code blocks.

### Changed

- **External links in the preview open in a new tab** (`target="_blank"`), so following one no longer navigates away from the editor.
```

- [ ] **Step 3: Capture the What's New screenshot**

Create `tests/scripts/manual-testing/capture-preview-links-screenshot.mjs` — model on `capture-focus-mode-polish-screenshot.mjs` (plain `chromium.launch()`, seed `mde:docs` via `localStorage`, no dev-login). Content: two docs ("Weekly Notes", "Design Notes"); in the open doc type

```
See the [Design Notes](Design Notes) for background.

Config key: `[[legacy]]` is left untouched.
```

split view, screenshot the preview pane showing the working link (`.wikilink`) and the literal `` `[[legacy]]` `` code span. Save to `client/public/whats-new/preview-links.png`. (Write the link as `[Design Notes](Design%20Notes)` — marked rejects a raw space in a link target.)

Run it against a local build + `npm run dev` (no dev-login needed). Verify the PNG. **A real screenshot — never a placeholder.**

- [ ] **Step 4: `whats-new-entries.ts`**

Append (must be last, `version` must equal the new `__APP_VERSION__`):

```ts
  {
    version: "1.51.0",
    title: "Links Between Documents, and Safer Code Samples",
    description:
      "A plain markdown link to another document — [notes](Design Notes) or [api](docs/api.md) — now opens that document instead of a dead page. An unresolved one shows a clear “no such document” style. And [[wikilink]] syntax you type inside `code` or a fenced block is left exactly as written, in the preview and when a document is renamed.",
    screenshot: "/whats-new/preview-links.png",
    category: "Organization & Navigation",
  },
```

- [ ] **Step 5: Version bump**

`package.json` → `"version": "1.51.0"`. `package-lock.json` → both top-level `"version"` fields (lines ~3 and ~9). Hand-edit; don't regenerate.

- [ ] **Step 6: `ROADMAP.md`**

Under **Active → "Preview links & wikilinks"**: replace the G1/G2 bullets with a shipped note (`**Shipped v1.51.0** (PR #184)` + one line each on the fix), and add a **Deferred** line carrying the spec's Non-goals (`[[Name|alias]]`, bare-URL autolinking, cross-workspace `../`, indented code blocks, a broken-link lint panel).

- [ ] **Step 7: `docs/TEST-COVERAGE.md`**

Add rows: `markdown-code` helper (§2 or §3), `transformWikilinks`/`findBacklinks`/`rewriteWikilinkReferences`/`findWikilinkOccurrences` code-awareness (§3 Markdown dialects), `doc-link` classify/resolve + `renderLink` (§2 Preview), the `preview-links.spec.ts` e2e, and the Worker rename-in-code test (§10). Follow the table format; cite the spec.

- [ ] **Step 8: Format + final run**

```bash
npm run format
npm test && npm run typecheck && npm run build
```

- [ ] **Step 9: Commit + push**

```bash
git status   # src/worker.ts must NOT appear
git add CHANGELOG.md client/src/whats-new-entries.ts client/public/whats-new/preview-links.png package.json package-lock.json ROADMAP.md docs/TEST-COVERAGE.md tests/scripts/manual-testing/capture-preview-links-screenshot.mjs
git commit -m "$(cat <<'EOF'
chore: release 1.51.0 — inter-document links & code-safe wikilinks (G1/G2)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
git push origin docs/preview-links-spec
```

- [ ] **Step 10: Finalise the PR**

Rename PR #184 to `fix(preview): inter-document links & code-safe wikilinks (G1/G2) — v1.51.0`, update the body to describe the implementation (link the spec), confirm CI green. This is the whole feature in one PR — once green it's ready to merge (confirm with the user first).

---

## Self-review notes (addressed)

- **Spec coverage:**
  - §1 shared helper → Task 1 (+ Task 2 refactors `math-preview`).
  - §2 G2 four sites → Task 3 (`transformWikilinks`, `rewriteWikilinkReferences` ×2, `findWikilinkOccurrences`, `findBacklinks`).
  - §3 `doc-link.ts` → Task 4.
  - §4 `renderer.link` six outcomes → Task 5 (`renderLink`) + Task 6 (wiring).
  - §5 click handler → Task 6 Step 2.
  - §6 styling → no code needed (`.doc-ref-missing` carries `.wikilink-missing`; verified `.wikilink-missing` is a plain class rule, `_editor-preview.scss`, not `[data-doc-name]`-scoped). Noted here rather than a task step.
  - §7 DOMPurify `rel` → covered by the `preview-link-render` test asserting the `rel` attribute survives; if an e2e shows `rel` stripped by DOMPurify, add `"rel"` to `ADD_ATTR` in `Preview.svelte` (Task 6). Flagged in Task 6 Step 5.
  - Testing table → Tasks 1,3,4,5,6 tests + Task 7 e2e/coverage.
  - Rollout → Task 7.
- **Placeholder scan:** no "TBD"/"handle edge cases". Task 7 Step 2 leaves the exact next version number to a `git log` check (correct — depends on what merges first) but pins the format and content.
- **Type consistency:** `LinkHrefKind`, `RenderLinkDeps`, `{ from: number; to: number }` range shape, `renderLink(href, title, text, tokens, deps)` — identical across Tasks 4/5/6 and the spec. `renderDefault` signature `(href, title: string | null, text, tokens: unknown[]) => string` matches between `RenderLinkDeps` (Task 5) and the `Preview.svelte` adapter (Task 6).
- **Regression guard:** Task 2 keeps `math-preview.test.ts`; Task 3 Step 9 runs `npm test`; Task 6 Step 5 re-runs `slash-and-wikilinks` + `wikilink-rename-cascade` e2e.
- **`components` project:** not used — every new unit test is a pure function or jsdom. Avoids the known `Editor.svelte`/CodeMirror multi-instance mount failure.
