# Test Coverage Phase 9 — Comments

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use `- [ ]` checkboxes.

**Goal:** Close the reachable §9 gap/partial rows — the comment reply & resolve server routes (CMT-12/13), the unresolved-count badge (CMT-16), row-click scroll (CMT-17), the empty-input rejection (CMT-18), and the panel-collapse regression guard (CMT-19).

**Architecture:** Integration tests against `WorkspaceRoom`'s comment handlers (`tests/src/workspace-room.test.ts`), one component test for the MenuBar badge, e2e for the panel/editor interactions.

**Spec:** `docs/TEST-COVERAGE.md` §9.

## Global Constraints

- Test-only → the combined phases-9–14 branch bumps once at the end. No per-phase bump.
- Deferred (stay in `## Deferred`): **CMT-14** (anchor follows live editor edits) and **CMT-15** (add/resolve/delete propagates live) → §10 e2e-collab.
- Commit trailer `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`.

## Task 1: comment reply & resolve server routes (CMT-12, CMT-13)

**File:** `tests/src/workspace-room.test.ts` — extend the `WorkspaceRoom comment threads` describe.

- [ ] Add: an editor/reviewer POST to `/comments/:id/reply` returns 200 and appends the reply; a viewer gets 403; empty body → 400 `Invalid reply.`; unknown thread → 404.
- [ ] Add: POST `/comments/:id/resolve` sets `resolved: true`; `{resolved:false}` reopens; a viewer gets 403; unknown thread → 404.
- [ ] Use the existing `fakeState()` / `fakeEnvWithSecret` / `encryptSession` pattern; seed `access` with an `owner` + an `invited` `{username:"bob", role:"editor"|"viewer"}`; `room.createThread(...)` before calling the handler (same cached `loadDocRoom` instance).
- [ ] Run `npx vitest run tests/src/workspace-room.test.ts`.

## Task 2: unresolved-count badge (CMT-16)

**File:** `tests/client/src/components/MenuBar.test.ts` (create, or extend if it exists).

- [ ] Mount `MenuBar.svelte`; `unresolvedCommentCount.set(3)` → `.menu-badge` reads `3`; `.set(0)` → no `.menu-badge`; `.set(150)` → `99+`.
- [ ] Run `npx vitest run --project=components tests/client/src/components/MenuBar.test.ts`.

## Task 3: CMT-18 — strengthen empty-input rejection

**File:** `tests/src/workspace-room.test.ts`.

- [ ] Assert `handleCommentsRequest` POST with `body: ""` (whitespace) → 400 `Invalid comment.`, alongside the reply 400 from Task 1. Retarget the CMT-18 catalog row from `partial` to `covered`.

## Task 4: CMT-17 & CMT-19 e2e

**File:** `tests/e2e/local/comments.spec.ts`.

- [ ] CMT-17: seed a comment (existing spec's helper), move the editor selection far away, click `.comment-entry-quote`, assert `window.MDE.getEditor().state.selection.main.from` is back at the anchor.
- [ ] CMT-19: open the Comments panel, close it, assert `.comments-panel` is fully off-screen — `getBoundingClientRect().left >= innerWidth` (the regression left an ~80px sliver). Also assert the `#body` grid didn't leave a gap (the panel column collapsed).
- [ ] Run `npx vitest`-adjacent: `npx playwright test tests/e2e/local/comments.spec.ts`.

## Task 5: catalog

- [ ] `docs/TEST-COVERAGE.md` §9: CMT-12/13/16/17/19 → `covered`, CMT-18 → `covered`. Tally `11/1/7 → 18/0/2`. Add CMT-14/CMT-15 to `## Deferred`.
- [ ] Commit.
