# Annotation Rail (SP-A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move suggestion cards out of the editor text flow into a right-margin rail, vertically aligned to their line, rendered by the same card component that renders comments; one `AnnotationRail` replaces the flat `CommentsPanel` list.

**Architecture:** A pure layout engine (`annotation-rail-layout.ts`) computes card `top`s from anchor Ys with collision + edge-clamp. A pure adapter (`annotations.ts`) normalises suggestions (Y.Doc), shared-doc comment threads (HTTP), and local notes into one `RailAnnotation` shape. `AnnotationCard.svelte` renders any `RailAnnotation`. `AnnotationRail.svelte` (the reworked `CommentsPanel`) derives the list, measures anchors via `EditorView.coordsAtPos`, runs the layout engine on a rAF-throttled scroll loop, and links hover both ways through an `activeAnnotationIds` store. Storage, sync, and resolution semantics are untouched.

**Tech Stack:** Svelte 5 (runes), CodeMirror 6 (`coordsAtPos`, `Decoration.mark` attributes, `EditorView.scrollIntoView`), Yjs (read-only here), Vitest (`unit` + `components` projects), Playwright (`local` + `collab`).

**Spec:** `docs/superpowers/specs/2026-09-09-annotation-rail-design.md`

## Global Constraints

- Two `tsconfig.json`s. `client/src/**` + `tests/client/src/**` have `strictNullChecks` / `noImplicitAny` **off**. All new files here are client files.
- Svelte 5 runes. Component tests go under `tests/client/src/components/*.test.ts` (routed to the `components` Vitest project — real headless Chromium, not jsdom). All other tests → `unit`.
- `npm run format` (Prettier) and `npm run typecheck` (`tsc --noEmit` + `svelte-check`) must pass.
- The `local` Playwright project runs against `vite dev` (`:5275`); the `collab` project against `wrangler dev` (`:8787`) with the real `WorkspaceRoom` — started by `tests/scripts/e2e-collab.sh` (which applies the dev-login patch to `src/worker.ts`; **commit any `src/worker.ts` change before running it** — this plan touches no server code, so it will not be an issue).
- Keep the `#comments-panel-mount` DOM id, the `comments` grid-area name, and `stores/commentsPanel.ts` unchanged — only the component file is renamed, to hold the diff.
- `feedback_topbar_sizing_locked` — do not touch topbar/logo/icon sizing or accent tokens.
- Mobile (`max-width: 780px`): rail is the existing bottom-sheet, **list mode only**, no anchoring.
- Release: minor `1.61.0`. `package.json` + both `package-lock.json` `"version"` fields (hand-edited, lines 3 and 9). `CHANGELOG.md` `### Changed`. A `client/src/whats-new-entries.ts` entry **with a real screenshot** in `client/public/whats-new/` — not deferrable.
- Never add a `Claude-Session:` trailer. `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>` only.
- Branch `feat/annotation-rail` already exists with the spec commit; do all work there.

---

## File Structure

| File | Responsibility |
|---|---|
| `client/src/annotation-rail-layout.ts` (new) | Pure: anchor Ys + card heights + viewport → card `top`s with collision & edge-clamp |
| `client/src/annotations.ts` (new) | Pure: normalise `ResolvedSuggestion[]` + `CommentThread[]` + `Note[]` → `RailAnnotation[]`; group a replace-pair |
| `client/src/stores/annotations.ts` (new) | `activeAnnotationIds` writable — the hovered/focused raw entry/thread ids, shared by editor ↔ rail |
| `client/src/components/AnnotationCard.svelte` (new) | Render one `RailAnnotation` (comment / suggestion / replace) with role-appropriate actions |
| `client/src/components/AnnotationRail.svelte` (was `CommentsPanel.svelte`) | Derive the list, anchored vs list mode, positioning loop, connectors, draft box, mobile sheet |
| `client/src/suggestion-editor.ts` (modify) | Drop the inline widget; marks carry `data-annotation-id`; delete `SuggestionWidget` / `suggestionWidgetFor` |
| `client/src/components/Editor.svelte` (modify) | `data-annotation-id` on comment marks; `.cm-annotation-active` decoration field; editor-DOM hover delegate |
| `client/src/collab.ts` (modify) | `window.MDE.getResolvedSuggestions`; observe the suggestions map → `window.MDE.onSuggestionsChanged?.()` |
| `client/src/types.ts` (modify) | `MDEBridge.getResolvedSuggestions?()` + `onSuggestionsChanged?` |
| `client/src/style.scss` (modify) | `@use "./styles/comments"` → `@use "./styles/annotations"` |
| `client/src/styles/_comments.scss` → `client/src/styles/_annotations.scss` (rename) | Rail/card/connector/active-mark rules |
| `client/src/main.ts` (modify) | Import the renamed component |

---

## Task 1: `annotation-rail-layout.ts` — the pure layout engine

**Files:**
- Create: `client/src/annotation-rail-layout.ts`
- Test: `tests/client/src/annotation-rail-layout.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export interface CardAnchor { id: string; anchorY: number | null; direction?: "above" | "below"; height: number; }
  export interface CardPlacement { id: string; top: number; clamped: "top" | "bottom" | null; }
  export function layoutCards(anchors: CardAnchor[], viewport: { height: number }, gap: number): CardPlacement[];
  ```

- [ ] **Step 1: Write the failing test**

Create `tests/client/src/annotation-rail-layout.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { layoutCards, type CardAnchor } from "../../client/src/annotation-rail-layout";

const vp = { height: 500 };

describe("layoutCards", () => {
  it("returns nothing for no anchors", () => {
    expect(layoutCards([], vp, 8)).toEqual([]);
  });

  it("places a single visible card at its anchor (never above 0)", () => {
    expect(layoutCards([{ id: "a", anchorY: 120, height: 60 }], vp, 8)).toEqual([{ id: "a", top: 120, clamped: null }]);
    expect(layoutCards([{ id: "a", anchorY: -30, height: 60 }], vp, 8)).toEqual([{ id: "a", top: 0, clamped: null }]);
  });

  it("pushes a colliding lower card below the previous card + gap", () => {
    const anchors: CardAnchor[] = [
      { id: "a", anchorY: 100, height: 60 },
      { id: "b", anchorY: 110, height: 60 },
    ];
    const out = layoutCards(anchors, vp, 8);
    expect(out.find((p) => p.id === "a")!.top).toBe(100);
    expect(out.find((p) => p.id === "b")!.top).toBe(168); // 100 + 60 + 8
  });

  it("keeps document order regardless of input order", () => {
    const out = layoutCards(
      [
        { id: "b", anchorY: 300, height: 40 },
        { id: "a", anchorY: 100, height: 40 },
      ],
      vp,
      8,
    );
    expect(out.map((p) => p.id)).toEqual(["a", "b"]);
  });

  it("clamps a null 'above' anchor to the top and a null 'below' anchor to the bottom", () => {
    const out = layoutCards(
      [
        { id: "up", anchorY: null, direction: "above", height: 50 },
        { id: "down", anchorY: null, direction: "below", height: 50 },
      ],
      vp,
      8,
    );
    expect(out.find((p) => p.id === "up")).toEqual({ id: "up", top: 0, clamped: "top" });
    expect(out.find((p) => p.id === "down")).toEqual({ id: "down", top: 450, clamped: "bottom" });
  });

  it("pulls an overflowing stack back up, but never a card above its own anchor", () => {
    // three 200px cards, anchors near the bottom → would overflow 500px
    const anchors: CardAnchor[] = [
      { id: "a", anchorY: 200, height: 200 },
      { id: "b", anchorY: 260, height: 200 },
      { id: "c", anchorY: 320, height: 200 },
    ];
    const out = layoutCards(anchors, vp, 0);
    const byId = Object.fromEntries(out.map((p) => [p.id, p.top]));
    expect(byId.a).toBeGreaterThanOrEqual(0);
    expect(byId.b).toBeGreaterThanOrEqual(byId.a + 200); // still no overlap
    expect(byId.c).toBeGreaterThanOrEqual(byId.b + 200);
    expect(byId.a).toBeLessThanOrEqual(200); // not shoved past its anchor
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run tests/client/src/annotation-rail-layout.test.ts`
Expected: FAIL — `Failed to resolve import ".../annotation-rail-layout"`.

- [ ] **Step 3: Implement the module**

Create `client/src/annotation-rail-layout.ts`:

