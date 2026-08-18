# GitHub-Style Diff View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Version History diff view (`DiffView.svelte`) line numbers, intraline (word-level) highlighting, and a Split/Unified layout toggle — matching GitHub's own diff UI.

**Architecture:** `diff-lines.ts` stays pure-function-first: `computeDiffRows` gains line-number tracking and intraline segment computation; a new `toUnifiedLines` function flattens rows into a single-column sequence for unified mode. `DiffView.svelte` renders both modes from the same `rows` data, switching layout via local component state. No other file changes — `VersionHistory.svelte`'s usage of `<DiffView before={...} after={...} />` is untouched.

**Tech Stack:** Svelte 5 (runes: `$props`, `$derived`, `$state`), the `diff` npm package (`diffLines`, `diffWordsWithSpace` — both already a dependency), Vitest.

**Spec:** `docs/superpowers/specs/2026-08-18-github-style-diff-view-design.md`

## Global Constraints

- Word-level intraline diffing (`diffWordsWithSpace`), not character-level — character-level fragments mid-word in prose.
- No collapsing of unchanged regions — every line always renders.
- No image rendering — out of scope, deferred to a follow-up spec.
- No changes to `VersionHistory.svelte`.
- Split/Unified toggle state is local to `DiffView.svelte` (`$state`), defaults to `"split"`, not persisted across remounts.
- No `@testing-library/svelte` or equivalent exists in this codebase — `DiffView.svelte`'s rendering is verified live in the browser, not with an automated component test. `diff-lines.ts`'s pure functions get full Vitest coverage.

---

### Task 1: Line numbers in `computeDiffRows`

**Files:**
- Modify: `client/src/diff-lines.ts`
- Test: `client/src/diff-lines.test.ts`

**Interfaces:**
- Produces: `DiffRow` gains `leftLine: number | null` and `rightLine: number | null` — `null` exactly when `leftText`/`rightText` (respectively) is `null`. `computeDiffRows(before: string, after: string): DiffRow[]` signature is unchanged.

- [ ] **Step 1: Update the existing tests to expect the new fields**

The five existing tests in `client/src/diff-lines.test.ts` use `toEqual` with exact object literals — they need `leftLine`/`rightLine` added to every row so they still compile against the type change coming in Step 3, and so their assertions stay exact. Replace the entire file's `describe("computeDiffRows", ...)` block with:

```ts
import { describe, it, expect } from "vitest";
import { computeDiffRows } from "./diff-lines";

describe("computeDiffRows", () => {
  it("returns all same rows for identical strings", () => {
    const rows = computeDiffRows("line1\nline2\n", "line1\nline2\n");
    expect(rows).toEqual([
      { leftText: "line1", rightText: "line1", leftLine: 1, rightLine: 1, type: "same" },
      { leftText: "line2", rightText: "line2", leftLine: 2, rightLine: 2, type: "same" },
    ]);
  });

  it("pairs a single replaced line onto one changed row", () => {
    const rows = computeDiffRows("a\nold\nb\n", "a\nnew\nb\n");
    expect(rows).toEqual([
      { leftText: "a", rightText: "a", leftLine: 1, rightLine: 1, type: "same" },
      { leftText: "old", rightText: "new", leftLine: 2, rightLine: 2, type: "changed" },
      { leftText: "b", rightText: "b", leftLine: 3, rightLine: 3, type: "same" },
    ]);
  });

  it("returns only same and added rows for an added-only change", () => {
    const rows = computeDiffRows("a\nb\n", "a\nb\nc\n");
    expect(rows).toEqual([
      { leftText: "a", rightText: "a", leftLine: 1, rightLine: 1, type: "same" },
      { leftText: "b", rightText: "b", leftLine: 2, rightLine: 2, type: "same" },
      { leftText: null, rightText: "c", leftLine: null, rightLine: 3, type: "added" },
    ]);
  });

  it("returns only same and removed rows for a removed-only change", () => {
    const rows = computeDiffRows("a\nb\nc\n", "a\nb\n");
    expect(rows).toEqual([
      { leftText: "a", rightText: "a", leftLine: 1, rightLine: 1, type: "same" },
      { leftText: "b", rightText: "b", leftLine: 2, rightLine: 2, type: "same" },
      { leftText: "c", rightText: null, leftLine: 3, rightLine: null, type: "removed" },
    ]);
  });

  it("pairs matching lines and puts surplus added lines on their own rows", () => {
    const rows = computeDiffRows("a\nold\nb\n", "a\nnew1\nnew2\nb\n");
    expect(rows).toEqual([
      { leftText: "a", rightText: "a", leftLine: 1, rightLine: 1, type: "same" },
      { leftText: "old", rightText: "new1", leftLine: 2, rightLine: 2, type: "changed" },
      { leftText: null, rightText: "new2", leftLine: null, rightLine: 3, type: "added" },
      { leftText: "b", rightText: "b", leftLine: 3, rightLine: 4, type: "same" },
    ]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run client/src/diff-lines.test.ts`
