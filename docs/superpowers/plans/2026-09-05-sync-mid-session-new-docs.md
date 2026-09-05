# Sync Mid-Session New Documents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An already-connected collaborator's client discovers a document another collaborator creates (or first switches to) after both are already connected to a shared workspace, without any reload or rejoin.

**Architecture:** Client-only change to `handleServerMessage()` in `client/src/collab.ts`. The server already broadcasts every document's Y.Doc updates to every connected session tagged with that document's `docId`, regardless of whether the recipient already knows about it — the only gap is that the receiving client silently drops any frame for a `docId` it has no local binding for. The fix lazily creates a binding (via the existing `createDocBinding()`) the first time a `MESSAGE_SYNC` frame arrives for an unrecognized `docId`, applies the incoming sync content into it, then imports it into the local document list via the existing `importRemoteDocs()` path (the same one used for documents that existed in the room before this session joined).

**Tech Stack:** TypeScript, Yjs (`y-protocols/sync`, `lib0/encoding`/`decoding`), Svelte stores, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-05-sync-mid-session-new-docs-design.md`

## Global Constraints

- No new wire message type and no new server-side broadcast — this is a client-only fix (spec's Non-goals).
- No change to `openShareModal`, `setAccessMode`, or `seedNewDocBinding` — the document-creator side of this gap is already fixed and out of scope here.
- No persisted "recently discovered" state and no toast/notification — a newly discovered document simply appears in the document list, like any other remote change.
- A bare `MESSAGE_AWARENESS` frame for an unrecognized `docId` must still be dropped — never used to trigger discovery (awareness carries no document content to seed a binding with).
- User-facing change — per `CLAUDE.md`'s versioning convention this needs a minor version bump and a What's New entry, but the actual `package.json`/`package-lock.json` bump is deferred until the user explicitly says to ship this branch (only the `CHANGELOG.md` entry and the What's New entry are added now).

---

### Task 1: Discover unrecognized `docId`s in `handleServerMessage()`

**Files:**

- Modify: `client/src/collab.ts` (new functions near `createDocBinding`, ~line 553; `handleServerMessage`, lines 680-711)
- Test: `tests/client/src/collab.test.ts`

**Interfaces:**

- Consumes: `createDocBinding(docId: string, role: string): DocBinding` (existing, `client/src/collab.ts:458`); `findDocById(id: string): Doc | undefined`, `importRemoteDocs(workspaceId: string, remoteDocs: Pick<Doc, "id" | "name" | "content" | "updatedAt" | "createdAt">[]): void`, `get` (from `svelte/store`), `workspacesStore` — all already imported into `collab.ts`; the module-level `workspaceRoom` object (`{ workspaceId, ws, docs: Map<string, DocBinding>, activeDocId, ... }`).
- Produces: `discoverRemoteDocBinding(docId: string): DocBinding` and `registerDiscoveredDoc(docId: string, binding: DocBinding): void`, both module-private (not exported) — used only from `handleServerMessage`.

- [ ] **Step 1: Write the failing unit tests**

Add these imports to the top of `tests/client/src/collab.test.ts`, alongside the existing ones:

```ts
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";
```

Then add this new `describe` block at the end of the file (after the last existing `describe` block):

```ts
// Regression coverage for the mid-session doc-discovery gap: an
// already-connected collaborator previously had no way to learn about a
// document another collaborator created after they joined — the server
// already broadcasts every document's updates to every connected session
// (see workspace-room.ts's handleDocUpdate), but the client silently
// dropped any MESSAGE_SYNC/MESSAGE_AWARENESS frame for a docId it didn't
// already have a binding for.
describe("discovering a document created by another collaborator", () => {
  // Mirrors collab.ts's own (unexported) MESSAGE_SYNC/MESSAGE_AWARENESS
  // wire constants — these tests build raw frames by hand to exercise
  // handleServerMessage's decoding path directly, the same way a real
  // incoming WebSocket frame would.
  const MESSAGE_SYNC = 0;
  const MESSAGE_AWARENESS = 1;

  // Distinct remoteId/workspace id per test file run isn't enough on its
  // own — workspaceRoom.docs caches bindings by docId for the lifetime of
  // the module (see "suggestion-mode role wiring" above for the same
  // note), so this returns a fresh, uniquely-suffixed setup each time.
  async function setup(suffix: string) {
    document.body.innerHTML = '<div id="shareBtn"></div>';
    MockWebSocket.instances = [];
    vi.stubGlobal("WebSocket", MockWebSocket);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/access")) {
          return { ok: true, json: async () => ({ owner: "alice", generalAccess: "anyone", requireAccount: false, role: "editor", invited: [] }) };
        }
        if (url.includes("/docs")) {
          return { ok: true, json: async () => [`doc-${suffix}-a`] };
        }
        return { ok: false, json: async () => ({}) };
      }),
    );
    window.MDE = {
      enterCollabMode: vi.fn(),
      exitCollabMode: vi.fn(),
      setReadOnly: vi.fn(),
      getEditor: vi.fn(() => ({ state: { doc: { toString: () => "" } } })),
      githubUsername: "alice",
      githubSessionReady: Promise.resolve(),
      setDocImage: vi.fn(),
      requireGithubSignIn: vi.fn(),
    } as unknown as typeof window.MDE;

    const ws = fakeSharedWorkspace({ id: `local-ws-${suffix}`, remoteId: `remote-${suffix}` });
    workspacesStore.set([ws]);
    const doc = { id: `doc-${suffix}-a`, name: "A", content: "", updatedAt: 0, createdAt: 0, workspaceId: ws.id };
    docsStore.set([doc]);

    handleDocChanged(doc);
    for (let i = 0; i < 10; i++) await Promise.resolve();

    return { ws };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function sendRawSyncUpdate(docId: string, sourceDoc: Y.Doc) {
    const update = Y.encodeStateAsUpdate(sourceDoc);
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    encoding.writeVarString(encoder, docId);
    syncProtocol.writeUpdate(encoder, update);
    const buffer = encoding.toUint8Array(encoder).buffer;
    MockWebSocket.instances[0].onmessage!({ data: buffer } as MessageEvent);
  }

  function sendRawAwarenessFrame(docId: string) {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
    encoding.writeVarString(encoder, docId);
    encoding.writeVarUint8Array(encoder, new Uint8Array([1, 2, 3]));
    const buffer = encoding.toUint8Array(encoder).buffer;
    MockWebSocket.instances[0].onmessage!({ data: buffer } as MessageEvent);
  }

  it("creates a local document the first time a MESSAGE_SYNC frame arrives for an unrecognized docId", async () => {
    const { ws } = await setup("disc1");
    const sourceDoc = new Y.Doc();
    sourceDoc.getText("content").insert(0, "content from bob");
    sourceDoc.getMap<string>("meta").set("name", "Bob's New Doc");

    sendRawSyncUpdate("doc-disc1-b", sourceDoc);

    expect(workspaceRoom.docs.has("doc-disc1-b")).toBe(true);
    const localDoc = get(docsStore).find((d) => d.id === "doc-disc1-b");
    expect(localDoc?.name).toBe("Bob's New Doc");
    expect(localDoc?.content).toBe("content from bob");
    expect(localDoc?.workspaceId).toBe(ws.id);
  });

  it("falls back to 'Untitled' when the first frame carries no name yet", async () => {
    await setup("disc2");
    const sourceDoc = new Y.Doc();
    sourceDoc.getText("content").insert(0, "no name yet");

    sendRawSyncUpdate("doc-disc2-b", sourceDoc);

    const localDoc = get(docsStore).find((d) => d.id === "doc-disc2-b");
    expect(localDoc?.name).toBe("Untitled");
  });

  it("does not create a binding or a local document for a bare MESSAGE_AWARENESS frame naming an unrecognized docId", async () => {
    await setup("disc3");

    sendRawAwarenessFrame("doc-disc3-b");

    expect(workspaceRoom.docs.has("doc-disc3-b")).toBe(false);
    expect(get(docsStore).find((d) => d.id === "doc-disc3-b")).toBeUndefined();
  });

  it("does not re-import a document that's already locally known", async () => {
    const { ws } = await setup("disc4");
    docsStore.update((docs) => [...docs, { id: "doc-disc4-b", name: "Already Here", content: "existing", updatedAt: 0, createdAt: 0, workspaceId: ws.id }]);
    const countBefore = get(docsStore).length;

    const sourceDoc = new Y.Doc();
    sourceDoc.getText("content").insert(0, "server content");
    sourceDoc.getMap<string>("meta").set("name", "Server Name");
    sendRawSyncUpdate("doc-disc4-b", sourceDoc);

    expect(get(docsStore).length).toBe(countBefore);
    const localDoc = get(docsStore).find((d) => d.id === "doc-disc4-b");
    expect(localDoc?.name).toBe("Already Here");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/client/src/collab.test.ts -t "discovering a document created by another collaborator"`
Expected: FAIL — `workspaceRoom.docs.has("doc-disc1-b")` is `false` (the frame is currently silently dropped), so the first, second, and fourth tests fail; the third ("bare MESSAGE_AWARENESS") passes already since dropping is the current behavior, but leave it in place as a regression guard for the change about to be made.

- [ ] **Step 3: Implement the two new functions**

In `client/src/collab.ts`, insert this immediately after `createDocBinding`'s closing brace (after the `return binding;` / `}` at line 553), before the `bindActiveDoc` function:

```ts
// A document another collaborator created (or first switched to) after
// this session already joined the workspace arrives here as an ordinary
// MESSAGE_SYNC frame for a docId never seen before — the server
// broadcasts every document's updates to every connected session the
// same way regardless of whether the recipient already knew about that
// document (see handleDocUpdate in workspace-room.ts). Role is per
// connection, not per document (see access-role.ts's resolveRole()), so
// any existing binding's role is this session's own role too.
function discoverRemoteDocBinding(docId: string): DocBinding {
  const role = workspaceRoom.docs.get(workspaceRoom.activeDocId ?? "")?.role ?? "editor";
  return createDocBinding(docId, role);
}

// Called once, immediately after the first incoming sync message has
// been applied into a freshly-discovered binding — turns it into a real
// local document so it shows up in the sidebar/doc list like any other,
// via the same import path used for every document already known when
// this session joined (see joinWorkspace's own importRemoteDocs call).
function registerDiscoveredDoc(docId: string, binding: DocBinding): void {
  if (findDocById(docId)) return;
  const localWorkspace = get(workspacesStore).find((w) => w.remoteId === workspaceRoom.workspaceId);
  if (!localWorkspace) return;
  const now = Date.now();
  importRemoteDocs(localWorkspace.id, [
    { id: docId, name: binding.metaMap.get("name") || "Untitled", content: binding.ytext.toString(), updatedAt: now, createdAt: now },
  ]);
}
```

- [ ] **Step 4: Update `handleServerMessage` to use them**

In `client/src/collab.ts`, replace:

```ts
  const docId = decoding.readVarString(decoder);
  const binding = workspaceRoom.docs.get(docId);
  if (!binding) return;

  if (messageType === MESSAGE_SYNC) {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    encoding.writeVarString(encoder, docId);
    // Baseline-measured, not a fixed byte count — the docId prefix's own
    // encoded length varies with the string, so "was a reply appended"
    // has to be measured from after it was written (see the identical
    // fix on the server side, src/workspace-room.ts).
    const baseLength = encoding.length(encoder);
    syncProtocol.readSyncMessage(decoder, encoder, binding.ydoc, "server");
    if (encoding.length(encoder) > baseLength) send(encoding.toUint8Array(encoder));
  } else if (messageType === MESSAGE_AWARENESS) {
    const update = decoding.readVarUint8Array(decoder);
    awarenessProtocol.applyAwarenessUpdate(binding.awareness, update, "server");
    if (docId === workspaceRoom.activeDocId) updatePresence();
  }
}
```

with:

```ts
  const docId = decoding.readVarString(decoder);
  // A MESSAGE_SYNC frame for a docId we've never seen before means
  // another collaborator created (or first switched to) that document
  // after this session already joined the workspace — see
  // discoverRemoteDocBinding's own comment for why the server always
  // broadcasts this regardless of recipient awareness. A bare
  // MESSAGE_AWARENESS frame for an unrecognized docId is still dropped
  // below: awareness carries no document content to seed a binding
  // with, and the real MESSAGE_SYNC frame introducing the document
  // always arrives too (from that same broadcast), so nothing is lost
  // by waiting for it.
  const isNewToUs = messageType === MESSAGE_SYNC && !workspaceRoom.docs.has(docId);
  const binding = isNewToUs ? discoverRemoteDocBinding(docId) : workspaceRoom.docs.get(docId);
  if (!binding) return;

  if (messageType === MESSAGE_SYNC) {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    encoding.writeVarString(encoder, docId);
    // Baseline-measured, not a fixed byte count — the docId prefix's own
    // encoded length varies with the string, so "was a reply appended"
    // has to be measured from after it was written (see the identical
    // fix on the server side, src/workspace-room.ts).
    const baseLength = encoding.length(encoder);
    syncProtocol.readSyncMessage(decoder, encoder, binding.ydoc, "server");
    if (encoding.length(encoder) > baseLength) send(encoding.toUint8Array(encoder));
    if (isNewToUs) registerDiscoveredDoc(docId, binding);
  } else if (messageType === MESSAGE_AWARENESS) {
    const update = decoding.readVarUint8Array(decoder);
    awarenessProtocol.applyAwarenessUpdate(binding.awareness, update, "server");
    if (docId === workspaceRoom.activeDocId) updatePresence();
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/client/src/collab.test.ts`
Expected: PASS — all tests in the file, including the whole existing suite (this shares the module-level `workspaceRoom` singleton with every other describe block in the file, so a full-file run is the real check, not just the new block in isolation).

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add client/src/collab.ts tests/client/src/collab.test.ts
git commit -m "fix: discover documents created after a workspace connection is already live"
```

---

### Task 2: End-to-end coverage for both collaborators already connected

**Files:**

- Modify: `tests/e2e/collab/live-sync.spec.ts`

**Interfaces:**

- Consumes: `signInAsDevUser` (already imported), `dismissWhatsNew` (already defined at the top of this file), `window.MDE.newDoc()`, `window.MDE.switchDoc(id: string)`, `window.MDE.getEditor()` (all existing bridge methods already used elsewhere in this file).

- [ ] **Step 1: Write the new test**

Add this test at the end of `tests/e2e/collab/live-sync.spec.ts`, after the existing `"a live edit from one collaborator appears in another's browser with no reload"` test:

```ts
test("a document created after both collaborators are already connected appears in the other's document list live", async ({ browser }) => {
  const aliceCtx = await browser.newContext();
  const bobCtx = await browser.newContext();
  const alice = await aliceCtx.newPage();
  const bob = await bobCtx.newPage();

  await signInAsDevUser(alice, "alice-e2e-2");
  await signInAsDevUser(bob, "bob-e2e-2");

  await alice.goto(BASE);
  await alice.waitForFunction(() => window.MDE && typeof window.MDE.getEditor === "function", { timeout: 15000 });
  await dismissWhatsNew(alice);
  await alice.click("#emptyNewWorkspaceBtn");
  await alice.keyboard.press("Escape").catch(() => {});
  await alice.evaluate(() => window.MDE.newDoc());
  await alice.waitForSelector("#editor-mount .cm-content", { state: "visible" });
  await alice.click("#editor-mount .cm-content");
  await alice.keyboard.type("first document content");

  await alice.click('button:has-text("Share")');
  const moveDialog = alice.locator('button:has-text("Continue")');
  if (await moveDialog.isVisible({ timeout: 2000 }).catch(() => false)) {
    await moveDialog.click();
  }
  const accessSelect = alice.locator("select").first();
  await accessSelect.waitFor({ state: "visible" });
  await Promise.all([
    alice.waitForResponse((res) => /\/api\/workspace\/[^/]+\/access$/.test(res.url()) && res.request().method() === "PUT"),
    accessSelect.selectOption({ label: "Anyone with the link" }),
  ]);

  const shareState = await alice.evaluate(() => {
    const workspaces = JSON.parse(localStorage.getItem("mde:workspaces") || "[]");
    const docs = JSON.parse(localStorage.getItem("mde:docs") || "[]");
    const activeId = localStorage.getItem("mde:active");
    const activeDoc = docs.find((d: { id: string }) => d.id === activeId);
    const ws = workspaces.find((w: { id: string }) => w.id === activeDoc?.workspaceId);
    return { activeDoc, ws };
  });
  expect(shareState.ws?.shared).toBe(true);
  const shareUrl = `${BASE}/w/${shareState.ws.remoteId}/${shareState.activeDoc.id}/edit`;

  const doneBtn = alice.locator('button:has-text("Done")');
  if (await doneBtn.isVisible({ timeout: 2000 }).catch(() => false)) await doneBtn.click();
  await alice.keyboard.press("Escape").catch(() => {});

  // Bob joins and fully settles on the first document BEFORE Alice ever
  // creates the second one — unlike an existing regression test
  // (readonly-and-editing-mode.spec.ts) whose second document is created
  // before its viewer ever joins, which already worked via joinWorkspace's
  // own fetchWorkspaceDocIds picking it up at join time. This test is
  // specifically the mid-session case that gap didn't cover.
  await bob.goto(shareUrl);
  await bob.waitForFunction(() => window.MDE && typeof window.MDE.getEditor === "function", { timeout: 15000 });
  const joinModal = bob.locator('text="Join shared workspace"');
  if (await joinModal.isVisible({ timeout: 3000 }).catch(() => false)) {
    await bob.click('button:has-text("Add as new workspace")');
  }
  await dismissWhatsNew(bob);
  await expect.poll(() => bob.evaluate(() => window.MDE.getEditor()?.state?.doc?.toString() ?? "")).toContain("first document content");

  // Only now, after Bob is fully connected and settled on the first
  // document, does Alice create a second one in the same workspace.
  await alice.evaluate(() => window.MDE.newDoc());
  await alice.waitForSelector("#editor-mount .cm-content", { state: "visible" });
  await alice.click("#editor-mount .cm-content");
  await alice.keyboard.type("second document content, created mid-session");

  const secondDocId = await alice.evaluate(() => localStorage.getItem("mde:active"));

  await expect
    .poll(() =>
      bob.evaluate((id) => JSON.parse(localStorage.getItem("mde:docs") || "[]").some((d: { id: string }) => d.id === id), secondDocId),
    )
    .toBe(true);

  await bob.evaluate((id) => window.MDE.switchDoc(id), secondDocId);
  await expect
    .poll(() => bob.evaluate(() => window.MDE.getEditor()?.state?.doc?.toString() ?? ""))
    .toContain("second document content, created mid-session");

  await aliceCtx.close();
  await bobCtx.close();
});
```

- [ ] **Step 2: Run the new test**

Sandboxed Claude Code environments: check `ls /opt/pw-browsers/` for the actual `chromium-*` build present, and temporarily add `launchOptions: { executablePath: "/opt/pw-browsers/chromium" }` under `playwright.config.ts`'s top-level `use` before running (per `CLAUDE.md`'s sandbox note) — revert this after the run, before committing.

