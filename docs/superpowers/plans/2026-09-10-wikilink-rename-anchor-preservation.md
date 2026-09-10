# Wikilink-rename Anchor Preservation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite `[[Old]]` → `[[New]]` in a shared document's live Yjs text with targeted in-place splices so comment / suggestion anchors elsewhere in the doc survive the rename.

**Architecture:** `WorkspaceRoom.handleWikilinkRenameRequest` currently does `text.delete(0, text.length); text.insert(0, rewritten)`, which tombstones every character item and collapses every Yjs relative position in the doc's `comments` / `suggestions` maps. Replace it with: compute each `[[oldName]]` occurrence's character range (a new `findWikilinkOccurrences` in the Worker's `src/wikilink-rewrite.ts`, copied verbatim from the client's), then splice each occurrence back-to-front inside the one `"wikilink-rename"` transaction. Relative positions anchored outside a touched span are physically untouched. This mirrors what `applyWikilinkRenameToActiveDoc` already does client-side for the renamed doc.

**Tech Stack:** TypeScript, Cloudflare Workers, Yjs (`Y.Text`, relative positions), Vitest (`unit` project, Node env, `tests/src/**` full-strict with `noUncheckedIndexedAccess`).

**Spec:** `docs/superpowers/specs/2026-09-10-wikilink-rename-anchor-preservation-design.md`

## Global Constraints

- `src/wikilink-rewrite.ts` and `src/markdown-code.ts` are hand-synced verbatim mirrors of `client/src/wikilink-rewrite.ts` / `client/src/markdown-code.ts`. New code added to the Worker copy must be byte-identical to the client copy (the client already has `findWikilinkOccurrences`).
- `tests/src/**` runs under the root `tsconfig.json`: full strict + `noUncheckedIndexedAccess`. Index into an array or a possibly-empty match only with a `!` assertion or an explicit guard (existing tests use `occurrences[0]!`).
- Behind-the-scenes fix (a bug is gone, no new user-facing surface) → **patch** version bump, `CHANGELOG.md` `### Fixed` entry, **no** `client/src/whats-new-entries.ts` entry.
- Do the `package.json` + `package-lock.json` version bump (hand-edit both `"version"` fields in the lockfile — its line 3 and line 9) as the **last step before opening the PR**, not before.
- Never append a `Claude-Session:` link to a commit message or PR body. Commit trailer: `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`. PR body ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- `check-no-dev-login.mjs` scans `src/**/*.ts` for `/api/dev/login` / `DEV_LOGIN_PATH` — keep clean (this change adds none).
- Branch: `fix/wikilink-rename-anchor-preserve` (already created off `master`, spec already committed on it).
- Full verification before the PR: `npm test`, `npx vitest run --project=components`, `npm run typecheck`, `npm run build`, `npm run format:check`, `npm run check:no-dev-login`.

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `src/wikilink-rewrite.ts` | Modify | Add `WikilinkOccurrence` interface + `findWikilinkOccurrences(content, name)` — verbatim copy of the client's. Widen the `./markdown-code` import to bring in `codeSegmentRanges`, `isInsideCode`. Refresh the header comment. |
| `tests/src/wikilink-rewrite.test.ts` | Modify | Add a `describe("findWikilinkOccurrences (Worker copy)")` block mirroring the client's occurrence tests. |
| `src/workspace-room.ts` | Modify | Line 9 import: `rewriteWikilinkReferences` → `findWikilinkOccurrences`. `handleWikilinkRenameRequest` body: replace the whole-text delete+insert with a back-to-front per-occurrence splice loop. |
| `tests/src/workspace-room.test.ts` | Modify | Add `import { rewriteWikilinkReferences } from "../../src/wikilink-rewrite";`. In `describe("WorkspaceRoom.handleWikilinkRenameRequest")` add: anchor-preservation regression test, splice-equals-oracle test, single-transaction multi-occurrence test. |
| `CHANGELOG.md` | Modify | New `## [1.62.12]` `### Fixed` section (provisional heading; version bump lands in the final task). |
| `docs/TEST-COVERAGE.md` | Modify | COLLAB-38 row: note the targeted splice + anchor preservation. |
| `ROADMAP.md` | Modify | Group D "Security follow-ups" — change the trailing "Deferred: a live wikilink rename still does a wholesale `ytext` replace…" note to a shipped note. |
| `package.json`, `package-lock.json` | Modify | `1.62.11` → `1.62.12` (final task only). |