Expected: FAIL — every assertion missing `leftLine`/`rightLine` on the actual (pre-change) output.

- [ ] **Step 3: Add line-number tracking to `computeDiffRows`**

Replace `client/src/diff-lines.ts` in full with:

```ts
import { diffLines, type Change } from "diff";

export interface DiffRow {
  leftText: string | null; // null = blank counterpart cell (this row is add-only)
  rightText: string | null; // null = blank counterpart cell (this row is remove-only)
  leftLine: number | null; // 1-based line number in `before`, null exactly when leftText is null
  rightLine: number | null; // 1-based line number in `after`, null exactly when rightText is null
  type: "same" | "changed" | "removed" | "added";
}

function splitLines(value: string): string[] {
  const lines = value.split("\n");
  if (lines[lines.length - 1] === "") lines.pop(); // trailing split artifact from a final newline
  return lines;
}

// Pairs a removed run with an immediately-following added run (the shape
// diffLines produces for a same-position replacement) so replaced lines
// share one row instead of stacking as separate remove/add rows.
export function computeDiffRows(before: string, after: string): DiffRow[] {
  const changes: Change[] = diffLines(before, after);
  const rows: DiffRow[] = [];
  // Two independent running counters — each increments only when a row
  // actually consumes a line from that side, which handles same/changed/
  // removed/added rows uniformly with no special-casing.
  let leftLineNo = 1;
  let rightLineNo = 1;
  let i = 0;
  while (i < changes.length) {
    const change = changes[i]!;
    if (!change.added && !change.removed) {
      for (const text of splitLines(change.value)) {
        rows.push({ leftText: text, rightText: text, leftLine: leftLineNo++, rightLine: rightLineNo++, type: "same" });
      }
      i++;
      continue;
    }
    const next = changes[i + 1];
    const pairsWithNext = change.removed && next?.added;
    const removedLines = change.removed ? splitLines(change.value) : [];
    const addedLines = pairsWithNext ? splitLines(next!.value) : change.added ? splitLines(change.value) : [];
    const pairCount = Math.max(removedLines.length, addedLines.length);
    for (let j = 0; j < pairCount; j++) {
      const l = removedLines[j] ?? null;
      const r = addedLines[j] ?? null;
      rows.push({
        leftText: l,
        rightText: r,
        leftLine: l !== null ? leftLineNo++ : null,
        rightLine: r !== null ? rightLineNo++ : null,
        type: l !== null && r !== null ? "changed" : l !== null ? "removed" : "added",
      });
    }
    i += pairsWithNext ? 2 : 1;
  }
  return rows;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run client/src/diff-lines.test.ts`
Expected: PASS (5/5)

- [ ] **Step 5: Commit**

```bash
git add client/src/diff-lines.ts client/src/diff-lines.test.ts
git commit -m "feat: add per-side line numbers to diff rows"
```

---

### Task 2: Intraline (word-level) highlighting for changed rows

**Files:**
- Modify: `client/src/diff-lines.ts`
- Test: `client/src/diff-lines.test.ts`