Run: `npm run test:e2e:collab` (or, to run just this file if the script supports a path argument, target `tests/e2e/collab/live-sync.spec.ts` directly)
Expected: both tests in `live-sync.spec.ts` PASS.

- [ ] **Step 3: Revert the sandbox-only Playwright config change (if made)**

Confirm `playwright.config.ts` has no `launchOptions` addition left before committing — `git diff playwright.config.ts` should be empty.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/collab/live-sync.spec.ts
git commit -m "test: cover mid-session document discovery in live-sync e2e"
```

---

### Task 3: CHANGELOG, What's New entry, and final verification

**Files:**

- Modify: `CHANGELOG.md`, `client/src/whats-new-entries.ts`

**Interfaces:**

- Consumes: none new.
- Produces: none — this task only documents the change; per `CLAUDE.md`'s versioning convention, the actual `package.json`/`package-lock.json` version bump is deliberately deferred until the user says to ship this branch (see Global Constraints above), so this task does NOT touch either file.

- [ ] **Step 1: Add the CHANGELOG entry**

In `CHANGELOG.md`, insert a new section above `## [1.43.0] - 2026-09-05`:

```markdown
## [1.44.0] - 2026-09-05

### Added

- **A document created in a shared workspace now reaches every already-connected collaborator immediately, not just those who join afterward.** Previously, a document created (or first switched to) after a collaborator's connection was already established never appeared in their document list — no reload or rejoin fixed it short of leaving and re-joining the workspace entirely.
```