---

## Task 1: Worker-side `findWikilinkOccurrences`

**Files:**
- Modify: `src/wikilink-rewrite.ts`
- Test: `tests/src/wikilink-rewrite.test.ts`

**Interfaces:**
- Consumes: `codeSegmentRanges(text: string): Array<{ from: number; to: number }>` and `isInsideCode(ranges, from, to): boolean` — both already exported by `src/markdown-code.ts`.
- Produces:
  - `interface WikilinkOccurrence { from: number; to: number }`
  - `findWikilinkOccurrences(content: string, name: string): WikilinkOccurrence[]` — every exact-match `[[name]]` char range in `content`, ascending by `from`, occurrences inside a code span / fence skipped. Returns `[]` when `name` never appears out of code.

- [ ] **Step 1: Write the failing tests**

Append to `tests/src/wikilink-rewrite.test.ts` (the file currently imports only `rewriteWikilinkReferences` — widen that import):

```ts
// change line 2 to:
import { rewriteWikilinkReferences, findWikilinkOccurrences } from "../../src/wikilink-rewrite";
```

Then append this block after the existing `describe`:

```ts
describe("findWikilinkOccurrences (Worker copy)", () => {
  it("returns the character range of each exact match", () => {
    const content = "See [[Old]] here";
    const occurrences = findWikilinkOccurrences(content, "Old");
    expect(occurrences).toEqual([{ from: 4, to: 11 }]);
    expect(content.slice(occurrences[0]!.from, occurrences[0]!.to)).toBe("[[Old]]");
  });

  it("returns one range per occurrence, in ascending order", () => {
    const occurrences = findWikilinkOccurrences("[[Old]] x [[Old]]", "Old");
    expect(occurrences).toHaveLength(2);
    expect(occurrences[0]!.from).toBe(0);
    expect(occurrences[1]!.from).toBe(10);
  });

  it("returns an empty array when the name doesn't appear", () => {
    expect(findWikilinkOccurrences("nothing here", "Old")).toEqual([]);
  });

  it("ignores a near-miss name", () => {
    expect(findWikilinkOccurrences("[[OldSuffix]]", "Old")).toEqual([]);
  });

  it("skips an in-code occurrence, keeps correct offsets for the rest", () => {
    const content = "`[[Old]]` x [[Old]] y";
    const occ = findWikilinkOccurrences(content, "Old");
    expect(occ).toEqual([{ from: 12, to: 19 }]);
    expect(content.slice(occ[0]!.from, occ[0]!.to)).toBe("[[Old]]");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/src/wikilink-rewrite.test.ts`
Expected: FAIL — `findWikilinkOccurrences` is not exported (`No known export ... 'findWikilinkOccurrences'` at import, or `findWikilinkOccurrences is not a function`).

- [ ] **Step 3: Add `findWikilinkOccurrences` to the Worker copy**

Edit `src/wikilink-rewrite.ts`. Replace the header comment + import line (lines 1-8) with:

```ts
// Duplicate of client/src/wikilink-rewrite.ts's rewriteWikilinkReferences
// and findWikilinkOccurrences (kept in sync by hand — same pattern as
// version-grouping.ts's two copies). The Worker uses the occurrence
// ranges to splice each [[oldName]] -> [[newName]] in place
// (workspace-room.ts's handleWikilinkRenameRequest) rather than a
// whole-text replace, so comment / suggestion anchors survive a rename.
// The code-awareness helpers come from ./markdown-code (also a
// hand-synced Worker copy).
import { codeSegmentRanges, isInsideCode, replaceOutsideCode } from "./markdown-code";
```

Leave `WIKILINK_RE` and `rewriteWikilinkReferences` exactly as they are. Append at the end of the file — this block (from `export interface` onward) must be **byte-identical** to the tail of `client/src/wikilink-rewrite.ts`, comment included:

