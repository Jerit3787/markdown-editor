# Suggestion Line-Grouping (D4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse several small pending suggestions on one source line into a single annotation-rail card with a row per sub-edit, keeping per-sub-edit and whole-group accept/reject.

**Architecture:** A new pure pass, `groupSuggestionCards`, runs on the output of `annotations.ts`'s existing replace-pair detection: cards on the same source line, same author, none carrying a reply thread, are merged into one `RailAnnotation` with a `subEdits[]` array. `AnnotationCard.svelte` gains a `{#if annotation.subEdits}` branch (row list + group actions); `AnnotationRail.svelte` passes a new `onSubEdit` handler that resolves one row's entry ids. No CRDT, schema, server, or `suggestion-editor.ts` change.

**Tech Stack:** TypeScript, Svelte 5 (runes), Vitest (`unit` = node/jsdom for pure logic; `components` = real headless Chromium via `vitest-browser-svelte`), Playwright (`e2e-collab`).

**Spec:** `docs/superpowers/specs/2026-09-11-suggestion-line-grouping-design.md`

## Global Constraints

- Display layer only. Do NOT touch `client/src/suggestion-editor.ts`, `src/`/server code, `reviewer-integrity.ts`, or the `SuggestionEntry` / `ResolvedSuggestion` schema.
- Do NOT modify the existing replace-pair detection in `suggestionCards` — a replace-pair card is an indivisible group *member*.
- Grouping unit is the **source line** (delimited by `\n`), never a proximity gap or across lines.
- A suggestion whose `replies` array is non-empty is **never** grouped (renders standalone). Comment threads are never grouped.
- `underlyingIds(a)` stays `a.groupedIds ?? [a.id]` — unchanged; a group has `groupedIds` so it already returns the flat entry-id list.
- Minimum 2 groupable members to form a group; a run of 1 passes through byte-identical.
- Visible card-layout change → **minor** version bump + `CHANGELOG.md` `### Changed` + a `client/src/whats-new-entries.ts` entry (category `"Collaboration"`) **with a real captured screenshot** in `client/public/whats-new/`. Version bump is the **last step before the PR** (`package.json` + both `package-lock.json` `"version"` fields, lines ~3 and ~9, hand-edited).
- Commit trailer: `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`. PR body ends `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. Never add a `Claude-Session:` link.
- Branch `feat/suggestion-line-grouping` already exists off `master` with the spec committed.
- Full verification before the PR: `npm test`, `npx vitest run --project=components`, `npm run typecheck`, `npm run build`, `npm run format:check`, `npm run check:no-dev-login`.

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `client/src/suggestion-group.ts` | Create | `groupSuggestionCards(cards, content)` — the pure line-grouping pass + `lineRange` helper. |
| `client/src/annotations.ts` | Modify | Add `subEdits?` to `RailAnnotation`; call `groupSuggestionCards` at the end of `suggestionCards`. |
| `tests/client/src/suggestion-group.test.ts` | Create | Unit tests for `groupSuggestionCards`. |
| `tests/client/src/annotations.test.ts` | Modify | End-to-end grouping through `railAnnotationsForShared` from real suggestion entries. |
| `client/src/components/AnnotationCard.svelte` | Modify | `{#if annotation.subEdits}` branch: row list + Accept all / Reject all / Withdraw all; new `onSubEdit` prop. |
| `client/src/styles/_annotations.scss` | Modify | `.annotation-card-subedit` row styling. |
| `client/src/components/AnnotationRail.svelte` | Modify | `resolveSubEdit(ids, outcome)`; pass it as `onSubEdit`. |
| `tests/client/src/components/AnnotationCard.test.ts` | Modify | Grouped-card render + button behaviour + `onSubEdit` fires. |
| `tests/e2e/collab/suggestion-mode.spec.ts` | Modify | One e2e-collab: two edits on a line → one grouped card, Accept all resolves both. |
| `CHANGELOG.md`, `client/src/whats-new-entries.ts`, `client/public/whats-new/suggestion-line-grouping.png`, `ROADMAP.md`, `docs/TEST-COVERAGE.md`, `package.json`, `package-lock.json` | Modify | Release. |

---

## Task 1: `groupSuggestionCards` — the pure grouping pass

**Files:**
- Create: `client/src/suggestion-group.ts`
- Modify: `client/src/annotations.ts`
- Test: `tests/client/src/suggestion-group.test.ts`

**Interfaces:**
- Consumes: `RailAnnotation` (from `./annotations`), `underlyingIds` (from `./annotations`).
- Produces:
  - `RailAnnotation.subEdits?: { ids: string[]; kind: "insert" | "delete" | "replace"; changeText: string; replacedText?: string; from: number; to: number }[]`
  - `lineRange(content: string, index: number): [number, number]` — `[start, end)` of the line containing `index`.
  - `groupSuggestionCards(cards: RailAnnotation[], content: string): RailAnnotation[]` — merges consecutive same-line/same-author/thread-less suggestion cards (runs of ≥ 2) into one group card each; everything else passes through unchanged, order preserved.

- [ ] **Step 1: Write the failing tests**

Create `tests/client/src/suggestion-group.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { groupSuggestionCards, lineRange } from "../../../client/src/suggestion-group";
import type { RailAnnotation } from "../../../client/src/annotations";

function sug(over: Partial<RailAnnotation>): RailAnnotation {
  return {
    id: over.id ?? "s",
    kind: "suggestion",
    author: over.author ?? "alice",
    createdAt: over.createdAt ?? 1,
    anchorFrom: over.anchorFrom ?? 0,
    anchorTo: over.anchorTo ?? 1,
    changeKind: over.changeKind ?? "insert",
    changeText: over.changeText ?? "x",
    ...over,
  };
}

// content lines:  "line one here\n" (0..13,\n at 13)  "and line two" (14..25)
const CONTENT = "line one here\nand line two";

describe("lineRange", () => {
  it("returns [start,end) of the line containing the index", () => {
    expect(lineRange(CONTENT, 0)).toEqual([0, 13]);
    expect(lineRange(CONTENT, 13)).toEqual([0, 13]); // the \n position belongs to line 1's end
    expect(lineRange(CONTENT, 14)).toEqual([14, 25]);
    expect(lineRange(CONTENT, 25)).toEqual([14, 25]);
  });
});

describe("groupSuggestionCards", () => {
  it("groups two same-line, same-author, thread-less suggestions into one card", () => {
    const cards = [
      sug({ id: "a", anchorFrom: 2, anchorTo: 3, changeText: "A" }),
      sug({ id: "b", anchorFrom: 8, anchorTo: 9, changeText: "B" }),
    ];
    const out = groupSuggestionCards(cards, CONTENT);
    expect(out).toHaveLength(1);
    expect(out[0]!.subEdits).toHaveLength(2);
    expect(out[0]!.groupedIds).toEqual(["a", "b"]);
    expect(out[0]!.anchorFrom).toBe(2);
    expect(out[0]!.anchorTo).toBe(9);
    expect(out[0]!.subEdits!.map((s) => s.changeText)).toEqual(["A", "B"]);
  });

  it("keeps a replace-pair member as one 'replace' sub-edit and flattens its ids", () => {
    const cards = [
      sug({ id: "d1+i1", anchorFrom: 1, anchorTo: 5, changeText: "new", replacedText: "old", groupedIds: ["d1", "i1"], changeKind: undefined }),
      sug({ id: "b", anchorFrom: 9, anchorTo: 10, changeText: "B" }),
    ];
    const out = groupSuggestionCards(cards, CONTENT);
    expect(out).toHaveLength(1);
    expect(out[0]!.subEdits![0]).toMatchObject({ kind: "replace", changeText: "new", replacedText: "old", ids: ["d1", "i1"] });
    expect(out[0]!.groupedIds).toEqual(["d1", "i1", "b"]);
  });

  it("does not group across different lines", () => {
    const cards = [sug({ id: "a", anchorFrom: 2 }), sug({ id: "b", anchorFrom: 16 })];
    expect(groupSuggestionCards(cards, CONTENT)).toHaveLength(2);
  });

  it("does not group different authors on one line", () => {
    const cards = [sug({ id: "a", anchorFrom: 2, author: "alice" }), sug({ id: "b", anchorFrom: 8, author: "bob" })];
    expect(groupSuggestionCards(cards, CONTENT)).toHaveLength(2);
  });

  it("does not group a suggestion that carries a reply thread", () => {
    const cards = [
      sug({ id: "a", anchorFrom: 2, replies: [{ id: "r", author: "alice", body: "hm", createdAt: 1 }] }),
      sug({ id: "b", anchorFrom: 8 }),
    ];
    const out = groupSuggestionCards(cards, CONTENT);
    expect(out).toHaveLength(2);
    expect(out.every((c) => !c.subEdits)).toBe(true);
  });

  it("returns a single-on-a-line card unchanged (identity)", () => {
    const one = [sug({ id: "a", anchorFrom: 2 })];
    const out = groupSuggestionCards(one, CONTENT);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(one[0]);
  });

  it("leaves comment cards alone", () => {
    const cards: RailAnnotation[] = [
      { id: "t1", kind: "comment", author: "z", createdAt: 1, anchorFrom: 2, anchorTo: 3, quote: "li" },
      sug({ id: "a", anchorFrom: 5 }),
      sug({ id: "b", anchorFrom: 9 }),
    ];
    const out = groupSuggestionCards(cards, CONTENT);
    expect(out.filter((c) => c.kind === "comment")).toHaveLength(1);
    expect(out.filter((c) => c.subEdits)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/client/src/suggestion-group.test.ts`
Expected: FAIL — module `../../../client/src/suggestion-group` not found.

- [ ] **Step 3: Add `subEdits` to `RailAnnotation`**

In `client/src/annotations.ts`, inside `interface RailAnnotation`, after `groupedIds?: string[];`:

```ts
  // D4 line-grouping — present only on a group card. One row per merged
  // suggestion, document order. `ids` is that member's underlying entry
  // ids (a replace-pair contributes both).
  subEdits?: {
    ids: string[];
    kind: "insert" | "delete" | "replace";
    changeText: string;
    replacedText?: string;
    from: number;
    to: number;
  }[];
```

- [ ] **Step 4: Create `client/src/suggestion-group.ts`**

```ts
import { underlyingIds, type RailAnnotation } from "./annotations";

// [start, end) of the source line (\n-delimited) containing `index`.
export function lineRange(content: string, index: number): [number, number] {
  const start = content.lastIndexOf("\n", index - 1) + 1;
  const nl = content.indexOf("\n", index);
  return [start, nl === -1 ? content.length : nl];
}

// Merge consecutive suggestion cards that sit on the same source line,
// share an author, and carry no reply thread — a run of >= 2 becomes one
// group card with a `subEdits` row per member. Runs on the output of
// annotations.ts's replace-pair pass, so a replace-pair is one member.
// Comment cards and lone suggestions pass through by reference.
export function groupSuggestionCards(cards: RailAnnotation[], content: string): RailAnnotation[] {
  const out: RailAnnotation[] = [];
  let i = 0;
  while (i < cards.length) {
    const card = cards[i]!;
    const groupable = (c: RailAnnotation) => c.kind === "suggestion" && (c.replies?.length ?? 0) === 0;
    if (!groupable(card)) {
      out.push(card);
      i++;
      continue;
    }
    const [lineFrom, lineTo] = lineRange(content, card.anchorFrom);
    const run: RailAnnotation[] = [card];
    let j = i + 1;
    while (j < cards.length) {
      const next = cards[j]!;
      if (!groupable(next) || next.author !== card.author) break;
      if (next.anchorFrom < lineFrom || next.anchorFrom >= lineTo) break;
      run.push(next);
      j++;
    }
    if (run.length < 2) {
      out.push(card);
      i++;
      continue;
    }
    out.push({
      id: run.map((m) => m.id).join("+"),
      kind: "suggestion",
      author: card.author,
      authorName: card.authorName,
      createdAt: Math.min(...run.map((m) => m.createdAt)),
      anchorFrom: Math.min(...run.map((m) => m.anchorFrom)),
      anchorTo: Math.max(...run.map((m) => m.anchorTo)),
      groupedIds: run.flatMap((m) => underlyingIds(m)),
      subEdits: run.map((m) => ({
        ids: underlyingIds(m),
        kind: m.replacedText != null ? "replace" : (m.changeKind ?? "insert"),
        changeText: m.changeText ?? "",
        replacedText: m.replacedText,
        from: m.anchorFrom,
        to: m.anchorTo,
      })),
    });
    i = j;
  }
  return out;
}
```

> Note: `cards` reaching here is already sorted by `from` (both `suggestionCards`'s own sort and the replace-pair pass preserve that), so a same-line run is contiguous.

- [ ] **Step 5: Wire it into `suggestionCards`**

In `client/src/annotations.ts`, add the import at the top:

```ts
import { groupSuggestionCards } from "./suggestion-group";
```

At the end of `suggestionCards`, change:

```ts
  return out;
}
```

to:

```ts
  return groupSuggestionCards(out, content);
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run tests/client/src/suggestion-group.test.ts`
Expected: PASS (all 9).

- [ ] **Step 7: Run the existing annotations tests + typecheck**

Run: `npx vitest run tests/client/src/annotations.test.ts` — the existing suggestion-card tests must still pass (each uses a single suggestion, so grouping is a no-op — a run of 1 passes through by reference).
Run: `npm run typecheck` — clean (`RailAnnotation.subEdits` optional, `groupSuggestionCards` typed).

- [ ] **Step 8: Add an end-to-end grouping test to `annotations.test.ts`**

Append to `tests/client/src/annotations.test.ts` (it imports `recordInsertSuggestion`, `listResolvedSuggestions`, `railAnnotationsForShared`, and has a `docWith` helper):

```ts
describe("railAnnotationsForShared — line grouping (D4)", () => {
  it("groups two inserts on one line into a single card with two sub-edits", () => {
    const doc = docWith("the quick brown fox");
    recordInsertSuggestion(doc, 4, 9, "alice"); // "quick"
    recordInsertSuggestion(doc, 16, 19, "alice"); // "fox" — same line, contiguous-extend won't merge (gap)
    const cards = railAnnotationsForShared(listResolvedSuggestions(doc), [], "the quick brown fox");
    expect(cards).toHaveLength(1);
    expect(cards[0]!.subEdits).toHaveLength(2);
  });

  it("keeps a comment on the same line as its own card", () => {
    const doc = docWith("the quick brown fox");
    recordInsertSuggestion(doc, 4, 9, "alice");
    recordInsertSuggestion(doc, 16, 19, "alice");
    const thread = { id: "t1", author: "bob", createdAt: 1, from: 0, to: 3, quote: "the", resolved: false, replies: [{ id: "r1", author: "bob", body: "hi", createdAt: 1 }] };
    const cards = railAnnotationsForShared(listResolvedSuggestions(doc), [thread], "the quick brown fox");
    expect(cards.filter((c) => c.kind === "comment")).toHaveLength(1);
    expect(cards.filter((c) => c.subEdits)).toHaveLength(1);
  });
});
```

> If `recordInsertSuggestion` at 4..9 and 16..19 gets collapsed by the self-heal, split them further apart or use one insert + one `recordDeleteSuggestion` on the same line — the assertion (one grouped card, 2 sub-edits) is the fixed part.

- [ ] **Step 9: Run + commit**

Run: `npx vitest run tests/client/src/suggestion-group.test.ts tests/client/src/annotations.test.ts` → PASS.

```bash
git add client/src/suggestion-group.ts client/src/annotations.ts tests/client/src/suggestion-group.test.ts tests/client/src/annotations.test.ts
git commit -m "feat: group same-line pending suggestions into one rail card

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 2: The grouped card + rail wiring

**Files:**
- Modify: `client/src/components/AnnotationCard.svelte`
- Modify: `client/src/styles/_annotations.scss`
- Modify: `client/src/components/AnnotationRail.svelte`
- Test: `tests/client/src/components/AnnotationCard.test.ts`

**Interfaces:**
- Consumes from Task 1: `RailAnnotation.subEdits`.
- Produces:
  - `AnnotationCard` new prop `onSubEdit?: (ids: string[], outcome: "accept" | "reject") => void`.
  - Grouped card DOM: `.annotation-card-subedit` rows; footer buttons `data-act="accept"|"reject"|"withdraw"` (whole-group) and per-row `data-act="accept"|"reject"` with `data-sub="<row index>"`.
  - `AnnotationRail` `resolveSubEdit(ids: string[], outcome: "accept" | "reject"): void`.

- [ ] **Step 1: Write the failing component tests**

Add to `tests/client/src/components/AnnotationCard.test.ts` (imports `render` from `vitest-browser-svelte`, `RailAnnotation`, `vi`):

```ts
const groupSug: RailAnnotation = {
  id: "a+b",
  kind: "suggestion",
  author: "alice",
  createdAt: 0,
  anchorFrom: 2,
  anchorTo: 9,
  groupedIds: ["a", "b"],
  subEdits: [
    { ids: ["a"], kind: "replace", changeText: "the", replacedText: "teh", from: 2, to: 5 },
    { ids: ["b"], kind: "insert", changeText: " really", from: 8, to: 15 },
  ],
};

test("a grouped suggestion card renders one row per sub-edit with a change count", async () => {
  const screen = await render(AnnotationCard, { annotation: groupSug, viewer: { role: "editor", name: "carol" } });
  await expect.element(screen.getByText(/2 changes/i)).toBeInTheDocument();
  expect(screen.container.querySelectorAll(".annotation-card-subedit")).toHaveLength(2);
  await expect.element(screen.getByText("teh")).toBeInTheDocument();
  await expect.element(screen.getByText("really")).toBeInTheDocument();
});

test("an editor gets per-row accept/reject and Accept all / Reject all on a group", async () => {
  const onSubEdit = vi.fn();
  const onAccept = vi.fn();
  const screen = await render(AnnotationCard, { annotation: groupSug, viewer: { role: "editor", name: "carol" }, onSubEdit, onAccept });
  expect(screen.container.querySelectorAll('.annotation-card-subedit button[data-act="accept"]')).toHaveLength(2);
  await screen.container.querySelector('.annotation-card-subedit button[data-act="reject"][data-sub="1"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  expect(onSubEdit).toHaveBeenCalledWith(["b"], "reject");
  await screen.getByRole("button", { name: /accept all/i }).click();
  expect(onAccept).toHaveBeenCalledOnce();
});

test("the author sees Withdraw all on a group, no per-row buttons", async () => {
  const screen = await render(AnnotationCard, { annotation: groupSug, viewer: { role: "reviewer", name: "alice" } });
  await expect.element(screen.getByRole("button", { name: /withdraw all/i })).toBeInTheDocument();
  expect(screen.container.querySelector('.annotation-card-subedit button')).toBeNull();
});

test("a third-party reviewer sees the group rows but no action buttons", async () => {
  const screen = await render(AnnotationCard, { annotation: groupSug, viewer: { role: "reviewer", name: "dave" } });
  expect(screen.container.querySelectorAll(".annotation-card-subedit")).toHaveLength(2);
  expect(screen.container.querySelector(".annotation-card-actions")).toBeNull();
});
```

- [ ] **Step 2: Run — verify they fail**

Run: `npx vitest run --project=components tests/client/src/components/AnnotationCard.test.ts`
Expected: FAIL on the new 4 (no `.annotation-card-subedit`, no "2 changes" text).

- [ ] **Step 3: `AnnotationCard.svelte` — script**

Add `onSubEdit` to the props destructure and its type:

```ts
    onSubEdit,
```
```ts
    onSubEdit?: (ids: string[], outcome: "accept" | "reject") => void;
```

Add a derived flag after `label`:

```ts
  const isGroup = $derived(!!annotation.subEdits);
```

- [ ] **Step 4: `AnnotationCard.svelte` — template**

Replace the suggestion `.annotation-card-change` block (currently `{#if annotation.replacedText != null} … {:else if …} … {:else} … {/if}` inside `{#if isSuggestion}`) so it handles the group case first:

```svelte
      {#if isSuggestion && isGroup}
        <span class="annotation-card-change">{annotation.subEdits!.length} changes</span>
      {:else if isSuggestion}
        <span class="annotation-card-change">
          {#if annotation.replacedText != null}
            Replace <del>{annotation.replacedText}</del> → <ins>{annotation.changeText}</ins>
          {:else if annotation.changeKind === "insert"}
            Add <ins>{annotation.changeText}</ins>
          {:else}
            Remove <del>{annotation.changeText}</del>
          {/if}
        </span>
      {:else}
        <button type="button" class="annotation-card-quote" onclick={() => onJump?.()}>
          "{annotation.quote}"{#if annotation.orphaned}<span class="annotation-card-orphan"> (text no longer found)</span>{/if}
        </button>
      {/if}
```

Immediately after the `</header>`, add the row list (before the existing `{#if !isSuggestion || focused || …}` body block):

```svelte
  {#if isGroup}
    <ul class="annotation-card-subedits">
      {#each annotation.subEdits! as sub, i (i)}
        <li class="annotation-card-subedit">
          <span class="annotation-card-subedit-text">
            {#if sub.kind === "replace"}
              Replace <del>{sub.replacedText}</del> → <ins>{sub.changeText}</ins>
            {:else if sub.kind === "insert"}
              Add <ins>{sub.changeText}</ins>
            {:else}
              Remove <del>{sub.replacedText ?? sub.changeText}</del>
            {/if}
          </span>
          {#if isEditor}
            <span class="annotation-card-subedit-acts">
              <button type="button" data-act="accept" data-sub={i} title="Accept" onclick={() => onSubEdit?.(sub.ids, "accept")}>✓</button>
              <button type="button" data-act="reject" data-sub={i} title="Reject" onclick={() => onSubEdit?.(sub.ids, "reject")}>✗</button>
            </span>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
```

In the actions block at the bottom, make the group labels distinct. Change:

```svelte
  {#if isSuggestion && isEditor}
    <div class="annotation-card-actions">
      <button type="button" data-act="accept" class="primary-btn" onclick={() => onAccept?.()}>✓ Accept</button>
      <button type="button" data-act="reject" class="secondary-btn" onclick={() => onReject?.()}>✗ Reject</button>
    </div>
  {:else if isSuggestion && isOwn}
    <div class="annotation-card-actions">
      <button type="button" data-act="withdraw" class="secondary-btn" onclick={() => onWithdraw?.()}>Withdraw</button>
    </div>
```

to:

```svelte
  {#if isSuggestion && isEditor}
    <div class="annotation-card-actions">
      <button type="button" data-act="accept" class="primary-btn" onclick={() => onAccept?.()}>{isGroup ? "✓ Accept all" : "✓ Accept"}</button>
      <button type="button" data-act="reject" class="secondary-btn" onclick={() => onReject?.()}>{isGroup ? "✗ Reject all" : "✗ Reject"}</button>
    </div>
  {:else if isSuggestion && isOwn}
    <div class="annotation-card-actions">
      <button type="button" data-act="withdraw" class="secondary-btn" onclick={() => onWithdraw?.()}>{isGroup ? "Withdraw all" : "Withdraw"}</button>
    </div>
```

(The `{:else if !isSuggestion}` comment branch is untouched. A third-party reviewer on a group still falls through to no `.annotation-card-actions`, matching the non-group behaviour.)

- [ ] **Step 5: `_annotations.scss` — row styling**

After the `.annotation-card-change` rule (search for it), add:

```scss
.annotation-card-subedits {
  list-style: none;
  margin: 4px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.annotation-card-subedit {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  font-size: 0.9em;

  del {
    text-decoration: line-through;
    opacity: 0.7;
  }
  ins {
    text-decoration: none;
    background: var(--accent-soft, rgba(80, 140, 255, 0.16));
  }
}
.annotation-card-subedit-acts button {
  border: none;
  background: none;
  cursor: pointer;
  padding: 0 2px;
  color: var(--text-dim);

  &:hover {
    color: var(--text);
  }
}
```

> Check the actual token names in `_annotations.scss` for the `ins` highlight — reuse whatever `.cm-suggestion-insert` / the existing `ins` styling uses; `--accent-soft` is a guess, fall back to a literal `rgba` if that var doesn't exist.

- [ ] **Step 6: `AnnotationRail.svelte` — `resolveSubEdit` + wire**

After `withdrawOwn` (near line 169):

```ts
  function resolveSubEdit(ids: string[], outcome: "accept" | "reject") {
    const doc = ydoc();
    if (doc) ids.forEach((id) => resolveSuggestion(doc, id, outcome));
  }
```

In the `<AnnotationCard … />` invocation, add:

```svelte
            onSubEdit={(ids, outcome) => resolveSubEdit(ids, outcome)}
```

- [ ] **Step 7: Run — verify pass**

Run: `npx vitest run --project=components tests/client/src/components/AnnotationCard.test.ts` → PASS (existing + 4 new).
Run: `npx vitest run --project=components tests/client/src/components/AnnotationRail.test.ts` → PASS (unchanged behaviour).
Run: `npm run typecheck` → clean (svelte-check sees the new prop + `resolveSubEdit`).

- [ ] **Step 8: Build + format + commit**

Run: `npm run build` → clean. `npm run format:check` → clean (run `npm run format` if the `.svelte` / `.scss` need it).

```bash
git add client/src/components/AnnotationCard.svelte client/src/styles/_annotations.scss client/src/components/AnnotationRail.svelte tests/client/src/components/AnnotationCard.test.ts
git commit -m "feat: grouped-suggestion card — per-row and whole-group accept/reject

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 3: e2e-collab proof, docs, screenshot, version, PR

**Files:**
- Modify: `tests/e2e/collab/suggestion-mode.spec.ts`
- Modify: `CHANGELOG.md`, `ROADMAP.md`, `docs/TEST-COVERAGE.md`, `client/src/whats-new-entries.ts`
- Create: `client/public/whats-new/suggestion-line-grouping.png`, a capture script under `tests/scripts/manual-testing/`
- Modify (last): `package.json`, `package-lock.json`

- [ ] **Step 1: e2e-collab test**

In `tests/e2e/collab/suggestion-mode.spec.ts`, add a test modelled on the existing ones (owner shares reviewer link / a reviewer joins and types). The reviewer makes **two separate edits on one line** (e.g. type a word near the start of a line, move the cursor, type another near its end — leave unchanged text between so the self-heal doesn't merge them). Assert:

```ts
// one grouped card, not two
await expect(owner.locator(".annotation-card.suggestion")).toHaveCount(1, { timeout: 10000 });
await expect(owner.locator(".annotation-card.suggestion")).toContainText(/2 changes/i);
// per-row buttons present
await expect(owner.locator('.annotation-card.suggestion .annotation-card-subedit button[data-act="accept"]')).toHaveCount(2);
// Accept all resolves everything
await owner.locator('.annotation-card.suggestion .annotation-card-actions button[data-act="accept"]').click();
await expect(owner.locator(".annotation-card.suggestion")).toHaveCount(0, { timeout: 10000 });
```

Run: `npm run test:e2e:collab` (or the single spec). If the sandbox browser cache is stale, apply the `playwright.config.ts` `executablePath` workaround from `CLAUDE.md`, run, then revert it.

- [ ] **Step 2: Capture the What's New screenshot**

Create `tests/scripts/manual-testing/capture-suggestion-line-grouping-screenshot.mjs` modelled on `capture-anon-identity-screenshot.mjs` — owner shares a public **Reviewer** link, one guest joins and makes two separate edits on one line, owner opens the rail (`#commentsBtn`), screenshot with the grouped card visible.

Run it against a local wrangler dev instance (`bash tests/scripts/manual-testing/enable-dev-login.sh` → `npm run build` → `npx wrangler dev` → `node …capture-suggestion-line-grouping-screenshot.mjs` → kill wrangler → `bash …disable-dev-login.sh`). Verify `file client/public/whats-new/suggestion-line-grouping.png` is a real PNG and shows the grouped card with ≥ 2 rows. Confirm `npm run check:no-dev-login` is clean afterwards.

- [ ] **Step 3: What's New entry**

Append to `WHATS_NEW_ENTRIES` in `client/src/whats-new-entries.ts` (matching the existing shape — `version`, `title`, `description`, `screenshot`, `category`), `version` = the new version from Step 6:

```ts
  {
    version: "1.64.0",
    title: "One Card for a Line of Edits",
    description:
      "When someone leaves several small tracked-change suggestions on the same line, they now collapse into one card with a row per change — accept or reject each one, or the whole line at once, without a stack of near-identical cards to wade through.",
    screenshot: "/whats-new/suggestion-line-grouping.png",
    category: "Collaboration",
  },
```

- [ ] **Step 4: CHANGELOG**

Top of `CHANGELOG.md`:

```markdown
## [1.64.0] - 2026-09-11

### Changed

- Several small tracked-change suggestions on one source line now group into a single annotation-rail card with a row per change — each row and the whole group have their own accept / reject. A suggestion with an open reply thread stays on its own card.
```

- [ ] **Step 5: ROADMAP + TEST-COVERAGE**

`ROADMAP.md` — in **Group D**, mark **D4** (and note the D1–D5 arc complete): change its `_(needs brainstorm)_` line to a shipped note with the spec/plan path and `v1.64.0`. Update the "Shape:" line if it still says D4 needs a decision.

`docs/TEST-COVERAGE.md` — add a COLLAB row for line-grouping (`groupSuggestionCards` — same-line/same-author/thread-less runs of ≥ 2 collapse to one card, replace-pair stays one member, per-row + whole-group resolve; `tests/client/src/suggestion-group.test.ts`, `AnnotationCard.test.ts`, `suggestion-mode.spec.ts`). Bump the §10 + Total tallies by 1 (hand-maintained — match the surrounding convention).

- [ ] **Step 6: Version bump (last)**

`1.63.0` → `1.64.0` in `package.json` and both `package-lock.json` top `"version"` fields. Verify: `grep -n '"version": "1.6' package.json package-lock.json`.

```bash
git add tests/e2e/collab/suggestion-mode.spec.ts tests/scripts/manual-testing/capture-suggestion-line-grouping-screenshot.mjs client/public/whats-new/suggestion-line-grouping.png CHANGELOG.md ROADMAP.md docs/TEST-COVERAGE.md client/src/whats-new-entries.ts package.json package-lock.json
git commit -m "chore: release 1.64.0 — suggestion line-grouping (D4)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

- [ ] **Step 7: Full verification**

```bash
npm test
npx vitest run --project=components
npm run typecheck
npm run build
npm run format:check
npm run check:no-dev-login
```
All green.

- [ ] **Step 8: Push + PR**

```bash
git push -u origin feat/suggestion-line-grouping
```
`gh pr create --repo Jerit3787/markdown-editor --base master` — title `feat: group same-line pending suggestions into one rail card (D4)`. Body: the card-spam problem, the pure `groupSuggestionCards` pass (display-only, no CRDT/schema/server change), the grouping rule (same line + author + no thread, ≥ 2), the card (rows + per-row + whole-group actions), scope/non-goals from the spec, verification results, minor bump to 1.64.0, that this closes the D1–D5 arc. End with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

- [ ] **Step 9: CI + merge**

Wait for all checks green (incl. CodeQL + e2e-collab). Merge with a real merge commit once the user authorizes:
```bash
gh pr merge <N> --repo Jerit3787/markdown-editor --merge
```

---

## Self-Review

**1. Spec coverage**

| Spec section | Task |
|---|---|
| §1 `suggestion-group.ts` — `lineRange`, `groupSuggestionCards`, grouping rule, group shape, `RailAnnotation.subEdits`, wiring into `suggestionCards` | Task 1 (all steps) |
| §2 card `{#if annotation.subEdits}` branch — header count, rows, per-row ✓/✗, footer Accept all / Reject all / Withdraw all, `onSubEdit` prop | Task 2 Steps 3-5 |
| §3 `resolveSubEdit`, pass as `onSubEdit`, hover-link unchanged | Task 2 Step 6 (hover-link is already `underlyingIds(a)` — no change needed) |
| §4 inline marks unchanged | no task touches `suggestion-editor.ts` — constraint stated |
| Non-goals (no cross-line, no CRDT merge, no comment/threaded grouping, no per-row hover, no group thread, no server/schema/editor change, replace-pair untouched) | Global Constraints + no task does any of them |
| Edge cases (single edit, span-`\n`, last-row resolve, two authors, replace-pair-only line, discussed+quiet, list view) | Task 1 tests (single, two authors, replace-pair member, thread exclusion) + Task 2 tests (third-party) + Task 3 e2e (resolve collapses) |
| Testing list | Task 1 (`suggestion-group.test.ts`, `annotations.test.ts`), Task 2 (`AnnotationCard.test.ts`), Task 3 (`suggestion-mode.spec.ts`) — the spec's separate `AnnotationRail.test.ts` case is folded into the card test (`onSubEdit` fires) + e2e, matching that file's existing 2-test scope |
| Versioning (minor, changelog `### Changed`, whats-new + screenshot, ROADMAP D4) | Task 3 |

Gap: the spec lists an `AnnotationRail.test.ts` case for `resolveSubEdit`. `AnnotationRail.test.ts` has only 2 tests (comments-button only) and no `window.MDE.getActiveYDoc` scaffolding; `resolveSubEdit` is a 2-line mirror of the already-pattern-covered `acceptSuggestion`. Covered instead by Task 2's `onSubEdit`-fires assertion + Task 3's e2e "Accept all → count 0". Acceptable deviation, noted here.

**2. Placeholder scan:** No TODO/TBD. Every code step has literal code. The two soft spots are flagged as verify-against-real-code: Task 2 Step 5's `--accent-soft` token ("fall back to a literal rgba") and Task 1 Step 8's self-heal caveat ("split further apart … the assertion is the fixed part"). Both give the concrete fallback.

**3. Type consistency**
- `RailAnnotation.subEdits` shape (`ids/kind/changeText/replacedText?/from/to`) — defined Task 1 Step 3, consumed Task 1 Step 4 (`groupSuggestionCards` builds it), Task 2 Steps 1/4 (`sub.kind`, `sub.changeText`, `sub.replacedText`, `sub.ids`). ✓
- `groupSuggestionCards(cards, content)` / `lineRange(content, index)` — same signatures in Task 1 define + test. ✓
- `onSubEdit(ids: string[], outcome: "accept" | "reject")` — Task 2 Step 3 (prop type), Step 4 (`onSubEdit?.(sub.ids, "accept")`), Step 6 (`resolveSubEdit(ids, outcome)` passed), Task 2 Step 1 test (`toHaveBeenCalledWith(["b"], "reject")`). ✓
- `resolveSubEdit(ids: string[], outcome)` mirrors `acceptSuggestion`'s `underlyingIds(a).forEach((id) => resolveSuggestion(doc, id, outcome))`. ✓
- `underlyingIds` unchanged; a group card has `groupedIds` so `underlyingIds(group)` returns the flat list Task 2's footer handlers iterate. ✓