**Interfaces:**
- Consumes: `DiffRow` from Task 1 (`leftLine`/`rightLine` already present).
- Produces: new `DiffSegment { text: string; changed: boolean }` type. `DiffRow` gains `leftSegments: DiffSegment[] | null` and `rightSegments: DiffSegment[] | null` — populated only for `"changed"` rows (both `leftText` and `rightText` non-null), `null` for `"same"`/`"removed"`/`"added"` rows.

- [ ] **Step 1: Write the failing tests**

Append to `client/src/diff-lines.test.ts` (after the existing `describe("computeDiffRows", ...)` block):

```ts
describe("computeDiffRows — intraline segments", () => {
  it("is null on same/removed/added rows", () => {
    const rows = computeDiffRows("a\nb\n", "a\nb\nc\n");
    for (const row of rows) {
      expect(row.leftSegments).toBeNull();
      expect(row.rightSegments).toBeNull();
    }
  });

  it("marks the single changed word within an otherwise-identical line", () => {
    const rows = computeDiffRows("a\nthe old cat\nb\n", "a\nthe new cat\nb\n");
    const changed = rows.find((r) => r.type === "changed")!;
    expect(changed.leftSegments).toEqual([
      { text: "the ", changed: false },
      { text: "old", changed: true },
      { text: " cat", changed: false },
    ]);
    expect(changed.rightSegments).toEqual([
      { text: "the ", changed: false },
      { text: "new", changed: true },
      { text: " cat", changed: false },
    ]);
  });

  it("marks every word as changed when a line shares no words with its replacement", () => {
    const rows = computeDiffRows("hello world\n", "goodbye moon\n");
    const changed = rows.find((r) => r.type === "changed")!;
    expect(changed.leftSegments).toEqual([
      { text: "hello", changed: true },
      { text: " ", changed: false },
      { text: "world", changed: true },
    ]);
    expect(changed.rightSegments).toEqual([
      { text: "goodbye", changed: true },
      { text: " ", changed: false },
      { text: "moon", changed: true },
    ]);
  });

  it("handles a multi-word change with an added trailing word", () => {
    const rows = computeDiffRows("quick brown fox\n", "quick red fox jumps\n");
    const changed = rows.find((r) => r.type === "changed")!;
    expect(changed.leftSegments).toEqual([
      { text: "quick ", changed: false },
      { text: "brown", changed: true },
      { text: " fox", changed: false },
    ]);
    expect(changed.rightSegments).toEqual([
      { text: "quick ", changed: false },
      { text: "red", changed: true },
      { text: " fox", changed: false },
      { text: " jumps", changed: true },
    ]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run client/src/diff-lines.test.ts`
Expected: FAIL — `leftSegments`/`rightSegments` don't exist on `DiffRow` yet (TypeScript compile error surfaces as a test failure under vitest).

- [ ] **Step 3: Add `DiffSegment`, `computeIntralineSegments`, and wire it into `computeDiffRows`**

In `client/src/diff-lines.ts`:

Change the import line:

```ts
import { diffLines, diffWordsWithSpace, type Change } from "diff";
```