```ts

export interface WikilinkOccurrence {
  from: number;
  to: number;
}

// Every exact-match occurrence's character range in `content`, for a
// live CodeMirror edit (see app.ts's applyWikilinkRenameToActiveDoc).
// Occurrences inside a code span / fence are skipped, matching
// rewriteWikilinkReferences.
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

The comment mentions `app.ts` (a client file) — that is deliberate: the two copies are kept verbatim, and the existing `version-grouping.ts` / `markdown-code.ts` mirrors do the same. Only the file header comment differs between the two copies (it already did before this change).

- [ ] **Step 4: Verify byte-parity with the client copy**

Run: `diff <(sed -n '/^export interface WikilinkOccurrence/,$p' client/src/wikilink-rewrite.ts) <(sed -n '/^export interface WikilinkOccurrence/,$p' src/wikilink-rewrite.ts)`
Expected: no output (the interface + function are identical between the two files). If it differs, make `src/wikilink-rewrite.ts`'s copy match `client/src/wikilink-rewrite.ts` exactly.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/src/wikilink-rewrite.test.ts`
Expected: PASS (all — the 5 existing `rewriteWikilinkReferences` cases plus the 5 new `findWikilinkOccurrences` cases).

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: `tsc --noEmit` clean (no unused-import error — `replaceOutsideCode` is still used by `rewriteWikilinkReferences`; `codeSegmentRanges` / `isInsideCode` now used by `findWikilinkOccurrences`). svelte-check clean (client file already had this code; unchanged).

- [ ] **Step 7: Commit**

