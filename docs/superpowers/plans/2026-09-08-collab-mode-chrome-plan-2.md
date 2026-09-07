# Collaboration mode chrome — Plan 2: publish gate & repo-linked signal

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gate Publish-to-Gist and GitHub-repo actions to the workspace owner (A1 + A2), and give a non-owner collaborator a read-only "this workspace syncs to a GitHub repo" signal (A5) via a bool appended to the `MESSAGE_WORKSPACE_META` frame.

**Architecture:** `MenuBar` hides its Publish / repo items unless the session is local or `$collabIsOwner`. The `WorkspaceRoom` gains a persisted `repoLinked` bool set by the owner's `repo-sync.ts` (`PUT /meta`) on link / unlink and broadcast in every workspace-meta frame; `collab.ts` decodes it into a `workspaceRepoLinked` store that `DocInfoPanel` reads.

**Tech Stack:** TypeScript, Svelte 5, Cloudflare Workers + Durable Objects, `lib0` encoding, Vitest (`unit` + `components`), Playwright.

**Spec:** `docs/superpowers/specs/2026-09-08-collaboration-mode-chrome-design.md` (§5 A1/A2, §6 A5)

## Global Constraints

- This plan continues on branch `feat/collab-mode-chrome` (Plan 1 already merged into it). No version bump / `whats-new` entry — Plan 3 does the shared `1.50.0` release. `CHANGELOG.md` already has a provisional `## [1.50.0] - UNRELEASED` heading (from Plan 1's Task 8) — add to its body, don't add a second heading.
- Commit trailer: `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>` only. PR bodies end with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- **Never `git add src/worker.ts`** — this plan touches `src/workspace-room.ts` but not `worker.ts`; keep the dev-login patch out of every commit (`git status` before each `git add`, explicit paths only).
- Two `tsconfig`s checked separately (`npm run typecheck`). Component tests → `tests/client/src/components/*.test.ts` only.
- `collab.test.ts`: `// @vitest-environment jsdom`, `import "fake-indexeddb/auto"`, `MockWebSocket` + `vi.stubGlobal("fetch")` per `describe`.
- `MESSAGE_WORKSPACE_META` frame is currently `[type, name, docCount, ...docIds]`. The new `repoLinked` varuint (0/1) is appended **last** — a trailing field, so an old client that stops reading early is unaffected; a new client reads it only if `decoding.hasContent(decoder)` (guards against an old server that never wrote it).
- "Owner" client-side = `collabIsOwner` (Plan 1's store: `access.owner === githubUsername`). Publish gate shows when **`!$collabRole || $collabIsOwner`** — i.e. a plain local document, or a shared workspace this user owns.

---

## File Structure

- `client/src/components/MenuBar.svelte` (modify) — `publishHidden` derived; `hidden` on the Publish divider, `#menuPublishSignedOut`, `#publishSubmenu`, and the GitHub Repo `.menu-submenu`.
- `src/workspace-room.ts` (modify) — `repoLinked` field + storage load; `handleMetaRequest` accepts `{ repoLinked }` (name now optional); `encodeWorkspaceMeta` appends the bool.
- `client/src/collab.ts` (modify) — decode the trailing bool in `handleServerMessage`; `applyWorkspaceMeta` sets `workspaceRepoLinked`; new `pushWorkspaceRepoLinked`; wire `workspaceRepoLinkHook` in `init()`; reset the store in `teardownWorkspace`.
- `client/src/stores/repoSync.ts` (modify) — `export const workspaceRepoLinked = writable(false)`.
- `client/src/stores/workspaces.ts` (modify) — `workspaceRepoLinkHook`; call it from `setWorkspaceRepoLink` / `clearWorkspaceRepoLink`.
- `client/src/components/DocInfoPanel.svelte` (modify) — the read-only "Synced to a GitHub repo (managed by the owner)" row.
- Tests: `tests/client/src/components/MenuBar.test.ts`, `tests/src/workspace-room.test.ts`, `tests/client/src/collab.test.ts`, `tests/client/src/components/DocInfoPanel.test.ts`, `tests/e2e/collab/mode-switcher.spec.ts` (extend), `docs/TEST-COVERAGE.md`, `CHANGELOG.md`.

---

## Task 1: Publish gate in MenuBar (A1 + A2)

**Files:**
- Modify: `client/src/components/MenuBar.svelte` — script + the Publish section (~lines 131-179).
- Test: `tests/client/src/components/MenuBar.test.ts`

**Interfaces:**
- Consumes: `collabRole`, `collabIsOwner` from `../stores/collabMode`.
- Behaviour: with `!$collabRole` (local) or `$collabIsOwner` — Publish/repo items visible (unchanged). Otherwise (shared, not owner — viewer, reviewer, **or non-owner editor**) — all four hidden via the `hidden` attribute.

- [ ] **Step 1: Write the failing test**

In `tests/client/src/components/MenuBar.test.ts` (already imports `enterCollabRoom` / `leaveCollabRoom` from Plan 1's Task 5), add:

```ts
test("A1/A2: Publish + GitHub Repo are hidden for a non-owner shared session, shown for owner and local", async () => {
  const screen = await render(MenuBar);
  const hidden = (sel: string) => screen.container.querySelector(sel)?.hasAttribute("hidden");

  // Local (no collab role) — visible.
  expect(hidden("#publishSubmenu")).toBe(false);

  // Shared, NOT owner — hidden.
  enterCollabRoom("r1", "editor", false);
  await expect.poll(() => hidden("#publishSubmenu")).toBe(true);
  expect(hidden("#menuPublishSignedOut")).toBe(true);
  expect(screen.container.querySelector("#fileMenu .menu-submenu button.menu-submenu-trigger")).toBeTruthy(); // "Open Recent" etc still there
  const repoTrigger = [...screen.container.querySelectorAll("#fileMenu .menu-submenu-trigger")].find((b) => /GitHub Repo/.test(b.textContent ?? ""));
  expect(repoTrigger?.closest(".menu-submenu")?.hasAttribute("hidden")).toBe(true);

  // Shared AND owner — visible again.
  enterCollabRoom("r2", "editor", true);
  await expect.poll(() => hidden("#publishSubmenu")).toBe(false);
});
```

Note: `#publishSubmenu` also has `hidden={!$githubUsername}` — the test's default `beforeEach` leaves `githubUsername` unset, so `#publishSubmenu` starts hidden for the *signed-out* reason. Set `githubUsername` in the test so the only variable is the owner gate:

```ts
import { githubUsername } from "../../../../client/src/stores/github";
// at the top of the test:
githubUsername.set("octocat");
// ...and githubUsername.set(null) at the end.
```

- [ ] **Step 2: Run — expect failure**

Run: `npx vitest run --project=components tests/client/src/components/MenuBar.test.ts -t "A1/A2"`
Expected: FAIL — items still shown for a non-owner.

- [ ] **Step 3: Implement**

`client/src/components/MenuBar.svelte` script — extend the Plan 1 import:

```ts
  import { effectiveMode, collabRole, collabIsOwner } from "../stores/collabMode";

  const viewing = $derived($effectiveMode === "viewing");
  // Publish to Gist / repo push are the workspace owner's call — a
  // non-owner collaborator (viewer, reviewer, or editor) doesn't control
  // the document's external publishing targets. (spec §5)
  const publishHidden = $derived(!!$collabRole && !$collabIsOwner);
```

The Publish section markup — add `hidden` to four spots:

```svelte
      <div class="menu-divider" hidden={publishHidden}></div>
      <button id="menuPublishSignedOut" type="button" disabled={!hasActiveDoc} hidden={!!$githubUsername || publishHidden} onclick={...}>
        ...
      </button>
      <div class="menu-submenu" id="publishSubmenu" hidden={!$githubUsername || publishHidden}>
        ...
      </div>

      <div class="menu-submenu" hidden={publishHidden}>
        <button class="menu-submenu-trigger" type="button" disabled={!hasWorkspace}>
          <svg class="icon"><use href="#icon-github"></use></svg> GitHub Repo ...
```

(`hidden` attribute, not `{#if}` — matches the existing comment "Both always exist … so the submenu's flyout trigger is wired once by initSubmenus at mount".)

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run --project=components tests/client/src/components/MenuBar.test.ts` — PASS (new + existing).
Run: `npm run typecheck` — clean.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/MenuBar.svelte tests/client/src/components/MenuBar.test.ts
git commit -m "$(cat <<'EOF'
feat(collab): owner-only Publish to Gist / GitHub Repo in a shared workspace (A1/A2)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Server — `repoLinked` on `WorkspaceRoom`

**Files:**
- Modify: `src/workspace-room.ts` — class field + constructor load (~line 145-165); `handleMetaRequest` (~line 430); `encodeWorkspaceMeta` (~line 410).
- Test: `tests/src/workspace-room.test.ts`

**Interfaces:**
- Consumes: `this.state.storage`, `this.authorize`.
- Produces: `PUT /api/workspace/:id/meta` accepts `{ name?: string }` and/or `{ repoLinked?: boolean }` (editor-only, at least one field required); persists `repoLinked`; `encodeWorkspaceMeta()` frame gains a trailing `varuint` (`repoLinked ? 1 : 0`).

- [ ] **Step 1: Write the failing tests**

In `tests/src/workspace-room.test.ts`, extend the `handleMetaRequest` describe:

```ts
it("accepts a repoLinked flag from an editor and carries it in the next meta frame", async () => {
  const room = new WorkspaceRoom(fakeState(), fakeEnvWithSecret);
  await room.state.storage.put("access", { owner: "alice", generalAccess: "anyone", requireAccount: false, role: "editor", invited: [] });
  const cookie = await encryptSession(fakeEnvWithSecret, { token: "gh-token", username: "alice" });
  const res = await room.handleMetaRequest(
    new Request("https://x/w/ws1/meta", {
      method: "PUT",
      headers: { Cookie: `mde_gh_session=${cookie}`, "Content-Type": "application/json" },
      body: JSON.stringify({ repoLinked: true }),
    }),
  );
  expect(res.status).toBe(200);

  // Decode the frame — [type=3, name, docCount, ...ids, repoLinked]
  const frame = room.encodeWorkspaceMeta();
  const dec = decoding.createDecoder(frame);
  expect(decoding.readVarUint(dec)).toBe(3); // MESSAGE_WORKSPACE_META
  decoding.readVarString(dec); // name
  const n = decoding.readVarUint(dec);
  for (let i = 0; i < n; i++) decoding.readVarString(dec);
  expect(decoding.readVarUint(dec)).toBe(1); // repoLinked
});

it("still accepts a name-only PUT and rejects an empty body", async () => {
  const room = new WorkspaceRoom(fakeState(), fakeEnvWithSecret);
  await room.state.storage.put("access", { owner: "alice", generalAccess: "anyone", requireAccount: false, role: "editor", invited: [] });
  const cookie = await encryptSession(fakeEnvWithSecret, { token: "gh-token", username: "alice" });
  const mk = (body: unknown) =>
    room.handleMetaRequest(
      new Request("https://x/w/ws1/meta", { method: "PUT", headers: { Cookie: `mde_gh_session=${cookie}`, "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    );
  expect((await mk({ name: "Renamed" })).status).toBe(200);
  expect((await mk({})).status).toBe(400);
});

it("rejects a non-editor's repoLinked PUT", async () => {
  const room = new WorkspaceRoom(fakeState(), fakeEnvWithSecret);
  await room.state.storage.put("access", { owner: "alice", generalAccess: "anyone", requireAccount: false, role: "viewer", invited: [] });
  const cookie = await encryptSession(fakeEnvWithSecret, { token: "gh-token", username: "carol" });
  const res = await room.handleMetaRequest(
    new Request("https://x/w/ws1/meta", { method: "PUT", headers: { Cookie: `mde_gh_session=${cookie}`, "Content-Type": "application/json" }, body: JSON.stringify({ repoLinked: true }) }),
  );
  expect(res.status).toBe(403);
});
```

- [ ] **Step 2: Run — expect failure**

Run: `npx vitest run tests/src/workspace-room.test.ts -t "repoLinked"`
Expected: FAIL — `handleMetaRequest` rejects a body with no `name`.

- [ ] **Step 3: Add the field + load it**

In the class fields (next to `deleted: boolean;`):

```ts
  repoLinked: boolean;
```

Constructor, before `blockConcurrencyWhile`:

```ts
    this.repoLinked = false;
```

Inside `blockConcurrencyWhile`, after the `this.deleted = ...` line:

```ts
      this.repoLinked = (await this.state.storage.get<boolean>("repoLinked")) === true;
```

- [ ] **Step 4: Rework `handleMetaRequest`**

```ts
  async handleMetaRequest(request: Request): Promise<Response> {
    if (request.method !== "PUT") return new Response("Method not allowed", { status: 405 });
    const auth = await this.authorize(request);
    if (!auth.ok) return new Response(auth.message, { status: auth.status });
    if (auth.role !== "editor") return new Response("Only an editor can change workspace metadata.", { status: 403 });
    let body: { name?: unknown; repoLinked?: unknown };
    try {
      body = await request.json();
    } catch (err) {
      return new Response("Invalid JSON.", { status: 400 });
    }
    const hasName = typeof body.name === "string";
    const hasRepoLinked = typeof body.repoLinked === "boolean";
    if (!hasName && !hasRepoLinked) return new Response("Nothing to update.", { status: 400 });

    if (hasName) {
      this.name = body.name as string;
      await this.state.storage.put("name", this.name);
    }
    if (hasRepoLinked) {
      this.repoLinked = body.repoLinked as boolean;
      await this.state.storage.put("repoLinked", this.repoLinked);
    }
    this.broadcastWorkspaceMeta();
    return Response.json({ name: this.name, repoLinked: this.repoLinked });
  }
```

- [ ] **Step 5: Append the bool to `encodeWorkspaceMeta`**

```ts
  encodeWorkspaceMeta(): Uint8Array {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_WORKSPACE_META);
    encoding.writeVarString(encoder, this.name);
    encoding.writeVarUint(encoder, this.docIds.length);
    for (const id of this.docIds) encoding.writeVarString(encoder, id);
    encoding.writeVarUint(encoder, this.repoLinked ? 1 : 0);
    return encoding.toUint8Array(encoder);
  }
```

- [ ] **Step 6: Run tests + typecheck**

Run: `npx vitest run tests/src/workspace-room.test.ts` — PASS (new + existing; check the existing name-PUT test still passes).
Run: `npx tsc --noEmit` — clean (server strict).

- [ ] **Step 7: Commit** (explicit paths — `src/worker.ts` must be untouched)

```bash
git status
git add src/workspace-room.ts tests/src/workspace-room.test.ts
git commit -m "$(cat <<'EOF'
feat(workspace-room): repoLinked flag on the workspace-meta frame

PUT /meta now takes an optional { repoLinked: boolean } alongside name
(editor-only); the value is persisted and appended to every
MESSAGE_WORKSPACE_META frame as a trailing varuint.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Client — decode `repoLinked`, store, and the owner's push

**Files:**
- Modify: `client/src/stores/repoSync.ts` — `workspaceRepoLinked`.
- Modify: `client/src/stores/workspaces.ts` — `workspaceRepoLinkHook` + calls from `setWorkspaceRepoLink` / `clearWorkspaceRepoLink`.
- Modify: `client/src/collab.ts` — decode in `handleServerMessage`; `applyWorkspaceMeta`; `pushWorkspaceRepoLinked`; wire the hook in `init()`; reset in `teardownWorkspace`.
- Test: `tests/client/src/collab.test.ts`

**Interfaces:**
- Produces: `workspaceRepoLinked: Writable<boolean>` (`stores/repoSync`). `pushWorkspaceRepoLinked(workspaceId: string, linked: boolean): void` (`collab.ts`) — PUTs `{ repoLinked }` to `/meta` for a shared workspace only, mirroring `pushWorkspaceRename`. `workspaceRepoLinkHook: { onChanged?: (workspaceId: string, linked: boolean) => void }` (`stores/workspaces`).
- Consumes: `decoding.hasContent`.

- [ ] **Step 1: Write the failing tests**

In `tests/client/src/collab.test.ts`, extend the "incoming workspace meta sync" describe. Its `sendWorkspaceMeta` helper builds the frame by hand — add the trailing bool:

```ts
import { workspaceRepoLinked } from "../../../client/src/stores/repoSync";

function sendWorkspaceMeta(name: string, docOrder: string[], repoLinked = false) {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_WORKSPACE_META);
  encoding.writeVarString(encoder, name);
  encoding.writeVarUint(encoder, docOrder.length);
  for (const id of docOrder) encoding.writeVarString(encoder, id);
  encoding.writeVarUint(encoder, repoLinked ? 1 : 0);
  MockWebSocket.instances[0].onmessage!({ data: encoding.toUint8Array(encoder).buffer } as MessageEvent);
}
```

(Existing `sendWorkspaceMeta(...)` callers keep working — the new arg defaults to `false`.)

```ts
it("sets workspaceRepoLinked from the meta frame's trailing bool", async () => {
  const { docA, docB } = await setup("metarepolink");
  sendWorkspaceMeta("Old Name", [docA.id, docB.id], true);
  expect(get(workspaceRepoLinked)).toBe(true);
  sendWorkspaceMeta("Old Name", [docA.id, docB.id], false);
  expect(get(workspaceRepoLinked)).toBe(false);
});

it("tolerates an old-server frame with no trailing bool (defaults false)", async () => {
  const { docA, docB } = await setup("metaoldframe");
  // Build a frame WITHOUT the trailing bool:
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, 3);
  encoding.writeVarString(enc, "Old Name");
  encoding.writeVarUint(enc, 2);
  encoding.writeVarString(enc, docA.id);
  encoding.writeVarString(enc, docB.id);
  MockWebSocket.instances[0].onmessage!({ data: encoding.toUint8Array(enc).buffer } as MessageEvent);
  expect(get(workspaceRepoLinked)).toBe(false);
});
```

Add a `beforeEach(() => workspaceRepoLinked.set(false))` to that describe.

Also, in the "collab-mode role publishing" describe (Plan 1 Task 2), or a small new one, test `pushWorkspaceRepoLinked` via `workspaceRepoLinkHook`:

```ts
import { workspaceRepoLinkHook } from "../../../client/src/stores/workspaces";

it("an editor linking a shared workspace to a repo PUTs repoLinked to the room", async () => {
  const { } = await setup("editor", "hooklink"); // editor + connected
  const spy = fetch as unknown as { mock: { calls: [string, { method?: string; body?: string }?][] } };
  spy.mock.calls.length = 0;
  // simulate stores/workspaces firing the hook (as setWorkspaceRepoLink would)
  workspaceRepoLinkHook.onChanged?.(
    get(workspacesStore).find((w) => w.remoteId === "remote-hooklink")!.id,
    true,
  );
  const put = spy.mock.calls.find(([u, i]) => u === "/api/workspace/remote-hooklink/meta" && i?.method === "PUT");
  expect(put).toBeTruthy();
  expect(JSON.parse(put![1]!.body!)).toEqual({ repoLinked: true });
});
```

(The `setup` helper in that describe seeds a `fakeSharedWorkspace({ remoteId: "remote-<suffix>" })`.)

- [ ] **Step 2: Run — expect failure**

Run: `npx vitest run tests/client/src/collab.test.ts -t "repoLinked"`
Expected: FAIL.

- [ ] **Step 3: Add the store + hook**

`client/src/stores/repoSync.ts`, append:

```ts
// Set from the MESSAGE_WORKSPACE_META frame (collab.ts) — true when the
// current shared workspace is linked to a GitHub repo, so a collaborator
// who has no repoLink of their own can still be told sync is in play
// (DocInfoPanel.svelte). Reset on teardown.
export const workspaceRepoLinked = writable(false);
```

`client/src/stores/workspaces.ts`, near `pendingRepoDeletions` helpers:

```ts
// collab.ts's init() sets onChanged once; setWorkspaceRepoLink /
// clearWorkspaceRepoLink call it so the owner can broadcast "this
// workspace (is / is no longer) repo-linked" to collaborators over the
// workspace-meta frame. This module can't import collab.ts (see the
// module-doc comment), hence the hook.
export const workspaceRepoLinkHook: { onChanged?: (workspaceId: string, linked: boolean) => void } = {};
```

In `setWorkspaceRepoLink`, after `persistWorkspaces()`:

```ts
  workspaceRepoLinkHook.onChanged?.(id, true);
```

In `clearWorkspaceRepoLink`, after `persistWorkspaces()`:

```ts
  workspaceRepoLinkHook.onChanged?.(id, false);
```

- [ ] **Step 4: `collab.ts` — decode, apply, push, wire, reset**

Imports:

```ts
import { workspaceRepoLinked } from "./stores/repoSync";
import { /* existing */ workspaceRepoLinkHook } from "./stores/workspaces";
```

`handleServerMessage`, the `MESSAGE_WORKSPACE_META` branch:

```ts
  if (messageType === MESSAGE_WORKSPACE_META) {
    const name = decoding.readVarString(decoder);
    const count = decoding.readVarUint(decoder);
    const docOrder: string[] = [];
    for (let i = 0; i < count; i++) docOrder.push(decoding.readVarString(decoder));
    const repoLinked = decoding.hasContent(decoder) ? decoding.readVarUint(decoder) === 1 : false;
    if (workspaceRoom.workspaceId) applyWorkspaceMeta(workspaceRoom.workspaceId, name, docOrder, repoLinked);
    return;
  }
```

`applyWorkspaceMeta` — add the param and set the store:

```ts
function applyWorkspaceMeta(remoteWorkspaceId: string, name: string, docOrder: string[], repoLinked: boolean): void {
  const local = get(workspacesStore).find((w) => w.remoteId === remoteWorkspaceId);
  if (!local) return;
  workspaceRepoLinked.set(repoLinked);
  // ...rest unchanged (name heal, doc removal)...
}
```

New export near `pushWorkspaceRename`:

```ts
export function pushWorkspaceRepoLinked(workspaceId: string, linked: boolean): void {
  const ws = get(workspacesStore).find((w) => w.id === workspaceId);
  if (!ws || !ws.shared || !ws.remoteId) return;
  void fetch(`/api/workspace/${encodeURIComponent(ws.remoteId)}/meta`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repoLinked: linked }),
  });
}
```

`init()`, next to the `docRemovalHook` / `repoDocSyncHook` wiring:

```ts
  workspaceRepoLinkHook.onChanged = (wsId, linked) => pushWorkspaceRepoLinked(wsId, linked);
```

`teardownWorkspace()`, near `leaveCollabRoom()`:

```ts
  workspaceRepoLinked.set(false);
  leaveCollabRoom();
```

- [ ] **Step 5: Run tests + full suite + typecheck**

Run: `npx vitest run tests/client/src/collab.test.ts` — PASS.
Run: `npm test` — all green.
Run: `npm run typecheck` — clean.

- [ ] **Step 6: Commit**

```bash
git add client/src/collab.ts client/src/stores/repoSync.ts client/src/stores/workspaces.ts tests/client/src/collab.test.ts
git commit -m "$(cat <<'EOF'
feat(collab): decode repoLinked from workspace-meta; owner pushes it on link/unlink

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `DocInfoPanel` — the read-only repo-linked row (A5)

**Files:**
- Modify: `client/src/components/DocInfoPanel.svelte` — the "Synced to" block (~lines 177-203).
- Test: `tests/client/src/components/DocInfoPanel.test.ts`

**Interfaces:**
- Consumes: `workspaceRepoLinked` (`../stores/repoSync`), `collabIsOwner` (`../stores/collabMode`).
- Behaviour: when `$workspaceRepoLinked && !$collabIsOwner` and the active doc has no `repoPath` of its own, the "Synced to" section shows a plain (no-link) **Repo — "Synced to a GitHub repo, managed by the workspace owner"** row. The owner's existing rich row is unchanged.

- [ ] **Step 1: Write the failing test**

In `tests/client/src/components/DocInfoPanel.test.ts` (already renders `DocInfoPanel`):

```ts
import { workspaceRepoLinked } from "../../../../client/src/stores/repoSync";
import { collabIsOwner, leaveCollabRoom } from "../../../../client/src/stores/collabMode";

test("A5: a non-owner collaborator sees a read-only repo-linked row", async () => {
  leaveCollabRoom();
  workspaceRepoLinked.set(true);
  collabIsOwner.set(false);
  // ...seed an active doc with NO repoPath in a workspace with NO repoLink...
  const screen = await render(DocInfoPanel);
  // open the panel (docInfoPanelOpen.set(true) or the trigger the file uses)
  await expect.element(screen.getByText(/managed by the workspace owner/i)).toBeVisible();
});

test("A5: the owner does not get the read-only row", async () => {
  workspaceRepoLinked.set(true);
  collabIsOwner.set(true);
  const screen = await render(DocInfoPanel);
  expect((await screen.getByText(/managed by the workspace owner/i).all()).length).toBe(0);
});
```

Follow the file's existing pattern for seeding stores + opening the panel.

- [ ] **Step 2: Run — expect failure**

Run: `npx vitest run --project=components tests/client/src/components/DocInfoPanel.test.ts -t "A5"`
Expected: FAIL.

- [ ] **Step 3: Implement**

`client/src/components/DocInfoPanel.svelte` script:

```ts
  import { workspaceRepoLinked } from "../stores/repoSync";
  import { collabIsOwner } from "../stores/collabMode";
```

The "Synced to" block — widen the outer gate and add the fallback row:

```svelte
    {#if doc.repoPath || doc.gistId || ($workspaceRepoLinked && !$collabIsOwner)}
      <div class="menu-section-label">Synced to</div>
      {#if doc.repoPath}
        {@const workspace = $workspacesStore.find((w) => w.id === doc.workspaceId)}
        {#if workspace?.repoLink}
          <!-- ...existing rich Repo row... -->
        {/if}
      {:else if $workspaceRepoLinked && !$collabIsOwner}
        <div class="doc-info-row">
          <span class="doc-info-primary">Repo</span>
          <span class="doc-info-secondary">Synced to a GitHub repo, managed by the workspace owner</span>
        </div>
      {/if}
      {#if doc.gistId}
        <!-- ...existing Gist row... -->
      {/if}
    {/if}
```

- [ ] **Step 4: Run tests + typecheck + commit**

Run: `npx vitest run --project=components tests/client/src/components/DocInfoPanel.test.ts` — PASS.
Run: `npm run typecheck` — clean.

```bash
git add client/src/components/DocInfoPanel.svelte tests/client/src/components/DocInfoPanel.test.ts
git commit -m "$(cat <<'EOF'
feat(collab): read-only 'synced to a GitHub repo' row for non-owner collaborators (A5)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Full verification + E2E + CHANGELOG

**Files:**
- Modify: `tests/e2e/collab/mode-switcher.spec.ts` (extend), `CHANGELOG.md`, `docs/TEST-COVERAGE.md`

- [ ] **Step 1: Extend the E2E**

Add to `tests/e2e/collab/mode-switcher.spec.ts` (or a sibling `mode-chrome.spec.ts`):

```ts
test("a non-owner editor collaborator has no Publish / GitHub Repo in the File menu", async ({ browser }) => {
  const aCtx = await browser.newContext();
  const bCtx = await browser.newContext();
  const a = await aCtx.newPage();
  const b = await bCtx.newPage();

  await ownerWithDoc(a, "gate-owner-e2e", "body");
  const url = await shareAnyoneLink(a, "Editor");
  await joinSharedWorkspace(b, url);

  await b.click("#fileMenuBtn");
  await expect(b.locator("#publishSubmenu")).toBeHidden();
  await expect(b.locator('#fileMenu .menu-submenu-trigger:has-text("GitHub Repo")')).toBeHidden();

  // The owner still has them.
  await a.click("#fileMenuBtn");
  await expect(a.locator("#publishSubmenu")).toBeVisible();

  await aCtx.close();
  await bCtx.close();
});
```

- [ ] **Step 2: Run everything**

```bash
npm test
npm run typecheck
npm run format:check   # `npm run format` then re-add if it flags anything
npm run build
npm run test:e2e:local
npm run test:e2e:collab
```

All green. Sandbox Playwright-browser caveat from `CLAUDE.md` applies if the cache is stale.

- [ ] **Step 3: `CHANGELOG.md`**

Under the existing `## [1.50.0] - UNRELEASED` heading, in `### Changed` (create the sub-section if absent) and `### Added`:

```markdown
### Changed

- **Publishing to Gist and syncing to a GitHub repo are now the workspace owner's controls only.** A collaborator you share a workspace with — at any role — no longer sees Publish to Gist or the GitHub Repo menu; those actions belong to whoever owns the workspace.

### Added

- **Collaborators can see when a workspace syncs to a GitHub repo.** Document Info shows a read-only "Synced to a GitHub repo, managed by the workspace owner" line for people you've shared a repo-linked workspace with.
```

- [ ] **Step 4: `docs/TEST-COVERAGE.md`**

Add rows under §10: A1/A2 publish gate (MenuBar component + the e2e), the server `repoLinked` meta field, the client decode + `workspaceRepoLinkHook` push, the DocInfoPanel A5 row. Follow the table format; cite the spec.

- [ ] **Step 5: Commit + push**

```bash
git add tests/e2e/collab/mode-switcher.spec.ts CHANGELOG.md docs/TEST-COVERAGE.md
git commit -m "$(cat <<'EOF'
test: publish-gate e2e + coverage rows; CHANGELOG for plan 2

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
git push origin feat/collab-mode-chrome
```

Update PR #180's description (or add a comment) noting Plan 2 has landed on the branch. Wait for CI green. **Still do not merge** — Plan 3 (focus mode + the `1.50.0` version bump / What's New) is the last one. Report status and ask.

---

## Self-review notes (addressed)

- **Spec coverage:** A1 + A2 → Task 1; A5 server → Task 2; A5 client store/decode/push → Task 3; A5 UI → Task 4; e2e + changelog → Task 5.
- **Trailing-field wire compat:** Task 3's decode uses `decoding.hasContent(decoder)` before reading the bool; a dedicated test (`tolerates an old-server frame`) pins it. The server always writes it (Task 2 Step 5).
- **`handleMetaRequest` back-compat:** Task 2 Step 4 keeps the name-only PUT working (`pushWorkspaceRename` unchanged) and only rejects a genuinely empty body — an existing test asserts the name PUT still 200s.
- **Hook, not import:** `stores/workspaces.ts` can't import `collab.ts`; `workspaceRepoLinkHook` mirrors the established `docRemovalHook` / `repoDocSyncHook` pattern.
- **`publishHidden` vs `viewing`:** independent — `publishHidden` keys on role+ownership (a non-owner *editor* is still gated), `viewing` on the chosen mode. Both are `hidden` attributes on their own elements.
- **Type consistency:** `pushWorkspaceRepoLinked(workspaceId, linked)` signature identical in Task 3 Step 4's definition, the `init()` wiring, and the hook's `onChanged` type in `stores/workspaces.ts`.