Add the new type and extend `DiffRow` (insert right after the `DiffRow` interface's `rightLine` field):

```ts
export interface DiffSegment {
  text: string;
  changed: boolean;
}

export interface DiffRow {
  leftText: string | null;
  rightText: string | null;
  leftLine: number | null;
  rightLine: number | null;
  leftSegments: DiffSegment[] | null; // populated only when type is "changed"
  rightSegments: DiffSegment[] | null; // populated only when type is "changed"
  type: "same" | "changed" | "removed" | "added";
}
```

Add a new function after `splitLines`:

```ts
function computeIntralineSegments(left: string, right: string): { leftSegments: DiffSegment[]; rightSegments: DiffSegment[] } {
  const parts = diffWordsWithSpace(left, right);
  const leftSegments: DiffSegment[] = [];
  const rightSegments: DiffSegment[] = [];
  for (const part of parts) {
    if (part.added) {
      rightSegments.push({ text: part.value, changed: true });
    } else if (part.removed) {
      leftSegments.push({ text: part.value, changed: true });
    } else {
      leftSegments.push({ text: part.value, changed: false });
      rightSegments.push({ text: part.value, changed: false });
    }
  }
  return { leftSegments, rightSegments };
}
```

Update the two `rows.push(...)` call sites inside `computeDiffRows`. The "same" row push becomes:

```ts
rows.push({ leftText: text, rightText: text, leftLine: leftLineNo++, rightLine: rightLineNo++, leftSegments: null, rightSegments: null, type: "same" });
```

The pairing loop's push becomes:

```ts
for (let j = 0; j < pairCount; j++) {
  const l = removedLines[j] ?? null;
  const r = addedLines[j] ?? null;
  const isChanged = l !== null && r !== null;
  const segments = isChanged ? computeIntralineSegments(l, r) : null;
  rows.push({
    leftText: l,
    rightText: r,
    leftLine: l !== null ? leftLineNo++ : null,
    rightLine: r !== null ? rightLineNo++ : null,
    leftSegments: segments ? segments.leftSegments : null,
    rightSegments: segments ? segments.rightSegments : null,
    type: isChanged ? "changed" : l !== null ? "removed" : "added",
  });
}
```

- [ ] **Step 4: Run the tests and see the Task 1 tests newly fail**

Run: `npx vitest run client/src/diff-lines.test.ts`
Expected: the 4 new tests from Step 1 PASS, but the 5 tests from Task 1's `describe("computeDiffRows", ...)` block now FAIL — `toEqual` requires an exact object shape, and those literals don't mention `leftSegments`/`rightSegments` while the real rows now carry those keys (`null` on same/removed/added rows, real arrays on the one "changed" row each of two of those tests produces).

- [ ] **Step 5: Update Task 1's test literals with the new fields**

Replace the whole `describe("computeDiffRows", ...)` block (the one written in Task 1 — leave `describe("computeDiffRows — intraline segments", ...)` from Step 1 above untouched) with:

```ts
describe("computeDiffRows", () => {
  it("returns all same rows for identical strings", () => {
    const rows = computeDiffRows("line1\nline2\n", "line1\nline2\n");
    expect(rows).toEqual([
      { leftText: "line1", rightText: "line1", leftLine: 1, rightLine: 1, leftSegments: null, rightSegments: null, type: "same" },
      { leftText: "line2", rightText: "line2", leftLine: 2, rightLine: 2, leftSegments: null, rightSegments: null, type: "same" },
    ]);
  });

  it("pairs a single replaced line onto one changed row", () => {
    const rows = computeDiffRows("a\nold\nb\n", "a\nnew\nb\n");
    expect(rows).toEqual([
      { leftText: "a", rightText: "a", leftLine: 1, rightLine: 1, leftSegments: null, rightSegments: null, type: "same" },
      {
        leftText: "old",
        rightText: "new",
        leftLine: 2,
        rightLine: 2,
        leftSegments: [{ text: "old", changed: true }],
        rightSegments: [{ text: "new", changed: true }],
        type: "changed",
      },
      { leftText: "b", rightText: "b", leftLine: 3, rightLine: 3, leftSegments: null, rightSegments: null, type: "same" },
    ]);
  });

  it("returns only same and added rows for an added-only change", () => {
    const rows = computeDiffRows("a\nb\n", "a\nb\nc\n");
    expect(rows).toEqual([
      { leftText: "a", rightText: "a", leftLine: 1, rightLine: 1, leftSegments: null, rightSegments: null, type: "same" },
      { leftText: "b", rightText: "b", leftLine: 2, rightLine: 2, leftSegments: null, rightSegments: null, type: "same" },
      { leftText: null, rightText: "c", leftLine: null, rightLine: 3, leftSegments: null, rightSegments: null, type: "added" },
    ]);
  });

  it("returns only same and removed rows for a removed-only change", () => {
    const rows = computeDiffRows("a\nb\nc\n", "a\nb\n");
    expect(rows).toEqual([
      { leftText: "a", rightText: "a", leftLine: 1, rightLine: 1, leftSegments: null, rightSegments: null, type: "same" },
      { leftText: "b", rightText: "b", leftLine: 2, rightLine: 2, leftSegments: null, rightSegments: null, type: "same" },
      { leftText: "c", rightText: null, leftLine: 3, rightLine: null, leftSegments: null, rightSegments: null, type: "removed" },
    ]);
  });

  it("pairs matching lines and puts surplus added lines on their own rows", () => {
    const rows = computeDiffRows("a\nold\nb\n", "a\nnew1\nnew2\nb\n");
    expect(rows).toEqual([
      { leftText: "a", rightText: "a", leftLine: 1, rightLine: 1, leftSegments: null, rightSegments: null, type: "same" },
      {
        leftText: "old",
        rightText: "new1",
        leftLine: 2,
        rightLine: 2,
        leftSegments: [{ text: "old", changed: true }],
        rightSegments: [{ text: "new1", changed: true }],
        type: "changed",
      },
      { leftText: null, rightText: "new2", leftLine: null, rightLine: 3, leftSegments: null, rightSegments: null, type: "added" },
      { leftText: "b", rightText: "b", leftLine: 3, rightLine: 4, leftSegments: null, rightSegments: null, type: "same" },
    ]);
  });
});
```

- [ ] **Step 6: Run the tests to verify they all pass**

Run: `npx vitest run client/src/diff-lines.test.ts`
Expected: PASS (9/9)

- [ ] **Step 7: Commit**

```bash
git add client/src/diff-lines.ts client/src/diff-lines.test.ts
git commit -m "feat: add intraline word-level highlighting to changed diff rows"
```

---

### Task 3: `toUnifiedLines` — flatten rows for unified-mode rendering

**Files:**
- Modify: `client/src/diff-lines.ts`
- Test: `client/src/diff-lines.test.ts`

**Interfaces:**
- Consumes: `DiffRow` from Tasks 1-2 (full shape: `leftText`, `rightText`, `leftLine`, `rightLine`, `leftSegments`, `rightSegments`, `type`).
- Produces: `UnifiedLineType = "same" | "removed" | "added"`, `UnifiedLine { text: string; segments: DiffSegment[] | null; type: UnifiedLineType; leftLine: number | null; rightLine: number | null }`, and `toUnifiedLines(rows: DiffRow[]): UnifiedLine[]`.

- [ ] **Step 1: Write the failing tests**

Append to `client/src/diff-lines.test.ts`:

```ts
import { toUnifiedLines } from "./diff-lines";

describe("toUnifiedLines", () => {
  it("maps same/removed/added rows 1:1", () => {
    const lines = toUnifiedLines([
      { leftText: "a", rightText: "a", leftLine: 1, rightLine: 1, leftSegments: null, rightSegments: null, type: "same" },
      { leftText: "old", rightText: null, leftLine: 2, rightLine: null, leftSegments: null, rightSegments: null, type: "removed" },
      { leftText: null, rightText: "new", leftLine: null, rightLine: 2, leftSegments: null, rightSegments: null, type: "added" },
    ]);
    expect(lines).toEqual([
      { text: "a", segments: null, type: "same", leftLine: 1, rightLine: 1 },
      { text: "old", segments: null, type: "removed", leftLine: 2, rightLine: null },
      { text: "new", segments: null, type: "added", leftLine: null, rightLine: 2 },
    ]);
  });

  it("expands a changed row into a removed line then an added line, carrying segments", () => {
    const leftSegments = [
      { text: "the ", changed: false },
      { text: "old", changed: true },
      { text: " cat", changed: false },
    ];
    const rightSegments = [
      { text: "the ", changed: false },
      { text: "new", changed: true },
      { text: " cat", changed: false },
    ];
    const lines = toUnifiedLines([
      { leftText: "the old cat", rightText: "the new cat", leftLine: 5, rightLine: 5, leftSegments, rightSegments, type: "changed" },
    ]);
    expect(lines).toEqual([
      { text: "the old cat", segments: leftSegments, type: "removed", leftLine: 5, rightLine: null },
      { text: "the new cat", segments: rightSegments, type: "added", leftLine: null, rightLine: 5 },
    ]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run client/src/diff-lines.test.ts`
Expected: FAIL — `toUnifiedLines` is not exported yet.

- [ ] **Step 3: Implement `toUnifiedLines`**

Append to `client/src/diff-lines.ts`:

```ts
export type UnifiedLineType = "same" | "removed" | "added";

export interface UnifiedLine {
  text: string;
  segments: DiffSegment[] | null;
  type: UnifiedLineType;
  leftLine: number | null;
  rightLine: number | null;
}

// Flattens the two-column row list into a single-column sequence for
// unified-mode rendering — a "changed" row (one line replaced by
// another) expands into two stacked lines, removed first then added,
// matching git/GitHub's own unified diff convention. Segments carry
// straight through so intraline highlighting looks identical to split
// mode, just split across two lines instead of two side-by-side cells.
export function toUnifiedLines(rows: DiffRow[]): UnifiedLine[] {
  const lines: UnifiedLine[] = [];
  for (const row of rows) {
    if (row.type === "same") {
      lines.push({ text: row.leftText ?? "", segments: row.leftSegments, type: "same", leftLine: row.leftLine, rightLine: row.rightLine });
    } else if (row.type === "removed") {
      lines.push({ text: row.leftText ?? "", segments: row.leftSegments, type: "removed", leftLine: row.leftLine, rightLine: null });
    } else if (row.type === "added") {
      lines.push({ text: row.rightText ?? "", segments: row.rightSegments, type: "added", leftLine: null, rightLine: row.rightLine });
    } else {
      lines.push({ text: row.leftText ?? "", segments: row.leftSegments, type: "removed", leftLine: row.leftLine, rightLine: null });
      lines.push({ text: row.rightText ?? "", segments: row.rightSegments, type: "added", leftLine: null, rightLine: row.rightLine });
    }
  }
  return lines;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run client/src/diff-lines.test.ts`
Expected: PASS (all tests in the file)

- [ ] **Step 5: Commit**

```bash
git add client/src/diff-lines.ts client/src/diff-lines.test.ts
git commit -m "feat: add toUnifiedLines for unified-mode diff rendering"
```

---

### Task 4: `DiffView.svelte` — line-number gutters and intraline highlighting (split mode)

**Files:**
- Modify: `client/src/components/DiffView.svelte`
- Modify: `client/src/style.css:1212-1218`

**Interfaces:**
- Consumes: `computeDiffRows` and the full `DiffRow` shape from Tasks 1-2.

- [ ] **Step 1: Replace `DiffView.svelte`'s template to render gutters and segments**

Replace `client/src/components/DiffView.svelte` in full with:

```svelte
<script lang="ts">
  import { computeDiffRows } from "../diff-lines";

  interface Props {
    before: string;
    after: string;
  }
  const { before, after }: Props = $props();

  const rows = $derived(computeDiffRows(before, after));
</script>

<div class="diff-view">
  {#each rows as row, i (i)}
    <div class="diff-view-row">
      <div class="diff-view-gutter">{row.leftLine ?? ""}</div>
      <div class="diff-view-cell" class:diff-removed={row.type === "changed" || row.type === "removed"}>
        {#if row.leftSegments}
          {#each row.leftSegments as seg, j (j)}<span class:diff-segment-changed={seg.changed}>{seg.text}</span>{/each}
        {:else}
          {row.leftText ?? ""}
        {/if}
      </div>
      <div class="diff-view-gutter">{row.rightLine ?? ""}</div>
      <div class="diff-view-cell" class:diff-added={row.type === "changed" || row.type === "added"}>
        {#if row.rightSegments}
          {#each row.rightSegments as seg, j (j)}<span class:diff-segment-changed={seg.changed}>{seg.text}</span>{/each}
        {:else}
          {row.rightText ?? ""}
        {/if}
      </div>
    </div>
  {/each}
</div>
```

- [ ] **Step 2: Replace the diff-view CSS block**

In `client/src/style.css`, replace the existing block at lines 1212-1218:

```css
.diff-view { font-family: var(--mono); font-size: 12.5px; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
.diff-view-row { display: grid; grid-template-columns: 1fr 1fr; }
.diff-view-cell { padding: 2px 8px; white-space: pre-wrap; word-break: break-word; border-bottom: 1px solid var(--border); }
.diff-view-cell:first-child { border-right: 1px solid var(--border); }
.diff-view-row:last-child .diff-view-cell { border-bottom: none; }
.diff-view-cell.diff-removed { background: rgba(220, 38, 38, 0.12); }
.diff-view-cell.diff-added { background: rgba(34, 197, 94, 0.14); }
```

with:

```css
.diff-view { font-family: var(--mono); font-size: 12.5px; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
.diff-view-row { display: grid; grid-template-columns: auto 1fr auto 1fr; }
.diff-view-gutter { padding: 2px 8px; text-align: right; color: var(--text-dim); user-select: none; border-bottom: 1px solid var(--border); border-right: 1px solid var(--border); }
.diff-view-cell { padding: 2px 8px; white-space: pre-wrap; word-break: break-word; border-bottom: 1px solid var(--border); }
.diff-view-cell:nth-child(2) { border-right: 1px solid var(--border); }
.diff-view-row:last-child .diff-view-gutter,
.diff-view-row:last-child .diff-view-cell { border-bottom: none; }
.diff-view-cell.diff-removed { background: rgba(220, 38, 38, 0.12); }
.diff-view-cell.diff-added { background: rgba(34, 197, 94, 0.14); }
.diff-view-cell.diff-removed .diff-segment-changed { background: rgba(220, 38, 38, 0.32); }
.diff-view-cell.diff-added .diff-segment-changed { background: rgba(34, 197, 94, 0.34); }
```

- [ ] **Step 3: Run the full test suite (confirm nothing else broke)**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 4: Verify live in the browser**

Run: `npm run dev:client` (or the project's usual dev server command). Open a document with local version history (edit it a few times, at least 5 minutes apart, or use the version-restore flow to force a snapshot), open File > Version History, switch to the Diff tab, and select an older version. Confirm:
- Line numbers appear on both sides, incrementing correctly (added-only lines leave the counterpart gutter blank).
- A changed line shows only the actually-different word(s) with a darker highlight, not the whole line.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/DiffView.svelte client/src/style.css
git commit -m "feat: add line numbers and intraline highlighting to the diff view"
```

---

### Task 5: `DiffView.svelte` — Unified mode and Split/Unified toggle

**Files:**
- Modify: `client/src/components/DiffView.svelte`
- Modify: `client/src/style.css`

**Interfaces:**
- Consumes: `toUnifiedLines` and `UnifiedLine` from Task 3, the Task 4 split-mode markup and CSS.

- [ ] **Step 1: Add the toggle and unified-mode branch to `DiffView.svelte`**

Replace `client/src/components/DiffView.svelte` in full with:

```svelte
<script lang="ts">
  import { computeDiffRows, toUnifiedLines } from "../diff-lines";

  interface Props {
    before: string;
    after: string;
  }
  const { before, after }: Props = $props();

  const rows = $derived(computeDiffRows(before, after));
  const unifiedLines = $derived(toUnifiedLines(rows));

  let mode = $state<"split" | "unified">("split");
</script>

<div class="diff-view-mode-toggle">
  <button type="button" class:active={mode === "split"} onclick={() => (mode = "split")}>Split</button>
  <button type="button" class:active={mode === "unified"} onclick={() => (mode = "unified")}>Unified</button>
</div>

{#if mode === "split"}
  <div class="diff-view">
    {#each rows as row, i (i)}
      <div class="diff-view-row">
        <div class="diff-view-gutter">{row.leftLine ?? ""}</div>
        <div class="diff-view-cell" class:diff-removed={row.type === "changed" || row.type === "removed"}>
          {#if row.leftSegments}
            {#each row.leftSegments as seg, j (j)}<span class:diff-segment-changed={seg.changed}>{seg.text}</span>{/each}
          {:else}
            {row.leftText ?? ""}
          {/if}
        </div>
        <div class="diff-view-gutter">{row.rightLine ?? ""}</div>
        <div class="diff-view-cell" class:diff-added={row.type === "changed" || row.type === "added"}>
          {#if row.rightSegments}
            {#each row.rightSegments as seg, j (j)}<span class:diff-segment-changed={seg.changed}>{seg.text}</span>{/each}
          {:else}
            {row.rightText ?? ""}
          {/if}
        </div>
      </div>
    {/each}
  </div>
{:else}
  <div class="diff-view diff-view-unified">
    {#each unifiedLines as line, i (i)}
      <div class="diff-view-row">
        <div class="diff-view-gutter">{line.leftLine ?? ""}</div>
        <div class="diff-view-gutter">{line.rightLine ?? ""}</div>
        <div class="diff-view-cell" class:diff-removed={line.type === "removed"} class:diff-added={line.type === "added"}>
          {#if line.segments}
            {#each line.segments as seg, j (j)}<span class:diff-segment-changed={seg.changed}>{seg.text}</span>{/each}
          {:else}
            {line.text}
          {/if}
        </div>
      </div>
    {/each}
  </div>
{/if}
```

- [ ] **Step 2: Add toggle and unified-mode CSS**

In `client/src/style.css`, append after the `.diff-view*` block edited in Task 4:

```css
.diff-view-mode-toggle { display: flex; gap: 4px; margin-bottom: 8px; }
.diff-view-mode-toggle button {
  border: none;
  background: var(--bg-alt);
  border-radius: 6px;
  padding: 4px 10px;
  font-size: 12.5px;
  cursor: pointer;
  color: var(--text-dim);
  font-family: inherit;
}
.diff-view-mode-toggle button.active { background: var(--accent-dim); color: var(--accent); }
.diff-view-unified .diff-view-row { grid-template-columns: auto auto 1fr; }
```

- [ ] **Step 3: Run the full test suite**

Run: `npm test`
Expected: all tests pass (this task has no new pure-logic tests — `toUnifiedLines` is already covered in Task 3 — this is a rendering-only change).

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit -p client/tsconfig.json`
Expected: no errors.

- [ ] **Step 5: Verify live in the browser**

With the dev server running (from Task 4's Step 4), open the same diff view and:
- Confirm the Split/Unified toggle renders above the diff, with Split active by default.
- Click Unified — confirm a changed line now shows as two stacked lines (a removed line, then an added line directly below it), each with only one gutter populated (old-line# on the removed line, new-line# on the added line), and the same intraline highlighting as split mode.
- Click back to Split — confirm it returns to the two-column layout correctly.
- Test with a repo-commit diff too (not just a local snapshot diff), since `before`/`after` come from a different source there — confirm both modes render correctly.

- [ ] **Step 6: Commit**

```bash
git add client/src/components/DiffView.svelte client/src/style.css
git commit -m "feat: add Split/Unified toggle to the diff view"
```

---

## Self-Review Notes

**Spec coverage:** Intraline segments (Task 2) ✓. Line numbers (Task 1) ✓. Unified-mode flattening (Task 3) ✓. Split-mode gutters + segments rendering (Task 4) ✓. Unified rendering + toggle (Task 5) ✓. Styling for gutters/segments/toggle (Tasks 4-5) ✓. No image rendering, no unchanged-region collapsing, no `VersionHistory.svelte` changes — none of the tasks touch these, matching the spec's explicit exclusions.

**Type consistency:** `DiffRow`, `DiffSegment`, `UnifiedLine`, `UnifiedLineType`, `computeDiffRows`, `computeIntralineSegments`, `toUnifiedLines` are named and shaped identically everywhere they're referenced across Tasks 1-5.

**Placeholder scan:** No TBD/TODO; every step carries complete, exact code. Task 2's Step 4 spells out precisely which existing test literals need updating and why (the `toEqual` exact-shape requirement), rather than leaving it as a vague "update the tests."