```bash
git add src/wikilink-rewrite.ts tests/src/wikilink-rewrite.test.ts
git commit -m "feat: add findWikilinkOccurrences to the Worker wikilink-rewrite copy

Mirrors client/src/wikilink-rewrite.ts. The wikilink-rename endpoint
will use the occurrence ranges to splice in place instead of replacing
the whole text.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 2: Targeted-splice rewrite in `handleWikilinkRenameRequest`

**Files:**
- Modify: `src/workspace-room.ts` (line 9 import; `handleWikilinkRenameRequest`, currently lines ~1432-1459)
- Test: `tests/src/workspace-room.test.ts` (`describe("WorkspaceRoom.handleWikilinkRenameRequest")`, currently lines ~1158-1261)

**Interfaces:**
- Consumes from Task 1: `findWikilinkOccurrences(content: string, name: string): WikilinkOccurrence[]` from `./wikilink-rewrite`.
- Consumes (existing test helpers, already imported in `tests/src/workspace-room.test.ts`): `createCommentThread(doc, from, to, quote, author, body, now?)` and `listResolvedCommentThreads(doc, content?)` from `../../src/comments-doc`; `recordDeleteSuggestion(doc, from, to, author, now?)` and `listResolvedSuggestions(doc)` from `../../src/suggestions`. Called with NO `content` arg to `listResolvedCommentThreads` so resolution is purely from the stored relative positions (no quote-fallback relocation) — that is what proves the anchors themselves tracked the splice.
- Consumes (existing test helpers): `fakeState()`, `fakeEnvWithSecret`, `encryptSession(env, {token, username})`.
- Produces: no new exported surface. `handleWikilinkRenameRequest` keeps its `{ changed: boolean }` response contract and all status codes (200 / 400 / 401 / 403 / 405).

- [ ] **Step 1: Write the failing anchor-preservation regression test**

In `tests/src/workspace-room.test.ts`, add to the top-of-file imports:

```ts
import { rewriteWikilinkReferences } from "../../src/wikilink-rewrite";
```

Add these three tests inside `describe("WorkspaceRoom.handleWikilinkRenameRequest", () => { ... })`, after the existing `it("returns changed: false and doesn't transact when the name isn't present", ...)`:

```ts
  it("preserves comment + suggestion anchors when it rewrites a link (targeted splice, not whole-text replace)", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnvWithSecret);
    await room.state.storage.put("access", { owner: "alice", generalAccess: "restricted", requireAccount: false, role: "viewer", invited: [] });
    const docRoom = await room.loadDocRoom("docA");
    // indices:            0123 4  5678 9 10        17......24
    docRoom.doc.transact(() => docRoom.doc.getText("content").insert(0, "see [[Old]] then flagword end"), "storage");
    // "flagword" is [17, 25); anchor a comment and a delete-suggestion on it.
    createCommentThread(docRoom.doc, 17, 25, "flagword", "alice", "note", 1);
    recordDeleteSuggestion(docRoom.doc, 17, 25, "carol", 1);

    const cookie = await encryptSession(fakeEnvWithSecret, { token: "gh-token", username: "alice" });
    const request = new Request("https://example.com/w/ws1/docs/docA/wikilink-rename", {
      method: "POST",
      headers: { Cookie: `mde_gh_session=${cookie}`, "Content-Type": "application/json" },
      body: JSON.stringify({ oldName: "Old", newName: "Newer" }),
    });
    const res = await room.handleWikilinkRenameRequest(request, "docA");
    expect(res.status).toBe(200);

    // [[Old]] (7 chars) -> [[Newer]] (9 chars): everything after shifts +2.
    expect(docRoom.doc.getText("content").toString()).toBe("see [[Newer]] then flagword end");

    // Resolve from the stored relative positions alone (no `content` arg /
    // quote fallback) — proof the positions tracked the splice instead of
    // collapsing.
    const threads = listResolvedCommentThreads(docRoom.doc);
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({ from: 19, to: 27 });

    const suggestions = listResolvedSuggestions(docRoom.doc);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({ from: 19, to: 27, kind: "delete" });
  });

  it("produces exactly the text rewriteWikilinkReferences would, in-code occurrences left alone", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnvWithSecret);
    await room.state.storage.put("access", { owner: "alice", generalAccess: "restricted", requireAccount: false, role: "viewer", invited: [] });
    const docRoom = await room.loadDocRoom("docA");
    const before = "start [[Old]] mid `[[Old]]` and [[Old]] end";
    docRoom.doc.transact(() => docRoom.doc.getText("content").insert(0, before), "storage");
    const cookie = await encryptSession(fakeEnvWithSecret, { token: "gh-token", username: "alice" });
    const request = new Request("https://example.com/w/ws1/docs/docA/wikilink-rename", {
      method: "POST",
      headers: { Cookie: `mde_gh_session=${cookie}`, "Content-Type": "application/json" },
      body: JSON.stringify({ oldName: "Old", newName: "Newer" }),
    });
    await room.handleWikilinkRenameRequest(request, "docA");
    const after = docRoom.doc.getText("content").toString();
    expect(after).toBe(rewriteWikilinkReferences(before, "Old", "Newer"));
    expect(after).toBe("start [[Newer]] mid `[[Old]]` and [[Newer]] end");
  });

  it("rewrites every occurrence in a single transaction", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnvWithSecret);
    await room.state.storage.put("access", { owner: "alice", generalAccess: "restricted", requireAccount: false, role: "viewer", invited: [] });
    const docRoom = await room.loadDocRoom("docA");
    docRoom.doc.transact(() => docRoom.doc.getText("content").insert(0, "[[Old]] a [[Old]] b [[Old]]"), "storage");
    let updates = 0;
    docRoom.doc.on("update", () => {
      updates++;
    });
    const cookie = await encryptSession(fakeEnvWithSecret, { token: "gh-token", username: "alice" });
    const request = new Request("https://example.com/w/ws1/docs/docA/wikilink-rename", {
      method: "POST",
      headers: { Cookie: `mde_gh_session=${cookie}`, "Content-Type": "application/json" },
      body: JSON.stringify({ oldName: "Old", newName: "New" }),
    });
    await room.handleWikilinkRenameRequest(request, "docA");
    expect(docRoom.doc.getText("content").toString()).toBe("[[New]] a [[New]] b [[New]]");
    expect(updates).toBe(1);
  });