```ts
// Pure geometry for the annotation rail: given each card's anchor Y (the
// screen position of the line it annotates, already converted to
// rail-relative pixels by the caller) and its measured height, return the
// `top` each card should render at — collision-resolved so cards never
// overlap, and edge-clamped so a card whose anchor scrolled out of view
// still shows, stacked at the nearest edge. No DOM, no measurement here.

export interface CardAnchor {
  id: string;
  anchorY: number | null; // rail-relative px; null = anchor outside the editor viewport
  direction?: "above" | "below"; // required when anchorY is null
  height: number; // measured card height in px
}

export interface CardPlacement {
  id: string;
  top: number;
  clamped: "top" | "bottom" | null;
}

export function layoutCards(anchors: CardAnchor[], viewport: { height: number }, gap: number): CardPlacement[] {
  const visible = anchors
    .filter((a): a is CardAnchor & { anchorY: number } => a.anchorY !== null)
    .sort((a, b) => a.anchorY - b.anchorY);
  const above = anchors.filter((a) => a.anchorY === null && a.direction === "above");
  const below = anchors.filter((a) => a.anchorY === null && a.direction === "below");

  const placements: CardPlacement[] = [];

  // Visible: greedy top-down, no card placed above its own anchor.
  let cursor = 0;
  for (const a of visible) {
    const top = Math.max(a.anchorY, cursor);
    placements.push({ id: a.id, top, clamped: null });
    cursor = top + a.height + gap;
  }

  // If the stack overran the bottom, claw it back — walking upward, each
  // card gives up slack only down to its own anchorY (its floor).
  let slack = cursor - gap - viewport.height;
  for (let i = placements.length - 1; i >= 0 && slack > 0; i--) {
    const p = placements[i]!;
    const floor = visible[i]!.anchorY;
    const give = Math.min(slack, p.top - floor);
    p.top -= give;
    slack -= give;
  }

  // Off-screen: stack from the near edge, most-recent (last in list) nearest the fold.
  let aTop = 0;
  for (const a of above) {
    placements.push({ id: a.id, top: aTop, clamped: "top" });
    aTop += a.height + gap;
  }
  let bTop = viewport.height;
  for (const a of below) {
    bTop -= a.height;
    placements.push({ id: a.id, top: bTop, clamped: "bottom" });
    bTop -= gap;
  }

  return placements;
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/client/src/annotation-rail-layout.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add client/src/annotation-rail-layout.ts tests/client/src/annotation-rail-layout.test.ts
git commit -m "$(cat <<'EOF'
feat(annotations): pure layout engine for the rail

layoutCards: anchor Ys + card heights + viewport height → collision-free
card tops, with off-screen anchors clamped and stacked at the near edge.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `annotations.ts` — the normalising adapter

**Files:**
- Create: `client/src/annotations.ts`
- Test: `tests/client/src/annotations.test.ts`

**Interfaces:**
- Consumes: `ResolvedSuggestion` from `./suggestions`, `CommentThread` from `./comments`, `Note` from `./types`, `relocateAnchor` from `./anchor`.
- Produces:
  ```ts
  export interface RailAnnotation {
    id: string;
    kind: "comment" | "suggestion";
    author: string;
    createdAt: number;
    anchorFrom: number;
    anchorTo: number;
    quote?: string;
    resolved?: boolean;
    orphaned?: boolean;
    replies?: { id: string; author: string; body: string; createdAt: number }[];
    changeKind?: "insert" | "delete";
    changeText?: string;      // inserted text (insert / replace) or removed text (delete)
    replacedText?: string;    // set only for a replace: the removed text
    groupedIds?: string[];    // the underlying suggestion entry ids when this card is a replace
  }
  export function railAnnotationsForShared(suggestions: ResolvedSuggestion[], threads: CommentThread[], content: string): RailAnnotation[];
  export function railAnnotationsForLocal(notes: Note[], content: string): RailAnnotation[];
  export function underlyingIds(a: RailAnnotation): string[]; // groupedIds ?? [id]
  ```

- [ ] **Step 1: Write the failing test**

Create `tests/client/src/annotations.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { recordInsertSuggestion, recordDeleteSuggestion, listResolvedSuggestions } from "../../src/suggestions";
import { railAnnotationsForShared, railAnnotationsForLocal, underlyingIds } from "../../client/src/annotations";
import type { CommentThread } from "../../client/src/comments";
import type { Note } from "../../client/src/types";

function docWith(text: string): Y.Doc {
  const d = new Y.Doc();
  d.getText("content").insert(0, text);
  return d;
}

const CONTENT = "hello world";

describe("railAnnotationsForShared — suggestions", () => {
  it("maps a lone insert suggestion", () => {
    const doc = docWith(CONTENT);
    recordInsertSuggestion(doc, 5, 11, "alice");
    const [a] = railAnnotationsForShared(listResolvedSuggestions(doc), [], CONTENT);
    expect(a).toMatchObject({ kind: "suggestion", author: "alice", changeKind: "insert", changeText: " world", anchorFrom: 5, anchorTo: 11 });
    expect(a.groupedIds).toBeUndefined();
  });

  it("maps a lone delete suggestion", () => {
    const doc = docWith(CONTENT);
    recordDeleteSuggestion(doc, 0, 5, "alice");
    const [a] = railAnnotationsForShared(listResolvedSuggestions(doc), [], CONTENT);
    expect(a).toMatchObject({ kind: "suggestion", changeKind: "delete", changeText: "hello" });
  });

  it("groups a contiguous same-author delete+insert into one replace card", () => {
    const doc = docWith(CONTENT);
    recordDeleteSuggestion(doc, 0, 5, "alice"); // "hello"
    recordInsertSuggestion(doc, 5, 11, "alice"); // " world" lands right after
    const list = listResolvedSuggestions(doc);
    const cards = railAnnotationsForShared(list, [], CONTENT);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ kind: "suggestion", replacedText: "hello", changeText: " world" });
    expect(cards[0].groupedIds!.sort()).toEqual(list.map((s) => s.id).sort());
    expect(underlyingIds(cards[0])).toEqual(cards[0].groupedIds);
  });

  it("does NOT group a non-contiguous delete + insert", () => {
    const doc = docWith(CONTENT);
    recordDeleteSuggestion(doc, 0, 5, "alice");
    recordInsertSuggestion(doc, 8, 11, "alice"); // gap between 5 and 8
    expect(railAnnotationsForShared(listResolvedSuggestions(doc), [], CONTENT)).toHaveLength(2);
  });

  it("does NOT group a different-author adjacent pair", () => {
    const doc = docWith(CONTENT);
    recordDeleteSuggestion(doc, 0, 5, "alice");
    recordInsertSuggestion(doc, 5, 11, "bob");
    expect(railAnnotationsForShared(listResolvedSuggestions(doc), [], CONTENT)).toHaveLength(2);
  });
});

describe("railAnnotationsForShared — comments", () => {
  const thread: CommentThread = {
    id: "t1",
    from: 0,
    to: 5,
    quote: "hello",
    orphaned: false,
    resolved: false,
    comments: [
      { id: "c1", author: "bob", body: "sure?", createdAt: 10 },
      { id: "c2", author: "alice", body: "yes", createdAt: 20 },
    ],
  };

  it("maps a thread's quote, replies, resolved state and relocated anchor", () => {
    const [a] = railAnnotationsForShared([], [thread], CONTENT);
    expect(a).toMatchObject({ kind: "comment", author: "bob", quote: "hello", resolved: false, orphaned: false, anchorFrom: 0, anchorTo: 5 });
    expect(a.replies).toHaveLength(2);
  });

  it("flags a thread whose quote is gone as orphaned at offset 0", () => {
    const [a] = railAnnotationsForShared([], [{ ...thread, quote: "nowhere" }], CONTENT);
    expect(a).toMatchObject({ orphaned: true, anchorFrom: 0, anchorTo: 0 });
  });
});