(If a `## [1.44.0]` section already exists here from another in-flight branch by the time this is applied, merge this bullet into its `### Added` list instead of creating a second heading — per `CLAUDE.md`'s note on collapsing version headings that never separately shipped.)

- [ ] **Step 2: Add the What's New entry**

In `client/src/whats-new-entries.ts`, append after the `"1.43.0"` (Signed-Out Indicator) entry, before the closing `];`:

```ts
  {
    version: "1.44.0",
    title: "Live Documents, Live Everywhere",
    description:
      "A document created in a shared workspace now shows up immediately for everyone already connected, not just collaborators who join afterward.",
    screenshot: "/whats-new/live-mid-session-docs.png",
    category: "Collaboration",
  },
```

Note: per this repo's existing convention (see e.g. `docs/superpowers/plans/2026-09-05-session-expiry-role-visibility.md`'s own note on this), the `screenshot` path points at an asset (`client/public/whats-new/live-mid-session-docs.png`) that doesn't exist yet. `WhatsNew.svelte`'s dev-mode check only warns about a missing *entry* whose version doesn't match `__APP_VERSION__`, not a missing image, so this doesn't block anything — flag it to the user/reviewer rather than fabricating a placeholder image. If another in-flight branch's own What's New entry has already claimed version `"1.44.0"` by the time this ships, whichever branch is finalized second should renumber its own entry (and its CHANGELOG heading from Step 1) to the next free minor version instead — this is a normal consequence of two features developed in parallel, not a defect in either plan.

- [ ] **Step 3: Verify formatting**

Run: `npx prettier --check CHANGELOG.md client/src/whats-new-entries.ts`
Expected: no errors. If it reports issues, run `npx prettier --write` on the same file list.

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md client/src/whats-new-entries.ts
git commit -m "docs: changelog and what's new entry for mid-session document sync"
```

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: all tests pass (`unit` and `components` projects).

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Format check**

Run: `npm run format:check`
Expected: no errors.

- [ ] **Step 8: Build**

Run: `npm run build`
Expected: builds successfully.

- [ ] **Step 9: Report status**

Summarize for the user: all local checks passing, plus explicitly flag (a) whether `npm run test:e2e:collab` was actually run end-to-end for Task 2's new test, (b) that `client/public/whats-new/live-mid-session-docs.png` still needs a real screenshot before this ships, and (c) that the `package.json`/`package-lock.json` version bump is intentionally not yet done — it happens as the last step before this branch is actually pushed/PR'd, per `CLAUDE.md`.