```

- [ ] **Step 2: Run the new tests to verify they fail correctly**

Run: `npx vitest run tests/src/workspace-room.test.ts -t "handleWikilinkRenameRequest"`
Expected:
- `preserves comment + suggestion anchors …` — **FAILS**: the current whole-text `delete(0,len)+insert` tombstones every item, so `listResolvedCommentThreads` / `listResolvedSuggestions` return `[]` (anchor resolves to `null` and is dropped) or resolve to `{from: 0, to: 0}`. Either way the `toHaveLength(1)` / `toMatchObject({ from: 19, to: 27 })` assertions fail.
- `produces exactly the text rewriteWikilinkReferences would …` — PASSES already (current code calls `rewriteWikilinkReferences`), keep it as a guard.
- `rewrites every occurrence in a single transaction` — PASSES already, keep it as a guard.

(If the first test errors instead of asserting — e.g. a helper name is wrong — fix the test before proceeding.)

- [ ] **Step 3: Swap the import**

In `src/workspace-room.ts` line 9, change:

```ts
import { rewriteWikilinkReferences } from "./wikilink-rewrite";
```

to:

```ts
import { findWikilinkOccurrences } from "./wikilink-rewrite";
```

(`rewriteWikilinkReferences` has no other use in `src/workspace-room.ts` — confirm with `grep -n rewriteWikilinkReferences src/workspace-room.ts` returning nothing after the edit.)

- [ ] **Step 4: Replace the wholesale replace with a splice loop**

In `handleWikilinkRenameRequest`, replace this block:

```ts
    const docRoom = await this.loadDocRoom(docId);
    const text = docRoom.doc.getText("content");
    const current = text.toString();
    const rewritten = rewriteWikilinkReferences(current, oldName, newName);
    if (rewritten === current) return Response.json({ changed: false });

    docRoom.doc.transact(() => {
      text.delete(0, text.length);
      text.insert(0, rewritten);
    }, "wikilink-rename");
    return Response.json({ changed: true });
```

with:

```ts
    const docRoom = await this.loadDocRoom(docId);
    const text = docRoom.doc.getText("content");
    const occurrences = findWikilinkOccurrences(text.toString(), oldName);
    if (occurrences.length === 0) return Response.json({ changed: false });

    const replacement = `[[${newName}]]`;
    docRoom.doc.transact(() => {
      // Splice each [[oldName]] -> [[newName]] in place, back to front so
      // an earlier occurrence's offset stays valid while we edit later
      // ones. The previous whole-text delete+reinsert tombstoned every
      // character item, collapsing every comment / suggestion anchor in
      // the doc; a targeted splice leaves every relative position
      // anchored outside a [[oldName]] span physically untouched.
      for (let i = occurrences.length - 1; i >= 0; i--) {
        const o = occurrences[i]!;
        text.delete(o.from, o.to - o.from);
        text.insert(o.from, replacement);
      }
    }, "wikilink-rename");
    return Response.json({ changed: true });
```

The leading doc-comment on `handleWikilinkRenameRequest` (the paragraph starting "Rewrites `[[oldName]]` -> `[[newName]]` wherever it appears…") stays accurate — no edit needed there.

- [ ] **Step 5: Run the full `handleWikilinkRenameRequest` describe block**

Run: `npx vitest run tests/src/workspace-room.test.ts -t "handleWikilinkRenameRequest"`
Expected: PASS — all of them:
- new: `preserves comment + suggestion anchors …`, `produces exactly the text …`, `rewrites every occurrence in a single transaction`
- existing: no-session 401, non-editor 403, missing names 400, `rewrites the room's live content and returns changed: true`, `leaves a [[Old]] inside a code span untouched`, `returns changed: false and doesn't transact when the name isn't present`.

- [ ] **Step 6: Run the whole `unit` project**

Run: `npm test`
Expected: all pass (was `117 files / ~1298 tests` on `master` at v1.62.11 — this adds tests, breaks none). Pay attention to any other `workspace-room.test.ts` suite (reviewer-integrity, comments) — a splice edit under `"wikilink-rename"` origin does not touch the `suggestions` / `comments` maps and its origin maps to no session, so neither observer reconciles it.

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add src/workspace-room.ts tests/src/workspace-room.test.ts
git commit -m "fix: wikilink-rename splices in place, preserving comment/suggestion anchors