describe("railAnnotationsForLocal", () => {
  it("maps a note to a single-reply comment card", () => {
    const note: Note = { id: "n1", from: 6, to: 11, quote: "world", body: "check this", author: "me", createdAt: 5 } as Note;
    const [a] = railAnnotationsForLocal([note], CONTENT);
    expect(a).toMatchObject({ kind: "comment", anchorFrom: 6, anchorTo: 11, quote: "world" });
    expect(a.replies).toEqual([{ id: "n1", author: "me", body: "check this", createdAt: 5 }]);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run tests/client/src/annotations.test.ts`
Expected: FAIL — cannot resolve `../../client/src/annotations`.

- [ ] **Step 3: Implement the module**

Create `client/src/annotations.ts`:

```ts
import type { ResolvedSuggestion } from "./suggestions";
import type { CommentThread } from "./comments";
import type { Note } from "./types";
import { relocateAnchor } from "./anchor";

export interface RailAnnotation {
  id: string;
  kind: "comment" | "suggestion";
  author: string;
  createdAt: number;
  anchorFrom: number;
  anchorTo: number;
  quote?: string;
  resolved?: boolean;
  orphaned?: boolean;
  replies?: { id: string; author: string; body: string; createdAt: number }[];
  changeKind?: "insert" | "delete";
  changeText?: string;
  replacedText?: string;
  groupedIds?: string[];
}

/** The underlying suggestion-entry / thread ids a card represents. */
export function underlyingIds(a: RailAnnotation): string[] {
  return a.groupedIds ?? [a.id];
}

function suggestionCards(suggestions: ResolvedSuggestion[], content: string): RailAnnotation[] {
  const sorted = [...suggestions].sort((a, b) => a.from - b.from);
  const out: RailAnnotation[] = [];
  const used = new Set<string>();
  for (let i = 0; i < sorted.length; i++) {
    const s = sorted[i]!;
    if (used.has(s.id)) continue;
    const next = sorted[i + 1];
    // A replace: this entry's end touches the next entry's start, same
    // author, opposite kind. suggestionTransactionFilter always emits the
    // delete first (lower `from`) then the insert at the deleted range's end.
    if (next && !used.has(next.id) && next.author === s.author && next.kind !== s.kind && next.from === s.to) {
      const del = s.kind === "delete" ? s : next;
      const ins = s.kind === "insert" ? s : next;
      used.add(s.id);
      used.add(next.id);
      out.push({
        id: `${del.id}+${ins.id}`,
        kind: "suggestion",
        author: s.author,
        createdAt: Math.min(s.createdAt, next.createdAt),
        anchorFrom: Math.min(del.from, ins.from),
        anchorTo: Math.max(del.to, ins.to),
        changeText: content.slice(ins.from, ins.to),
        replacedText: content.slice(del.from, del.to),
        groupedIds: [del.id, ins.id],
      });
      continue;
    }
    out.push({
      id: s.id,
      kind: "suggestion",
      author: s.author,
      createdAt: s.createdAt,
      anchorFrom: s.from,
      anchorTo: s.to,
      changeKind: s.kind,
      changeText: content.slice(s.from, s.to),
    });
  }
  return out;
}

function commentCard(thread: CommentThread, content: string): RailAnnotation {
  const loc = relocateAnchor(content, thread);
  return {
    id: thread.id,
    kind: "comment",
    author: thread.comments[0]?.author ?? "",
    createdAt: thread.comments[0]?.createdAt ?? 0,
    anchorFrom: loc?.from ?? 0,
    anchorTo: loc?.to ?? 0,
    quote: thread.quote,
    resolved: thread.resolved,
    orphaned: !loc,
    replies: thread.comments.map((c) => ({ id: c.id, author: c.author, body: c.body, createdAt: c.createdAt })),
  };
}

function bySortKey(a: RailAnnotation, b: RailAnnotation): number {
  return a.anchorFrom - b.anchorFrom || a.createdAt - b.createdAt;
}

export function railAnnotationsForShared(suggestions: ResolvedSuggestion[], threads: CommentThread[], content: string): RailAnnotation[] {
  return [...suggestionCards(suggestions, content), ...threads.map((t) => commentCard(t, content))].sort(bySortKey);
}

export function railAnnotationsForLocal(notes: Note[], content: string): RailAnnotation[] {
  return notes
    .map((n): RailAnnotation => {
      const loc = relocateAnchor(content, n);
      return {
        id: n.id,
        kind: "comment",
        author: n.author ?? "",
        createdAt: n.createdAt ?? 0,
        anchorFrom: loc?.from ?? 0,
        anchorTo: loc?.to ?? 0,
        quote: n.quote,
        orphaned: !loc,
        replies: [{ id: n.id, author: n.author ?? "", body: n.body, createdAt: n.createdAt ?? 0 }],
      };
    })
    .sort(bySortKey);
}
```

Note: check `client/src/types.ts`'s `Note` for the exact field names (`author?`, `createdAt?`, `body`, `quote`, `from`, `to`) and adjust the `n.author ?? ""` fallbacks to match. `relocateAnchor` needs `{ from, to, quote }` — `Note` and `CommentThread` both have those.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/client/src/annotations.test.ts`
Expected: PASS (9 tests). If `Note`'s shape differs, fix the fallback expressions and the test's `note` literal, not the interface.

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck`
Expected: PASS.

```bash
git add client/src/annotations.ts tests/client/src/annotations.test.ts
git commit -m "$(cat <<'EOF'
feat(annotations): adapter normalising suggestions + comments + notes

railAnnotationsForShared / railAnnotationsForLocal → one RailAnnotation
shape. A contiguous same-author delete+insert groups into one replace
card carrying both entry ids.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `activeAnnotationIds` store + the `window.MDE` suggestion bridge

**Files:**
- Create: `client/src/stores/annotations.ts`
- Test: `tests/client/src/stores/annotations.test.ts`
- Modify: `client/src/types.ts` (the `MDEBridge` interface)
- Modify: `client/src/collab.ts` (`init()` and the per-binding wiring)

**Interfaces:**
- Consumes: `listResolvedSuggestions` from `./suggestions` (already imported in `collab.ts`).
- Produces:
  ```ts
  // stores/annotations.ts
  export const activeAnnotationIds: Writable<string[]>;
  // types.ts MDEBridge
  getResolvedSuggestions?(): ResolvedSuggestion[];
  onSuggestionsChanged?: (() => void) | null;
  ```

- [ ] **Step 1: Write the failing store test**

Create `tests/client/src/stores/annotations.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { get } from "svelte/store";
import { activeAnnotationIds } from "../../../client/src/stores/annotations";

describe("activeAnnotationIds", () => {
  it("starts empty and holds a set of ids", () => {
    expect(get(activeAnnotationIds)).toEqual([]);
    activeAnnotationIds.set(["a", "b"]);
    expect(get(activeAnnotationIds)).toEqual(["a", "b"]);
    activeAnnotationIds.set([]);
    expect(get(activeAnnotationIds)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run tests/client/src/stores/annotations.test.ts`
Expected: FAIL — cannot resolve the store module.

- [ ] **Step 3: Create the store**

Create `client/src/stores/annotations.ts`:

```ts
import { writable } from "svelte/store";

// The raw suggestion-entry / comment-thread ids currently hovered or
// focused, shared between the editor (which highlights the matching
// marks) and the rail (which highlights the matching card). A replace
// card contributes both of its underlying ids.
export const activeAnnotationIds = writable<string[]>([]);
```

- [ ] **Step 4: Run the store test**

Run: `npx vitest run tests/client/src/stores/annotations.test.ts`
Expected: PASS.

- [ ] **Step 5: Extend the `MDEBridge` type**

In `client/src/types.ts`, near the existing `setCommentMarkers?(...)` line in the `MDEBridge` interface, add (import `ResolvedSuggestion` from `./suggestions` at the top of the file if not present):

```ts
  /** Live suggestions for the active shared document; [] when not in a shared doc. Set in collab.ts init(). */
  getResolvedSuggestions?(): import("./suggestions").ResolvedSuggestion[];
  /** Called by collab.ts whenever the active doc's suggestions map changes (local edit or remote). */
  onSuggestionsChanged?: (() => void) | null;
```

- [ ] **Step 6: Wire the bridge in `collab.ts`**

In `client/src/collab.ts`, add a helper near the other binding helpers:

```ts
function activeBinding(): DocBinding | undefined {
  return lastRequestedActiveDocId ? workspaceRoom.docs.get(lastRequestedActiveDocId) : undefined;
}
```

In `init()` (alongside the other `window.MDE.on*` / accessor assignments, ~line 229–294), add:

```ts
  window.MDE.getResolvedSuggestions = () => {
    const b = activeBinding();
    return b ? listResolvedSuggestions(b.ydoc) : [];
  };
```

In `applyEditorMode` (or wherever a binding is first fully wired — right after `suggestionExtensions` is pushed is fine), attach a one-time observer per binding so the rail hears map changes:

```ts
  if (!binding.suggestionsObserved) {
    binding.suggestionsObserved = true;
    getSuggestionsMap(binding.ydoc).observe(() => window.MDE.onSuggestionsChanged?.());
  }
```

Add `suggestionsObserved?: boolean;` to the `DocBinding` interface (~line 103) and import `getSuggestionsMap` from `./suggestion-editor` re-export or directly from `./suggestions` (it is already imported transitively — add `getSuggestionsMap` to the `./suggestions` import if needed; `collab.ts` currently imports from `./suggestion-editor` only, so add `import { getSuggestionsMap, listResolvedSuggestions } from "./suggestions";`).

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: PASS. `svelte-check` sees the new `MDEBridge` members as optional — no call sites break.

- [ ] **Step 8: Commit**

```bash
git add client/src/stores/annotations.ts tests/client/src/stores/annotations.test.ts client/src/types.ts client/src/collab.ts
git commit -m "$(cat <<'EOF'
feat(annotations): activeAnnotationIds store + suggestions bridge

window.MDE.getResolvedSuggestions returns the active shared doc's live
suggestions; a per-binding observer fires window.MDE.onSuggestionsChanged
so the rail can re-derive without importing collab.ts.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `AnnotationCard.svelte`

**Files:**
- Create: `client/src/components/AnnotationCard.svelte`
- Create: `client/src/styles/_annotations.scss` (rename from `_comments.scss` — see Step 3)
- Modify: `client/src/style.scss` (the `@use` line)
- Test: `tests/client/src/components/AnnotationCard.test.ts`

**Interfaces:**
- Consumes: `RailAnnotation`, `underlyingIds` from `../annotations` (Task 2).
- Produces: a component with these props (Svelte 5 `$props()`):
  ```ts
  { annotation: RailAnnotation;
    viewer: { role: "editor" | "reviewer" | "viewer" | null; name: string };
    focused?: boolean;
    onAccept?: () => void; onReject?: () => void; onWithdraw?: () => void;
    onResolve?: (resolved: boolean) => void; onDelete?: () => void;
    onReply?: (body: string) => void; onJump?: () => void; onFocus?: () => void; }
  ```

- [ ] **Step 1: Write the failing component test**

Create `tests/client/src/components/AnnotationCard.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import AnnotationCard from "../../../../client/src/components/AnnotationCard.svelte";
import type { RailAnnotation } from "../../../../client/src/annotations";

const insertSug: RailAnnotation = { id: "s1", kind: "suggestion", author: "alice", createdAt: 0, anchorFrom: 5, anchorTo: 11, changeKind: "insert", changeText: "world" };
const replaceSug: RailAnnotation = { id: "d1+i1", kind: "suggestion", author: "alice", createdAt: 0, anchorFrom: 0, anchorTo: 11, changeText: "requests", replacedText: "fetches", groupedIds: ["d1", "i1"] };
const comment: RailAnnotation = { id: "t1", kind: "comment", author: "bob", createdAt: 0, anchorFrom: 0, anchorTo: 5, quote: "hello", resolved: false, replies: [{ id: "c1", author: "bob", body: "is this right?", createdAt: 0 }] };

describe("AnnotationCard", () => {
  it("an editor sees Accept + Reject on a suggestion", async () => {
    const onAccept = vi.fn();
    const screen = render(AnnotationCard, { annotation: insertSug, viewer: { role: "editor", name: "carol" }, onAccept });
    await expect.element(screen.getByText(/add/i)).toBeInTheDocument();
    await expect.element(screen.getByText(/world/)).toBeInTheDocument();
    await screen.getByRole("button", { name: /accept/i }).click();
    expect(onAccept).toHaveBeenCalledOnce();
    expect(screen.container.querySelector("button[data-act='withdraw']")).toBeNull();
  });

  it("the author sees Withdraw, not Accept", async () => {
    const screen = render(AnnotationCard, { annotation: insertSug, viewer: { role: "reviewer", name: "alice" } });
    await expect.element(screen.getByRole("button", { name: /withdraw/i })).toBeInTheDocument();
    expect(screen.container.querySelector("button[data-act='accept']")).toBeNull();
  });

  it("a third-party reviewer sees no action row on a suggestion", () => {
    const screen = render(AnnotationCard, { annotation: insertSug, viewer: { role: "reviewer", name: "dave" } });
    expect(screen.container.querySelector(".annotation-card-actions")).toBeNull();
  });

  it("renders a replace as one line", async () => {
    const screen = render(AnnotationCard, { annotation: replaceSug, viewer: { role: "editor", name: "carol" } });
    await expect.element(screen.getByText(/fetches/)).toBeInTheDocument();
    await expect.element(screen.getByText(/requests/)).toBeInTheDocument();
  });

  it("a comment card shows the quote, replies, and a Resolve toggle", async () => {
    const onResolve = vi.fn();
    const screen = render(AnnotationCard, { annotation: comment, viewer: { role: "editor", name: "carol" }, focused: true, onResolve });
    await expect.element(screen.getByText(/is this right\?/)).toBeInTheDocument();
    await screen.getByRole("button", { name: /resolve/i }).click();
    expect(onResolve).toHaveBeenCalledWith(true);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run --project=components tests/client/src/components/AnnotationCard.test.ts`
Expected: FAIL — component file missing.

- [ ] **Step 3: Rename the stylesheet and register it**

```bash
git mv client/src/styles/_comments.scss client/src/styles/_annotations.scss
```

In `client/src/style.scss` change line 12:

```scss
@use "./styles/annotations";
```

(Content of `_annotations.scss` is edited in Steps 6 and Task 6; the rename + registration happens here so the component's classes resolve.)

- [ ] **Step 4: Implement `AnnotationCard.svelte`**

Create `client/src/components/AnnotationCard.svelte`:

```svelte
<script lang="ts">
  import type { RailAnnotation } from "../annotations";

  let {
    annotation,
    viewer,
    focused = false,
    onAccept,
    onReject,
    onWithdraw,
    onResolve,
    onDelete,
    onReply,
    onJump,
    onFocus,
  }: {
    annotation: RailAnnotation;
    viewer: { role: "editor" | "reviewer" | "viewer" | null; name: string };
    focused?: boolean;
    onAccept?: () => void;
    onReject?: () => void;
    onWithdraw?: () => void;
    onResolve?: (resolved: boolean) => void;
    onDelete?: () => void;
    onReply?: (body: string) => void;
    onJump?: () => void;
    onFocus?: () => void;
  } = $props();

  let replyBody = $state("");

  const isSuggestion = $derived(annotation.kind === "suggestion");
  const isOwn = $derived(annotation.author === viewer.name);
  const isEditor = $derived(viewer.role === "editor");
  const avatarUrl = $derived(annotation.author ? `https://github.com/${annotation.author}.png` : "");

  function submitReply() {
    const b = replyBody.trim();
    if (b) {
      onReply?.(b);
      replyBody = "";
    }
  }
</script>

<article
  class="annotation-card"
  class:suggestion={isSuggestion}
  class:comment={!isSuggestion}
  class:focused
  class:resolved={annotation.resolved}
  class:orphaned={annotation.orphaned}
  onmouseenter={() => onFocus?.()}
>
  <header class="annotation-card-head">
    {#if avatarUrl}
      <img class="annotation-card-avatar" src={avatarUrl} alt="" onerror={(e) => ((e.currentTarget as HTMLImageElement).style.visibility = "hidden")} />
    {/if}
    <div class="annotation-card-meta">
      <span class="annotation-card-author">{annotation.author || "Someone"}{#if isSuggestion}<span class="annotation-card-role"> · suggesting</span>{/if}</span>
      {#if isSuggestion}
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
    </div>
  </header>

  {#if !isSuggestion}
    <div class="annotation-card-body">
      {#each annotation.replies ?? [] as reply (reply.id)}
        <p class="annotation-card-reply"><strong>{reply.author}</strong> {reply.body}</p>
      {/each}
      {#if focused}
        <div class="annotation-card-reply-row">
          <input type="text" placeholder="Reply…" bind:value={replyBody} onkeydown={(e) => e.key === "Enter" && submitReply()} />
          <button type="button" class="secondary-btn" onclick={submitReply}>Reply</button>
        </div>
      {:else if (annotation.replies?.length ?? 0) > 1}
        <p class="annotation-card-count">{annotation.replies!.length} replies</p>
      {/if}
    </div>
  {/if}

  {#if isSuggestion && isEditor}
    <div class="annotation-card-actions">
      <button type="button" data-act="accept" class="primary-btn" onclick={() => onAccept?.()}>✓ Accept</button>
      <button type="button" data-act="reject" class="secondary-btn" onclick={() => onReject?.()}>✗ Reject</button>
    </div>
  {:else if isSuggestion && isOwn}
    <div class="annotation-card-actions">
      <button type="button" data-act="withdraw" class="secondary-btn" onclick={() => onWithdraw?.()}>Withdraw</button>
    </div>
  {:else if !isSuggestion}
    <div class="annotation-card-actions">
      <button type="button" class="secondary-btn" onclick={() => onResolve?.(!annotation.resolved)}>{annotation.resolved ? "Reopen" : "Resolve"}</button>
      <button type="button" class="secondary-btn" onclick={() => onDelete?.()}>Delete</button>
    </div>
  {/if}
</article>
```

- [ ] **Step 5: Add the base card styles to `_annotations.scss`**

Append to `client/src/styles/_annotations.scss` (the rail-layout rules land in Task 6):

```scss
.annotation-card {
  background: var(--bg);
  border: 1px solid var(--border);
  border-left: 3px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  font-size: 12px;
  overflow: hidden;
}
.annotation-card.suggestion { border-left-color: #2e7d32; }
.annotation-card.comment { border-left-color: #f0b400; }
.annotation-card.resolved { opacity: 0.55; }
.annotation-card.orphaned { opacity: 0.6; }
.annotation-card.focused { box-shadow: 0 0 0 2px var(--accent); }
.annotation-card-head { display: flex; gap: 8px; padding: 8px 10px; }
.annotation-card-avatar { width: 22px; height: 22px; border-radius: 50%; flex-shrink: 0; }
.annotation-card-meta { flex: 1; min-width: 0; }
.annotation-card-author { font-weight: 700; }
.annotation-card-role { font-weight: 400; color: var(--text-dim); }
.annotation-card-change { display: block; margin-top: 2px; }
.annotation-card-change ins { text-decoration: none; color: #2e7d32; }
.annotation-card-change del { color: #c62828; }
.annotation-card-quote {
  display: block; width: 100%; text-align: left; border: none; background: none;
  font-family: inherit; font-style: italic; color: var(--text-dim); cursor: pointer; padding: 2px 0 0;
}
.annotation-card-orphan { font-style: normal; font-size: 11px; }
.annotation-card-body { padding: 0 10px 8px; }
.annotation-card-reply { margin: 0 0 4px; }
.annotation-card-count { margin: 4px 0 0; color: var(--text-dim); font-size: 11px; }
.annotation-card-reply-row { display: flex; gap: 6px; margin-top: 6px; }
.annotation-card-reply-row input {
  flex: 1; font-size: 12px; border: 1px solid var(--border); background: var(--bg-alt);
  color: var(--text); border-radius: 6px; padding: 4px 6px;
}
.annotation-card-actions {
  display: flex; gap: 6px; padding: 6px 10px; border-top: 1px solid var(--border); background: var(--bg-alt);
  button { width: auto; margin-bottom: 0; font-size: 11px; padding: 2px 10px; }
}
```

(`--bg-alt`, `--text-dim`, `--radius`, `--shadow`, `--accent`, `--border` are existing tokens — confirm against `_variables.scss`; substitute the closest existing token if a name differs.)

- [ ] **Step 6: Run the component tests**

Run: `npx vitest run --project=components tests/client/src/components/AnnotationCard.test.ts`
Expected: PASS (5 tests). A failed component test drops a screenshot in `tests/client/src/components/__screenshots__/` — check it first if one fails.

- [ ] **Step 7: Typecheck + format + commit**

Run: `npm run typecheck && npm run format:check`
Expected: PASS (`_annotations.scss` is not prettier-ignored — run `npm run format` if it complains).

```bash
git add client/src/components/AnnotationCard.svelte client/src/styles/_annotations.scss client/src/style.scss tests/client/src/components/AnnotationCard.test.ts
git commit -m "$(cat <<'EOF'
feat(annotations): shared AnnotationCard component

One card for comments and suggestions. Header carries the change summary
(suggestion) or quote (comment); action row is role-gated: Accept/Reject
for an editor, Withdraw for the author, Resolve/Delete for a comment.
_comments.scss renamed to _annotations.scss.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Editor hover-link groundwork (widget kept)

**Files:**
- Modify: `client/src/suggestion-editor.ts` (`suggestionDecorations` — add `data-annotation-id` to marks)
- Modify: `client/src/components/Editor.svelte` (`commentMarkerField` attr; `.cm-annotation-active` field; hover delegate)
- Test: `tests/client/src/suggestion-editor.test.ts` (assert the attribute)

**Interfaces:**
- Consumes: `activeAnnotationIds` from `../stores/annotations` (Task 3).
- Produces: every suggestion mark and comment mark carries `data-annotation-id="<rawId>"`; an `.cm-annotation-active` class appears on marks whose id is in `activeAnnotationIds`; hovering a mark sets `activeAnnotationIds` to `[thatId]` and clears on mouseout.

- [ ] **Step 1: Write the failing test**

Add to `tests/client/src/suggestion-editor.test.ts`, in the `suggestionDecorations` describe block:

```ts
  it("tags each mark with data-annotation-id", () => {
    const doc = docWith("hello world");
    recordInsertSuggestion(doc, 0, 5, "alice");
    const state = EditorState.create({ doc: doc.getText("content").toString() });
    const decos = suggestionDecorations(state, doc, VIEWER_EDITOR);
    const ids: string[] = [];
    decos.between(0, state.doc.length, (_f, _t, deco) => {
      const attrs = (deco.spec as { attributes?: Record<string, string> }).attributes;
      if (attrs?.["data-annotation-id"]) ids.push(attrs["data-annotation-id"]);
    });
    expect(ids.length).toBe(1);
    expect(ids[0]).toBe(listResolvedSuggestions(doc)[0]!.id);
  });
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run tests/client/src/suggestion-editor.test.ts -t "data-annotation-id"`
Expected: FAIL — marks have no `attributes`.

- [ ] **Step 3: Add the attribute in `suggestion-editor.ts`**

In `suggestionDecorations`, replace the `suggestionInsertMark` / `suggestionDeleteMark` module constants' use with per-range marks that carry the id. Change:

```ts
export const suggestionInsertMark = Decoration.mark({ class: "cm-suggestion-insert" });
export const suggestionDeleteMark = Decoration.mark({ class: "cm-suggestion-delete" });
```

to a factory:

```ts
const insertMark = (id: string) => Decoration.mark({ class: "cm-suggestion-insert", attributes: { "data-annotation-id": id } });
const deleteMark = (id: string) => Decoration.mark({ class: "cm-suggestion-delete", attributes: { "data-annotation-id": id } });
```

and in `suggestionDecorations`'s `.flatMap`:

```ts
    .flatMap((s) => [(s.kind === "insert" ? insertMark(s.id) : deleteMark(s.id)).range(s.from, s.to)]);
```

(the `Decoration.widget(...)` range is removed here — that is Task 6; for now just drop the widget line so this task's change is only the attribute. **Correction:** keep the widget for Task 5 so accept/reject still works. So the `.flatMap` stays two-element with the widget, only the mark changes:)

```ts
    .flatMap((s) => [
      (s.kind === "insert" ? insertMark(s.id) : deleteMark(s.id)).range(s.from, s.to),
      Decoration.widget({ widget: suggestionWidgetFor(doc, s, viewer), side: 1 }).range(s.to),
    ]);
```

Update any other reference to the removed `suggestionInsertMark` / `suggestionDeleteMark` exports (grep — `suggestion-editor.test.ts` imports them; change those tests to read the class off the produced decoration instead, which the existing "marks an insert suggestion's range" test already does via `spec.class`).

- [ ] **Step 4: Add `data-annotation-id` to comment marks in `Editor.svelte`**

In `commentMarkerField`'s `update`, change:

```ts
const mark = Decoration.mark({ class: "cm-comment-marker", id: effect.value.id });
```

to:

```ts
const mark = Decoration.mark({ class: "cm-comment-marker", id: effect.value.id, attributes: { "data-annotation-id": effect.value.id } });
```

- [ ] **Step 5: Add the `.cm-annotation-active` field + hover delegate in `Editor.svelte`**

Near the other `StateField`s, add:

```ts
import { activeAnnotationIds } from "../stores/annotations";

let activeIds: string[] = [];
const setActiveEffect = StateEffect.define<string[]>();
const activeAnnotationField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    let deco = value.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setActiveEffect)) {
        activeIds = e.value;
        // rebuild from the comment + suggestion marks currently in the doc
        const ranges: any[] = [];
        for (const field of [tr.state.field(commentMarkerField, false)]) {
          field?.between(0, tr.state.doc.length, (from, to, d) => {
            const id = (d.spec as any).attributes?.["data-annotation-id"];
            if (id && activeIds.includes(id)) ranges.push(Decoration.mark({ class: "cm-annotation-active" }).range(from, to));
          });
        }
        deco = Decoration.set(ranges, true);
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});
```

Simpler and robust — since the suggestion marks live in a different extension (`suggestion-editor.ts`), have `.cm-annotation-active` be a **CSS-only** effect instead: the hover delegate toggles a class on the mark's DOM node directly. Replace the field above with:

```ts
const annotationHoverPlugin = ViewPlugin.fromClass(
  class {
    private unsub: () => void;
    constructor(private view: EditorView) {
      const dom = view.dom;
      const over = (e: MouseEvent) => {
        const el = (e.target as HTMLElement)?.closest?.("[data-annotation-id]") as HTMLElement | null;
        activeAnnotationIds.set(el ? [el.dataset.annotationId!] : []);
      };
      const out = (e: MouseEvent) => {
        if (!(e.relatedTarget as HTMLElement)?.closest?.("[data-annotation-id]")) activeAnnotationIds.set([]);
      };
      dom.addEventListener("mouseover", over);
      dom.addEventListener("mouseout", out);
      this.unsub = activeAnnotationIds.subscribe((ids) => {
        for (const node of dom.querySelectorAll<HTMLElement>("[data-annotation-id]")) {
          node.classList.toggle("cm-annotation-active", ids.includes(node.dataset.annotationId!));
        }
      });
      this.destroy = () => {
        dom.removeEventListener("mouseover", over);
        dom.removeEventListener("mouseout", out);
        this.unsub();
      };
    }
    destroy = () => {};
  },
);
```

Add `annotationHoverPlugin` to the editor's base extensions list (next to `commentMarkerField` in the extensions array).

- [ ] **Step 6: Add the active-mark CSS to `_annotations.scss`**

```scss
.cm-annotation-active {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
  border-radius: 2px;
}
```

- [ ] **Step 7: Run the tests**

Run: `npx vitest run tests/client/src/suggestion-editor.test.ts && npm run typecheck`
Expected: PASS. Then the collab e2e (widget still present, so `suggestion-mode.spec.ts` still green):

Run: `npm run test:e2e:collab -- suggestion-mode`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add client/src/suggestion-editor.ts client/src/components/Editor.svelte client/src/styles/_annotations.scss tests/client/src/suggestion-editor.test.ts
git commit -m "$(cat <<'EOF'
feat(annotations): data-annotation-id on marks + editor hover link

Suggestion and comment marks now carry data-annotation-id; a view plugin
maps hover over a mark to the activeAnnotationIds store and toggles
.cm-annotation-active. The inline suggestion widget is unchanged (removed
in the next task, once the rail card replaces it).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: `AnnotationRail.svelte` — rename, rework, remove the inline widget

**Files:**
- Rename: `client/src/components/CommentsPanel.svelte` → `client/src/components/AnnotationRail.svelte`
- Modify: `client/src/main.ts` (import + `mount` call)
- Modify: `client/src/suggestion-editor.ts` (delete `SuggestionWidget`, `suggestionWidgetFor`; drop the widget range from `suggestionDecorations`)
- Modify: `client/src/styles/_annotations.scss` (rail canvas / connector / anchored-mode rules; rename `.comments-panel` → `.annotation-rail` keeping every existing rule)
- Modify: `tests/client/src/suggestion-editor.test.ts` (delete the `suggestionWidgetFor` / `SuggestionWidget` describe blocks and the widget-range expectations)
- Modify: `tests/e2e/collab/suggestion-mode.spec.ts` (widget assertions → rail-card assertions)

**Interfaces:**
- Consumes: `layoutCards` (T1), `railAnnotationsForShared`/`railAnnotationsForLocal`/`underlyingIds` (T2), `activeAnnotationIds` (T3), `AnnotationCard` (T4), `window.MDE.getResolvedSuggestions`/`onSuggestionsChanged` (T3), `resolveSuggestion`/`withdrawSuggestion` from `../suggestions`.
- Produces: the rail; no downstream consumers.

- [ ] **Step 1: Rename the component and update the mount**

```bash
git mv client/src/components/CommentsPanel.svelte client/src/components/AnnotationRail.svelte
```

In `client/src/main.ts`: `import AnnotationRail from "./components/AnnotationRail.svelte";` and the `mount(...)` call targets the same `#comments-panel-mount` element with `AnnotationRail`.

- [ ] **Step 2: Run the suite to see the baseline still green**

Run: `npm test`
Expected: PASS (rename only, no behaviour change yet).

- [ ] **Step 3: Delete the inline widget from `suggestion-editor.ts`**

Remove the `SuggestionWidget` class, the `suggestionWidgetFor` export, and drop the `Decoration.widget(...)` element from `suggestionDecorations`'s `.flatMap` so it returns marks only:

```ts
export function suggestionDecorations(state: EditorState, doc: Y.Doc, viewer: { viewerRole: string; viewerName: string }): DecorationSet {
  const list = listResolvedSuggestions(doc);
  const ranges = list
    .filter((s) => s.to > s.from && s.to <= state.doc.length)
    .map((s) => (s.kind === "insert" ? insertMark(s.id) : deleteMark(s.id)).range(s.from, s.to));
  return Decoration.set(ranges, true);
}
```

`viewer` is now unused by `suggestionDecorations` — keep the parameter (the field/extension signatures pass it) but prefix `_viewer` or leave it; `suggestionDecorationField` and `suggestionExtensions` keep their `viewer` params (still used for the reviewer/editor gate on interception).

- [ ] **Step 4: Update `suggestion-editor.test.ts`**

Delete the entire `describe("suggestionWidgetFor", ...)` block. In `describe("suggestionDecorations", ...)`, the "marks an insert suggestion's range" / "marks a delete suggestion's range" tests already assert only on `spec.class` — keep them; they now find exactly one decoration per suggestion instead of two. The "orders multiple decorations" test still holds. Keep the new "tags each mark with data-annotation-id" test from Task 5.

Run: `npx vitest run tests/client/src/suggestion-editor.test.ts`
Expected: PASS.

- [ ] **Step 5: Write `AnnotationRail.svelte`**

Rework the renamed component. **Keep verbatim:** `currentDocContext`, `submitDraft` + the `comment-draft-anchor` markup + `commentDraft` wiring, `submitReply`, `toggleResolve`, `removeEntry`, `jumpTo`, the `$commentsBtn` class/disabled/badge `$effect`s, the mobile `collapseSidebarForMobile` toggle in `onMount`, the `remoteCommentsChanged` refetch `$effect`, `fetchAndMergeRepoHistory`.

**Change `loadEntries()`** to build `RailAnnotation[]`:

```ts
import { railAnnotationsForShared, railAnnotationsForLocal, underlyingIds, type RailAnnotation } from "../annotations";
import { layoutCards, type CardAnchor } from "../annotation-rail-layout";
import { activeAnnotationIds } from "../stores/annotations";
import AnnotationCard from "./AnnotationCard.svelte";
import { resolveSuggestion, withdrawSuggestion } from "../suggestions";
import { viewMode, isEditorOn } from "../stores/view";

let annotations = $state<RailAnnotation[]>([]);
let placements = $state<Record<string, { top: number; clamped: "top" | "bottom" | null }>>({});
let manualList = $state(false);

const anchored = $derived(isEditorOn($viewMode) && !isMobile() && !manualList);

async function loadEntries() {
  const ctx = currentDocContext();
  if (!ctx) { annotations = []; /* keep existing empty-state resets */ return; }
  const cm = window.MDE.getEditor();
  const content = cm ? cm.state.doc.toString() : "";
  if (ctx.isShared) {
    const threads = await listComments(ctx.roomId, ctx.doc.id);
    const suggestions = window.MDE.getResolvedSuggestions?.() ?? [];
    annotations = railAnnotationsForShared(suggestions, threads, content);
    unresolvedCommentCount.set(countUnresolvedComments(threads));
  } else {
    await fetchAndMergeRepoHistory(ctx.doc);
    const fresh = getActiveDoc();
    annotations = railAnnotationsForLocal(fresh?.notes ?? [], content);
    unresolvedCommentCount.set(0);
  }
  // Keep the existing setCommentMarkers call so in-editor highlights still
  // render — feed it every annotation's anchor.
  window.MDE.setCommentMarkers?.(
    annotations.filter((a) => a.anchorTo > a.anchorFrom).flatMap((a) => underlyingIds(a).map((id) => ({ id, from: a.anchorFrom, to: a.anchorTo }))),
  );
  reposition();
}
```

Note: suggestion marks are drawn by `suggestion-editor.ts` already; `setCommentMarkers` should feed only **comment** anchors (suggestions get their highlight from the suggestion extension). Filter: `annotations.filter((a) => a.kind === "comment" && !a.orphaned)`.

**Suggestions re-derive hook:** in `onMount`, `window.MDE.onSuggestionsChanged = () => queueMicrotask(() => void loadEntries());` and clear it on destroy.

**Positioning loop:**

```ts
let rafPending = false;
function reposition() {
  if (!anchored) { placements = {}; return; }
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    const cm = window.MDE.getEditor();
    const railEl = document.querySelector(".annotation-rail-canvas") as HTMLElement | null;
    if (!cm || !railEl) return;
    const scroller = cm.scrollDOM.getBoundingClientRect();
    const railTop = railEl.getBoundingClientRect().top;
    const anchors: CardAnchor[] = annotations.map((a) => {
      const coords = cm.coordsAtPos(a.anchorFrom);
      const cardEl = railEl.querySelector<HTMLElement>(`[data-card-id="${CSS.escape(a.id)}"]`);
      const height = cardEl?.offsetHeight ?? 64;
      if (!coords || coords.top < scroller.top || coords.top > scroller.bottom) {
        return { id: a.id, anchorY: null, direction: (coords && coords.top < scroller.top) || (!coords && a.anchorFrom === 0) ? "above" : "below", height };
      }
      return { id: a.id, anchorY: coords.top - railTop, height };
    });
    const out = layoutCards(anchors, { height: railEl.clientHeight }, 8);
    placements = Object.fromEntries(out.map((p) => [p.id, { top: p.top, clamped: p.clamped }]));
  });
}

$effect(() => { $viewMode; manualList; annotations; reposition(); });

onMount(() => {
  const cm = window.MDE.getEditor();
  const onScroll = () => reposition();
  cm?.scrollDOM.addEventListener("scroll", onScroll, { passive: true });
  const ro = new ResizeObserver(() => reposition());
  if (cm) ro.observe(cm.scrollDOM);
  window.addEventListener("resize", onScroll);
  return () => {
    cm?.scrollDOM.removeEventListener("scroll", onScroll);
    ro.disconnect();
    window.removeEventListener("resize", onScroll);
  };
});
```

**Markup:** the panel keeps its header (add a list/anchored toggle button) and, below, a `.annotation-rail-canvas` that is `position: relative` in anchored mode. Each card:

```svelte
<div class="annotation-rail" class:collapsed={!$commentsPanelOpen} role="complementary" aria-label="Comments">
  <div class="annotation-rail-header">
    <h2>Comments</h2>
    <button type="button" class="secondary-btn" onclick={() => (manualList = !manualList)}>{manualList ? "Anchored" : "List"}</button>
    <button type="button" class="secondary-btn" onclick={close}>Close</button>
  </div>
  <div class="annotation-rail-canvas" class:anchored>
    {#if annotations.length === 0}
      <!-- keep the existing empty-state block -->
    {:else}
      {#each annotations as a (a.id)}
        <div
          class="annotation-rail-slot"
          data-card-id={a.id}
          style={anchored && placements[a.id] ? `position:absolute; top:${placements[a.id].top}px; left:8px; right:8px;` : ""}
        >
          {#if anchored && placements[a.id] && !placements[a.id].clamped}
            <span class="annotation-connector" style={`top:${/* anchor Y - card top */ 12}px;`}></span>
          {/if}
          <AnnotationCard
            annotation={a}
            viewer={{ role: currentRole(), name: window.MDE.githubUsername ?? "" }}
            focused={focusedId === a.id}
            onFocus={() => (focusedId = a.id)}
            onJump={() => jumpTo({ from: a.anchorFrom, to: a.anchorTo })}
            onAccept={() => underlyingIds(a).forEach((id) => resolveSuggestion(activeYDoc(), id, "accept"))}
            onReject={() => underlyingIds(a).forEach((id) => resolveSuggestion(activeYDoc(), id, "reject"))}
            onWithdraw={() => underlyingIds(a).forEach((id) => withdrawSuggestion(activeYDoc(), id))}
            onResolve={(r) => toggleResolveById(a.id, r)}
            onDelete={() => removeEntryById(a.id)}
            onReply={(body) => submitReplyById(a.id, body)}
          />
        </div>
      {/each}
    {/if}
  </div>
</div>
```

Helpers: `activeYDoc()` — a new tiny `window.MDE` accessor returning the active binding's `ydoc`, OR reuse `getResolvedSuggestions`' binding by adding `window.MDE.getActiveYDoc?()`; simplest is a new bridge accessor `getActiveYDoc?(): Y.Doc | null` set in `collab.ts` `init()` next to `getResolvedSuggestions`. `currentRole()` — read from `stores/collabMode`'s `collabRole` (import `collabRole` and `get` it). `toggleResolveById` / `removeEntryById` / `submitReplyById` — thin wrappers finding the thread by id and calling the existing `toggleResolve` / `removeEntry` / `submitReply` with it.

Wire hover the other way: `$effect(() => { activeAnnotationIds; })` already drives editor marks; add `onmouseenter` on `.annotation-rail-slot` → `activeAnnotationIds.set(underlyingIds(a))` and `onmouseleave` → `activeAnnotationIds.set([])`, and on `onJump` also `cm.dispatch({ effects: EditorView.scrollIntoView(a.anchorFrom, { y: "center" }) })`.

**Add `getActiveYDoc` to the bridge** (`types.ts` + `collab.ts` init): `window.MDE.getActiveYDoc = () => activeBinding()?.ydoc ?? null;` and `getActiveYDoc?(): import("yjs").Doc | null;` in `MDEBridge`.

- [ ] **Step 6: Rework `_annotations.scss` rail rules**

Rename every `.comments-panel*` selector to `.annotation-rail*` (keep every property — grid-area, width 320, the `transform: translateX(100%)` + `margin-right: -320px` collapse, the `@media (max-width: 780px)` bottom-sheet block, `#comments-panel-mount { display: contents }`). Add:

```scss
.annotation-rail-canvas { flex: 1; overflow-y: auto; padding: 12px 0; }
.annotation-rail-canvas.anchored { position: relative; overflow: hidden; padding: 0; }
.annotation-rail-slot { margin: 0 8px 10px; }
.annotation-rail-canvas.anchored .annotation-rail-slot { margin: 0; transition: top 0.12s ease; }
.annotation-connector { position: absolute; left: -8px; width: 8px; height: 1px; background: var(--border); }
.annotation-rail-header { /* copy .comments-panel-header rules */ }
```

- [ ] **Step 7: Run everything**

```bash
npm test
npm run typecheck
npm run format:check
npm run build
```
Expected: all PASS. Fix any `Note` / token / import mismatches surfaced here.

- [ ] **Step 8: Update the collab e2e**

In `tests/e2e/collab/suggestion-mode.spec.ts`: replace assertions that target the inline widget (`.cm-suggestion-card`, its buttons) with the rail equivalent — after a reviewer types, `expect(page.locator('.annotation-rail .annotation-card.suggestion')).toBeVisible()`; the editor clicks `.annotation-card [data-act="accept"]`; assert `page.locator('#editor-mount .cm-suggestion-card')` count is `0`. Keep every non-widget assertion (text convergence, viewer preview-only).

Run: `npm run test:e2e:collab -- suggestion-mode`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat(annotations): the annotation rail replaces the comments panel

CommentsPanel -> AnnotationRail. Comments and suggestions both render as
AnnotationCards, anchored to their line via coordsAtPos + layoutCards on
a rAF scroll loop (list fallback for preview-only / mobile / the header
toggle). The inline suggestion widget is deleted; accept/reject/withdraw
move to the card. Draft box, repo-history, mobile sheet moved verbatim.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: New end-to-end specs

**Files:**
- Create: `tests/e2e/local/annotation-rail.spec.ts`
- Create: `tests/e2e/collab/suggestion-rail.spec.ts`

**Interfaces:** none (tests only).

- [ ] **Step 1: Write the local e2e**

Create `tests/e2e/local/annotation-rail.spec.ts`:

```ts
import { test, expect } from "./support/fixtures";

test.describe("annotation rail — local document", () => {
  test("comments render as anchored cards that follow the editor scroll and toggle to a list", async ({ page }) => {
    await page.waitForSelector("#editor-mount .cm-content", { state: "visible" });
    await page.click("#editor-mount .cm-content");
    await page.evaluate(() => {
      const cm = window.MDE.getEditor();
      cm.dispatch({ changes: { from: 0, to: cm.state.doc.length, insert: "First line here.\n" + "\n".repeat(40) + "Much later line here.\n" } });
    });
    // add a comment on the first line
    await page.evaluate(() => {
      const cm = window.MDE.getEditor();
      cm.dispatch({ selection: { anchor: 0, head: 10 } });
    });
    await page.click('.comment-add-btn');
    await page.fill('.comment-draft-box textarea', "top note");
    await page.click('.comment-draft-box .primary-btn');

    const card = page.locator('.annotation-rail .annotation-card').first();
    await expect(card).toBeVisible();
    const topBefore = await card.evaluate((el) => (el.closest('.annotation-rail-slot') as HTMLElement).style.top);

    await page.locator('#editor-mount .cm-scroller').evaluate((el) => (el.scrollTop = 400));
    await page.waitForTimeout(100);
    const topAfter = await card.evaluate((el) => (el.closest('.annotation-rail-slot') as HTMLElement).style.top);
    expect(topAfter).not.toBe(topBefore);

    await page.click('.annotation-rail-header button:has-text("List")');
    await expect(page.locator('.annotation-rail-canvas:not(.anchored)')).toBeVisible();
  });
});
```

(Adjust selectors to whatever the local-doc comment flow actually exposes — the `support/fixtures` seeds a doc and signs in; check a sibling spec like `comments`-related local e2e if one exists, else `focus-mode.spec.ts` for the fixture shape.)

- [ ] **Step 2: Run it**

Run: `npm run test:e2e:local -- annotation-rail`
Expected: PASS. Iterate on selectors/timing (use `expect.poll` for the `top` change if `waitForTimeout` is flaky).

- [ ] **Step 3: Write the collab e2e**

Create `tests/e2e/collab/suggestion-rail.spec.ts` modelled on `suggestion-mode.spec.ts`'s two-context setup:

```ts
import { test, expect } from "@playwright/test";
// ...reuse suggestion-mode.spec.ts's helpers for signing in two contexts,
// sharing a workspace, and putting one side into Suggesting mode...

test("a reviewer's suggestion appears as an anchored rail card the editor accepts", async ({ browser }) => {
  // reviewer types "really " into a shared doc while in Suggesting mode
  // editor context:
  await expect(editor.locator('.annotation-rail .annotation-card.suggestion')).toBeVisible();
  await expect(editor.locator('.annotation-rail .annotation-card.suggestion')).toContainText("really");
  expect(await editor.locator('#editor-mount .cm-suggestion-card').count()).toBe(0);
  await editor.locator('.annotation-card.suggestion [data-act="accept"]').click();
  await expect.poll(() => reviewer.evaluate(() => window.MDE.getEditor().state.doc.toString())).toContain("really ");
  // hover-link
  await editor.locator('.cm-suggestion-insert').first().hover();
  await expect(editor.locator('.annotation-card.suggestion.focused, .annotation-card.suggestion')).toBeVisible();
});
```

- [ ] **Step 4: Run it**

Run: `npm run test:e2e:collab -- suggestion-rail`
Expected: PASS.

- [ ] **Step 5: Full e2e sweep + commit**

```bash
npm run test:e2e:local
npm run test:e2e:collab
```
Expected: all PASS (including the updated `suggestion-mode.spec.ts`).

```bash
git add tests/e2e/local/annotation-rail.spec.ts tests/e2e/collab/suggestion-rail.spec.ts
git commit -m "$(cat <<'EOF'
test(annotations): e2e for the anchored rail + suggestion cards

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Release 1.61.0

**Files:**
- Modify: `package.json`, `package-lock.json`
- Modify: `CHANGELOG.md`
- Modify: `client/src/whats-new-entries.ts`
- Create: `client/public/whats-new/annotation-rail.png`
- Create: `tests/scripts/manual-testing/capture-annotation-rail-screenshot.mjs`
- Modify: `docs/TEST-COVERAGE.md`
- Modify: `ROADMAP.md`
- Modify: `docs/superpowers/specs/2026-08-31-suggestion-mode-collaboration-design.md` (a pointer note — optional)

**Interfaces:** none.

- [ ] **Step 1: Bump the version**

`package.json`: `"version": "1.60.4"` → `"1.61.0"`. `package-lock.json` lines 3 and 9 likewise. Do not regenerate the lockfile.

- [ ] **Step 2: CHANGELOG**

Insert above `## [1.60.4] - 2026-09-09`:

```markdown
## [1.61.0] - 2026-09-09

### Changed

- Comments and suggestions now share one right-margin panel, with each card lined up next to the text it refers to instead of suggestions appearing inline in the document. A plain list view is still one click away from the panel header, and on narrow screens the panel stays a bottom sheet. Accepting or rejecting a suggestion now happens on its card.
```

- [ ] **Step 3: Write the screenshot capture script**

Create `tests/scripts/manual-testing/capture-annotation-rail-screenshot.mjs` modelled on `capture-suggestion-mode-screenshot.mjs`: sign in an owner + a reviewer, share a workspace, reviewer adds a suggestion and the owner adds a comment on a different line, screenshot the owner's window with the rail open showing both anchored cards. Output `client/public/whats-new/annotation-rail.png`, viewport `1280×800`.

- [ ] **Step 4: Capture the screenshot**

```bash
bash tests/scripts/manual-testing/enable-dev-login.sh
npm run build
npx wrangler dev --local-upstream localhost:8787 &
# wait for :8787
node tests/scripts/manual-testing/capture-annotation-rail-screenshot.mjs
kill %1; lsof -ti:8787 | xargs -r kill -9
bash tests/scripts/manual-testing/disable-dev-login.sh
```
Verify `client/public/whats-new/annotation-rail.png` exists and shows the anchored rail with a comment card and a suggestion card. **Do not proceed with a missing or placeholder image** (`CLAUDE.md`).

- [ ] **Step 5: What's New entry**

Append to `WHATS_NEW_ENTRIES` in `client/src/whats-new-entries.ts`:

```ts
  {
    version: "1.61.0",
    title: "Comments and Suggestions, Side by Side",
    description:
      "Comments and tracked-change suggestions now live in one panel on the right, each card pinned next to the line it's about — no more suggestion cards wedged into the middle of your text. Switch to a plain list from the panel header any time; accept or reject a suggestion right on its card.",
    screenshot: "/whats-new/annotation-rail.png",
    category: "Collaboration",
  },
```

- [ ] **Step 6: TEST-COVERAGE + ROADMAP**

`docs/TEST-COVERAGE.md`: update `COLLAB-07` (drop "delete is blocked + recorded" widget phrasing → keep the D2 line; note marks carry `data-annotation-id`), replace `COLLAB-08`'s "Suggestion widget renders…" with "AnnotationCard renders comment/suggestion/replace variants with role-gated actions — `tests/client/src/components/AnnotationCard.test.ts`", and add rows: `annotation-rail-layout` (`tests/client/src/annotation-rail-layout.test.ts`), `annotations` adapter (`tests/client/src/annotations.test.ts`), the anchored-rail local e2e (`tests/e2e/local/annotation-rail.spec.ts`), the suggestion-rail collab e2e (`tests/e2e/collab/suggestion-rail.spec.ts`).

`ROADMAP.md` Group D block: mark **D1** and the visual half of **D5** shipped v1.61.0 (spec `docs/superpowers/specs/2026-09-09-annotation-rail-design.md`, plan `.../plans/2026-09-09-annotation-rail.md`). Note SP-B (D3 + storage) and SP-C (D4) still pending. Add the spec's Non-goals to the Deferred considerations list.

- [ ] **Step 7: Full verification**

```bash
npm run build && npm test && npm run typecheck && npm run format:check
```
Expected: all PASS. `WhatsNew.svelte`'s dev warning now matches `1.61.0` — no warning.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
chore: release 1.61.0 — annotation rail

CHANGELOG ### Changed + a What's New entry with a captured screenshot.
TEST-COVERAGE and ROADMAP (Group D: D1 + visual D5 shipped) updated.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**1. Spec coverage**

| Spec section | Task |
|---|---|
| Part 1 — `annotations.ts` adapter, `RailAnnotation`, replace grouping | Task 2 |
| Part 2 — `annotation-rail-layout.ts` `layoutCards` | Task 1 |
| Part 3 — `AnnotationCard.svelte` (variants, role-gated actions, focused expand) | Task 4 |
| Part 4 — `AnnotationRail.svelte` (rename, anchored/list mode, positioning loop, connectors, kept draft/repo/mobile logic, mode toggle, `activeAnnotationId` link) | Task 6 (+ store in Task 3) |
| Part 5 — `suggestion-editor.ts` widget removal + `data-annotation-id`; `Editor.svelte` comment-mark attr, active field, hover delegate; `types.ts` bridge; `collab.ts` observer | Tasks 3 (bridge/observer), 5 (attr + hover, widget kept), 6 (widget removal) |
| Part 6 — unit (layout, adapter), component (card), e2e local + collab, regression (suggestion-editor tests, suggestion-mode.spec) | Tasks 1, 2, 4, 7; regression in 5 & 6 |
| Part 7 — 1.61.0, CHANGELOG, whats-new + screenshot, TEST-COVERAGE, ROADMAP, deferred list | Task 8 |

No gaps. (`_comments.scss` → `_annotations.scss` rename + `style.scss` `@use` — Task 4 Step 3. `main.ts` import — Task 6 Step 1.)

**2. Placeholder scan** — the Editor.svelte hover-plugin and the `AnnotationRail` markup carry real code; the `_annotations.scss` "copy .comments-panel-header rules" and "rename every .comments-panel* selector" are mechanical rename instructions, not placeholders (the rules already exist in the file being renamed). The screenshot script (Task 8 Step 3) points at a concrete sibling script to model on rather than inlining ~60 lines of Playwright setup — acceptable for a manual one-off, but the executor should copy that file and adapt it.

**3. Type consistency** — `RailAnnotation` fields (`id`, `kind`, `author`, `createdAt`, `anchorFrom`, `anchorTo`, `quote?`, `resolved?`, `orphaned?`, `replies?`, `changeKind?`, `changeText?`, `replacedText?`, `groupedIds?`) identical in Task 2's Produces block, the module, its test, `AnnotationCard`'s prop type (Task 4), and `AnnotationRail`'s import (Task 6). `underlyingIds(a)` used in Tasks 2, 5-context, 6. `CardAnchor` / `CardPlacement` / `layoutCards` identical in Task 1 and Task 6's `reposition()`. `activeAnnotationIds: Writable<string[]>` in Task 3, consumed in Tasks 5 and 6. `window.MDE.getResolvedSuggestions` / `onSuggestionsChanged` / `getActiveYDoc` declared in Task 3 (first two) and Task 6 (third) and consumed in Task 6.

**Fix applied during review:** Task 6 introduces `window.MDE.getActiveYDoc` — added to its file list and to the `types.ts` change there; it belongs with the other bridge accessors from Task 3, but since only Task 6 consumes it, declaring it in Task 6 keeps the tasks independently reviewable.