handleWikilinkRenameRequest replaced the whole Y.Text (delete 0..len +
reinsert) on every rename, tombstoning every character item and
collapsing every comment / suggestion anchor in the affected shared
doc. Now it computes each [[oldName]] occurrence range and splices each
one back-to-front in the same transaction, so relative positions
anchored outside a touched span are untouched — matching what the
client already does for the renamed doc itself.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 3: Docs, verification, version bump, PR

**Files:**
- Modify: `CHANGELOG.md`, `docs/TEST-COVERAGE.md`, `ROADMAP.md`
- Modify (last): `package.json`, `package-lock.json`

**Interfaces:** none — documentation + release mechanics.

- [ ] **Step 1: CHANGELOG entry (provisional heading)**

In `CHANGELOG.md`, add above the current top section (`## [1.62.11] - 2026-09-10`):

```markdown
## [1.62.12] - 2026-09-10

### Fixed

- Renaming a shared document no longer drops the comments and tracked-change suggestions in the *other* shared documents that link to it. The server rewrites each `[[Old Name]]` reference in place now, instead of replacing the whole document body — so anchors elsewhere in those documents stay put.
```

- [ ] **Step 2: Update TEST-COVERAGE COLLAB-38**

In `docs/TEST-COVERAGE.md`, replace the COLLAB-38 row:

```
| COLLAB-38 | `handleWikilinkRenameRequest` rejects no-session / non-editor / missing names, rewrites live content, returns `changed` accurately | integration | covered | `tests/src/workspace-room.test.ts` | cross-ref §3                                                           |
```

with:

```
| COLLAB-38 | `handleWikilinkRenameRequest` rejects no-session / non-editor / missing names, rewrites live content, returns `changed` accurately; rewrites each `[[Old]]` occurrence as a targeted in-place splice (back-to-front, one `"wikilink-rename"` transaction) so comment / suggestion anchors elsewhere in the doc survive — the whole-text delete+reinsert that collapsed them is gone (v1.62.12); result is byte-identical to `rewriteWikilinkReferences` | integration | covered | `tests/src/workspace-room.test.ts`, `tests/src/wikilink-rewrite.test.ts` | cross-ref §3 |
```

Then bump the section 10 count and the total in the summary table near the top of the file (`## Baseline` area): find the `| 10. Workspace collab | 69 | 0 | 0 | 69 |` row → `70 / 70`, and `| **Total** | **339** | ... | **339** |` → `340 / 340`. (One net-new integration scenario folded into COLLAB-38's existing row is still one row; if the existing curated tally counts scenarios rather than rows, keep the increment at +1 for the anchor-preservation scenario. Match whatever convention the surrounding rows use — these counts are hand-maintained.)

- [ ] **Step 3: Update ROADMAP Group D note**

In `ROADMAP.md`, in the "Security follow-ups" paragraph, replace:

```
 both closed in **v1.62.11**. Deferred: a live wikilink
  rename still does a wholesale `ytext` replace that collapses any
  annotation anchor in the renamed doc — a real CRDT change, its own
  follow-up.
```

with:

```
 both closed in **v1.62.11**. The run-7 follow-up — a live
  wikilink rename replaced the whole `ytext` of every backlinking shared
  doc, collapsing their comment / suggestion anchors — shipped in
  **v1.62.12**: the server splices each `[[Old]]` occurrence in place
  now (spec `2026-09-10-wikilink-rename-anchor-preservation`).
```

Run `npm run format` afterwards if the prose rewrap needs it; re-check the diff is scoped to this paragraph.

- [ ] **Step 4: Commit the docs**

```bash
git add CHANGELOG.md docs/TEST-COVERAGE.md ROADMAP.md
git commit -m "docs: changelog + coverage + roadmap for wikilink-rename anchor fix

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

- [ ] **Step 5: Full verification**

Run each, expect all green:

```bash
npm test
npx vitest run --project=components
npm run typecheck
npm run build
npm run format:check
npm run check:no-dev-login
```

If `format:check` fails, run `npm run format`, re-inspect the diff, and fold the formatting into the docs commit (`git commit --amend --no-edit` is fine — the branch is unmerged) or a follow-up `style:` commit.

- [ ] **Step 6: Version bump (last step before the PR)**

- `package.json`: `"version": "1.62.11"` → `"version": "1.62.12"`.
- `package-lock.json`: the two top `"version": "1.62.11"` fields (line 3, and line ~9 inside the root `""` package entry) → `"1.62.12"`. Hand-edit both; do not regenerate the lockfile.

Verify: `grep -n '"version": "1.62.1' package.json package-lock.json` shows `1.62.12` in all three spots.

```bash
git add package.json package-lock.json
git commit -m "chore: release 1.62.12 — wikilink-rename anchor preservation

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

- [ ] **Step 7: Push and open the PR**

```bash
git push -u origin fix/wikilink-rename-anchor-preserve
```

Open the PR against `master` with `gh pr create --repo Jerit3787/markdown-editor --base master`. Title:

```
fix: wikilink-rename preserves comment/suggestion anchors in backlinking shared docs
```

Body covers: the bug (whole-text replace in `handleWikilinkRenameRequest` collapsed every anchor in each backlinking shared doc — comments and tracked-change suggestions both), the fix (server-side `findWikilinkOccurrences` + back-to-front in-place splice in one `"wikilink-rename"` transaction, mirroring the client's active-doc path), scope (server cascade path only; version-restore's wholesale replace is explicitly out of scope per the spec), the spec + plan paths, verification results, patch bump to 1.62.12. End with:

```
🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

- [ ] **Step 8: Wait for CI, then merge**

Wait for all checks green (`test`, `typecheck`, `e2e`, `e2e-collab`, `e2e-github`, CodeQL, Snyk, GitGuardian). Merge with a real merge commit once the user authorizes:

```bash
gh pr merge <N> --repo Jerit3787/markdown-editor --merge
```

`auto-tag.yml` → `release.yml` → Cloudflare auto-deploy run on their own from there.

---

## Self-Review

**1. Spec coverage:**
- Spec "Design → `src/wikilink-rewrite.ts`" → Task 1. ✓
- Spec "Design → `handleWikilinkRenameRequest`" → Task 2 Steps 3-4. ✓
- Spec "Unchanged downstream" (`handleDocUpdate`) → Task 2 Step 6 note confirms no change needed. ✓
- Spec "Edge cases" table: in-code skip → Task 1 Step 1 test + Task 2 oracle test; anchor inside span → covered by design decision, not special-cased (no task needed); length delta → Task 2 regression test uses `Old`→`Newer` (different length) and asserts the `+2` shift; multiple occurrences → Task 2 single-transaction test. ✓
- Spec "Testing" items 1-2 → Task 1 tests, Task 2 tests (regression, oracle, multi-occurrence, existing kept). ✓
- Spec "Versioning & docs" → Task 3. ✓
- Non-goals (version restore, local-doc backlinks, client active-doc path): no task touches them. ✓

**2. Placeholder scan:** No TBD/TODO. Every code step has a literal code block. Test steps have full test bodies. The only soft spot — TEST-COVERAGE count increment — is explicitly flagged as a hand-maintained tally to match against surrounding rows, with a concrete default (+1). Acceptable.

**3. Type consistency:**
- `WikilinkOccurrence { from: number; to: number }` — defined Task 1, consumed Task 2 as `occurrences[i]!` with `.from` / `.to`. ✓
- `findWikilinkOccurrences(content, name)` — same signature in Task 1 (produce) and Task 2 (consume). ✓
- `handleWikilinkRenameRequest` return `Response.json({ changed: boolean })` — unchanged, both new and existing tests assert `changed` / status. ✓
- Test helper signatures (`createCommentThread`, `recordDeleteSuggestion`, `listResolvedCommentThreads`, `listResolvedSuggestions`, `encryptSession`, `fakeState`, `fakeEnvWithSecret`) — all already imported/used elsewhere in `tests/src/workspace-room.test.ts`; the plan only adds the `rewriteWikilinkReferences` import. ✓
