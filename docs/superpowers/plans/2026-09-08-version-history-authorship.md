# Version History Authorship — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (inline) or superpowers:subagent-driven-development. Steps use `- [ ]` checkboxes.

**Goal:** Shared-document Version History shows which collaborators edited each version — a name + colour-coded avatar per row, and the de-duped union on a collapsed session — Google-Docs style.

**Architecture:** The server already knows which WebSocket every edit came from. Accumulate the editing usernames per document between snapshot captures (`DocRoom.pendingAuthors`), stamp them onto each `Snapshot` (`authors?: string[]`), expose them from the versions-list endpoint, and render `.presence-avatar` circles on the client's version rows. No per-line tracking, no diff colouring.

**Tech Stack:** TypeScript, Cloudflare Durable Objects (`WorkspaceRoom`), Svelte 5 runes, Vitest (`unit` + `components`), Playwright (`collab`).

**Spec:** `docs/superpowers/specs/2026-09-08-version-history-authorship-design.md`

## Global Constraints

- **Never commit the dev-login patch** — `disable-dev-login.sh` + a clean `git status` (no `src/worker.ts`) before every commit.
- Commit trailer: `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`. PR body ends `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- Two tsconfigs — run `npm run typecheck` (does both). `npm run format` before every commit; `format:check` is CI-enforced.
- e2e-collab sandbox browser mismatch: if "Executable doesn't exist", add `launchOptions:{executablePath:"/opt/pw-browsers/chromium"}` under `playwright.config.ts` `use`, run, revert before commit. Run the `collab` project with `--workers=1`.
- `Snapshot.authors` is **optional** — pre-feature and legacy-migrated snapshots have none; every read path must treat absent as `[]`.
- `pendingAuthors` is in-memory only (like `lastSnapshotAt`); losing it across DO eviction is acceptable degradation, never a correctness bug.
- User-facing → **minor bump `1.48.0`**, `CHANGELOG.md` `### Added`, a `whats-new-entries.ts` entry (`category: "Version History"`) + a real captured screenshot.
- Branch already exists: `feat/version-history-authorship` (rebased on master, spec committed).

---

## File Structure

| File | Responsibility | Task |
| --- | --- | --- |
| `client/src/user-color.ts` | **new** — `COLORS` + `colorForUsername`, extracted so `VersionHistory.svelte` can use it without importing `collab.ts` | 1 |
| `client/src/collab.ts` | import `colorForUsername`/`COLORS` from `./user-color` instead of defining them | 1 |
| `client/src/components/Share.svelte` | import `colorForUsername` from `../user-color` | 1 |
| `src/workspace-room.ts` | `Snapshot.authors?`; `DocRoom.pendingAuthors`; record in `handleDocUpdate`; flush in `maybeSnapshot`; `forceSnapshot(author?)`; restore handlers pass the requester; list endpoint returns `authors` | 2 |
| `client/src/history.ts` | `VersionSummary.authors: string[]` | 3 |
| `client/src/components/VersionHistory.svelte` | `LocalEntry`/`SessionEntry` `authors`; union; `authorAvatars` snippet; render in rows | 3 |
| `client/src/styles/_diff-view.scss` | `.version-history-authors` + `.version-history-author-more` | 3 |
| `tests/src/workspace-room.test.ts` | server capture/flush/restore/list-endpoint | 2 |
| `tests/client/src/components/VersionHistory.test.ts` | avatar rendering, union, empty, overflow | 3 |
| `tests/e2e/collab/version-history-collab.spec.ts` | VER-17 — two collaborators, both attributed | 3 |
| `docs/TEST-COVERAGE.md`, `CHANGELOG.md`, `client/src/whats-new-entries.ts`, `client/public/whats-new/version-history-authors.png`, `tests/scripts/manual-testing/capture-version-history-authors-screenshot.mjs`, `package.json`, `package-lock.json` | 1.48.0 bookkeeping | 4 |

---

## Task 1: Extract `colorForUsername` to its own module

**Files:**
- Create: `client/src/user-color.ts`
- Modify: `client/src/collab.ts`, `client/src/components/Share.svelte`

**Interfaces:**
- Produces: `export const COLORS: string[]`, `export function colorForUsername(name: string): string` in `client/src/user-color.ts`.
- `collab.ts` keeps `export { colorForUsername }` (re-export) so nothing else that imports it from `../collab` breaks — grep first.

- [ ] **Step 1: Grep every importer of `colorForUsername`**

```bash
grep -rn "colorForUsername" client/src tests
```
Expected: defined in `collab.ts`, re-exported there, imported by `Share.svelte` from `../collab`, used internally in `collab.ts` (`buildAvatarEl`). Note anything else the grep turns up and update it in Step 4.

- [ ] **Step 2: Create `client/src/user-color.ts`**

```ts
// Deterministic per-user accent colour — hash the username into the fixed
// palette. Shared by the collab presence avatars, the Share roster, and
// the Version History author avatars. Kept in its own module so a
// component can use it without importing collab.ts's whole editor stack.
export const COLORS = ["#e64980", "#f76707", "#f59f00", "#40c057", "#12b886", "#228be6", "#7950f2", "#e8590c"];

export function colorForUsername(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return COLORS[hash % COLORS.length]!;
}
```

- [ ] **Step 3: Rewire `collab.ts`**

Delete the local `const COLORS = [...]` (line ~71) and the local `function colorForUsername(...)` (near line ~1070). Add to the import block:

```ts
import { COLORS, colorForUsername } from "./user-color";
```

Keep the existing `export { colorForUsername };` line (it re-exports the imported binding — verify `Share.svelte` still resolves it, or do Step 4). Every internal `COLORS[...]` / `colorForUsername(...)` call now resolves to the import.

- [ ] **Step 4: Point `Share.svelte` (and anything from Step 1) at the new module**

In `client/src/components/Share.svelte`, change:
```ts
import { closeShareModal, setAccessMode, setRole, setInviteRole, buildShareLink, addPerson, removeInvite, colorForUsername, DEFAULT_ACCESS, type AccessMode } from "../collab";
```
to drop `colorForUsername` from that import and add:
```ts
import { colorForUsername } from "../user-color";
```
Then the `export { colorForUsername }` in `collab.ts` can also be removed if Step 1 found no other `../collab` importer of it — otherwise leave it.

- [ ] **Step 5: Typecheck + unit + a quick build**

```bash
npm run typecheck
npm test
npm run build
```
Expected: 0 type errors, all tests pass (948), build succeeds. `Share.test.ts` still green (it imports `../collab` for the action fns — unaffected).

- [ ] **Step 6: Commit**

```bash
npm run format
git add client/src/user-color.ts client/src/collab.ts client/src/components/Share.svelte
git commit -m "$(cat <<'EOF'
refactor: extract colorForUsername into its own module

So Version History can render per-user avatars without importing collab.ts.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Server — record and expose per-snapshot authors

**Files:**
- Modify: `src/workspace-room.ts`
- Modify: `tests/src/workspace-room.test.ts`

**Interfaces:**
- Produces:
  - `Snapshot.authors?: string[]` — GitHub usernames who edited in this snapshot's window, first-seen order.
  - `DocRoom.pendingAuthors: Set<string>`.
  - `forceSnapshot(docId, docRoom, content, now?, author?: string)` — `author` stored as the sole `authors` entry.
  - `GET …/versions` items: `{ id, timestamp, authors: string[] }` (always an array).

- [ ] **Step 1: Write the failing tests**

Add to `tests/src/workspace-room.test.ts`, in a new `describe("Snapshot authorship")` block. Use the existing helpers (`fakeState`, `fakeEnv`, `encodeSyncUpdate`, `scratchUpdateWith` from the `"reviewer writes"` block — hoist or duplicate the tiny `scratchUpdateWith` if it's not in scope).

```ts
describe("Snapshot authorship", () => {
  function edit(room: WorkspaceRoom, docId: string, ws: WebSocket, text: string) {
    return room.handleMessage(ws, encodeSyncUpdate(docId, scratchUpdateWith(text)));
  }

  it("stamps a snapshot with every username that edited in its window, first-seen order", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnv);
    const alice = { send: () => {} } as unknown as WebSocket;
    const bob = { send: () => {} } as unknown as WebSocket;
    (room as any).sessions.set(alice, { username: "alice", role: "editor", viewingDocId: null });
    (room as any).sessions.set(bob, { username: "bob", role: "editor", viewingDocId: null });

    const docRoom = await room.loadDocRoom("d1");
    await edit(room, "d1", alice, "hello");
    await edit(room, "d1", bob, "hello world");
    await room.maybeSnapshot("d1", docRoom, 1_000);

    const snaps = await room.getSnapshots("d1");
    expect(snaps.at(-1)!.authors).toEqual(["alice", "bob"]);
    expect(docRoom.pendingAuthors.size).toBe(0); // flushed
  });

  it("ignores edits from an anonymous session", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnv);
    const anon = { send: () => {} } as unknown as WebSocket;
    (room as any).sessions.set(anon, { username: null, role: "editor", viewingDocId: null });
    const docRoom = await room.loadDocRoom("d1");
    await room.handleMessage(anon, encodeSyncUpdate("d1", scratchUpdateWith("x")));
    await room.maybeSnapshot("d1", docRoom, 1_000);
    expect((await room.getSnapshots("d1")).at(-1)!.authors).toBeUndefined();
  });

  it("carries authors from a throttled (skipped) capture into the next real one", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnv);
    const alice = { send: () => {} } as unknown as WebSocket;
    (room as any).sessions.set(alice, { username: "alice", role: "editor", viewingDocId: null });
    const docRoom = await room.loadDocRoom("d1");

    await edit(room, "d1", alice, "one");
    await room.maybeSnapshot("d1", docRoom, 1_000);          // captures, authors: ["alice"]
    await edit(room, "d1", alice, "one two");
    await room.maybeSnapshot("d1", docRoom, 1_000 + 5_000);  // < 30s -> skipped, pendingAuthors keeps "alice"
    const bob = { send: () => {} } as unknown as WebSocket;
    (room as any).sessions.set(bob, { username: "bob", role: "editor", viewingDocId: null });
    await edit(room, "d1", bob, "one two three");
    await room.maybeSnapshot("d1", docRoom, 1_000 + 35_000); // captures, authors: ["alice", "bob"]

    expect((await room.getSnapshots("d1")).at(-1)!.authors).toEqual(["alice", "bob"]);
  });

  it("forceSnapshot records the restoring user; a restore via the endpoint attributes the requester", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnv);
    const docRoom = await room.loadDocRoom("d1");
    const snap = await room.forceSnapshot("d1", docRoom, "restored", 2_000, "carol");
    expect(snap.authors).toEqual(["carol"]);
  });

  it("the versions list returns authors, [] for a legacy author-less snapshot", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnv);
    await room.state.storage.put("doc:d1:snapshots", [
      { id: "s1", timestamp: 1, content: "a" },                       // legacy, no authors
      { id: "s2", timestamp: 2, content: "b", authors: ["alice"] },
    ]);
    const res = await room.handleVersionsListRequest(new Request("https://x/w/w1/docs/d1/versions", { method: "GET", headers: { Cookie: authCookie } }), "d1");
    const list = (await res.json()) as Array<{ id: string; authors: string[] }>;
    // newest-first
    expect(list.find((x) => x.id === "s1")!.authors).toEqual([]);
    expect(list.find((x) => x.id === "s2")!.authors).toEqual(["alice"]);
  });
});
```

For the list-endpoint test, reuse whatever cookie/auth setup the existing `handleVersionsListRequest` tests in this file use (search `handleVersionsListRequest` — it needs `authorize` to pass, i.e. an `access` record with an `owner` and a session cookie; mirror the nearest existing version-endpoint test exactly).

- [ ] **Step 2: Run them — verify they FAIL**

```bash
npx vitest run tests/src/workspace-room.test.ts -t "authorship"
```
Expected: fail — `authors` is undefined everywhere, `pendingAuthors` doesn't exist, `forceSnapshot` has no 5th param.

- [ ] **Step 3: `Snapshot.authors?` + `DocRoom.pendingAuthors`**

`src/workspace-room.ts` — `Snapshot` interface (~line 47):
```ts
export interface Snapshot {
  id: string;
  timestamp: number;
  content: string;
  images?: Record<string, string>;
  authors?: string[]; // usernames who edited in this snapshot's window, first-seen order; absent on pre-feature / migrated snapshots
}
```

`DocRoom` interface (~line 95) — add `pendingAuthors: Set<string>;`. In `loadDocRoom`'s `const docRoom: DocRoom = { ... }` literal (~line 171), add `pendingAuthors: new Set(),`.

- [ ] **Step 4: Record the editor in `handleDocUpdate`**

`src/workspace-room.ts` `handleDocUpdate` (~line 568). After the `if (origin === "storage") return;` line and before `this.refreshCommentAnchors(...)`:

```ts
    const editor = this.sessions.get(origin as WebSocket);
    if (editor?.username) docRoom.pendingAuthors.add(editor.username);
```

(`origin` is `"restore"` — a string, never a `sessions` key — for a restore, so `editor` is `undefined` there; the restore's author is set in Step 6.)

- [ ] **Step 5: Flush into the snapshot in `maybeSnapshot`**

`src/workspace-room.ts` `maybeSnapshot` (~line 666) — replace the `snapshots.push({...})` line:

```ts
    const authors = [...docRoom.pendingAuthors];
    snapshots.push({ id: uid(), timestamp: now, content, images: this.imagesFromDoc(docRoom), authors: authors.length ? authors : undefined });
    while (snapshots.length > 300) snapshots.shift();
    await this.state.storage.put(docStorageKey(docId, "snapshots"), snapshots);
    docRoom.lastSnapshotAt = now;
    docRoom.pendingAuthors.clear();
```

Leave the two early-return branches (`< 30s`; `last.content === content`) untouched — `pendingAuthors` deliberately carries forward through them.

- [ ] **Step 6: `forceSnapshot` author param + restore attribution**

`forceSnapshot` (~line 672):
```ts
  async forceSnapshot(docId: string, docRoom: DocRoom, content: string, now: number = Date.now(), author?: string): Promise<Snapshot> {
    const snapshots = await this.getSnapshots(docId);
    const snap: Snapshot = { id: uid(), timestamp: now, content, images: this.imagesFromDoc(docRoom), authors: author ? [author] : undefined };
    snapshots.push(snap);
    while (snapshots.length > 50) snapshots.shift();
    await this.state.storage.put(docStorageKey(docId, "snapshots"), snapshots);
    docRoom.lastSnapshotAt = now;
    docRoom.pendingAuthors.clear();
    return snap;
  }
```

In `handleVersionRestoreRequest` (~line 721): `const created = await this.forceSnapshot(docId, docRoom, snap.content, Date.now(), auth.username ?? undefined);`
In `handleVersionRestoreContentRequest` (~line 749): `const created = await this.forceSnapshot(docId, docRoom, content, Date.now(), auth.username ?? undefined);`

- [ ] **Step 7: List endpoint returns authors**

`handleVersionsListRequest` (~line 687):
```ts
    const list = snapshots.map((s) => ({ id: s.id, timestamp: s.timestamp, authors: s.authors ?? [] })).reverse();
```

- [ ] **Step 8: Run the tests — verify they PASS**

```bash
npx vitest run tests/src/workspace-room.test.ts
```
Expected: all pass, including the 5 new. Then `npm run typecheck` (0 errors) and `npm test` (full suite — a couple of existing `handleInternalSeedRequest` / restore tests may assert exact `Snapshot` shape with `toEqual`; if one now fails on the extra `authors: undefined` key, switch it to `toMatchObject` or add `authors: undefined` — do **not** weaken a content assertion).

- [ ] **Step 9: Commit**

```bash
npm run format
git add src/workspace-room.ts tests/src/workspace-room.test.ts
git commit -m "$(cat <<'EOF'
feat(server): record which collaborators edited each version snapshot

handleDocUpdate accumulates the editing session's username into
DocRoom.pendingAuthors; maybeSnapshot flushes the set onto the new
Snapshot.authors and clears it; forceSnapshot (restore) attributes the
requester. The versions-list endpoint returns authors ([] for
pre-feature / migrated snapshots).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Client — render author avatars on version rows

**Files:**
- Modify: `client/src/history.ts`, `client/src/components/VersionHistory.svelte`, `client/src/styles/_diff-view.scss`
- Modify: `tests/client/src/components/VersionHistory.test.ts`
- Modify: `tests/e2e/collab/version-history-collab.spec.ts`

**Interfaces:**
- Consumes: `VersionSummary.authors: string[]` from `listSharedVersions`; `colorForUsername` from `../user-color` (Task 1).
- Produces: `LocalEntry.authors: string[]`, `SessionEntry.authors: string[]` (union), an `authorAvatars` snippet.

- [ ] **Step 1: Write the failing component tests**

Add to `tests/client/src/components/VersionHistory.test.ts` (it already stubs `window.MDE` and sets `workspacesStore`/`docsStore`; for shared mode it uses a `vi.stubGlobal("fetch", …)` — mirror the existing shared-versions test, `VER-08`, for the fetch shape):

```ts
test("VER-16: a shared version row shows an avatar per editor", async () => {
  // workspace shared (remoteId), fetch stub returns the versions list with authors
  // ... mirror VER-08's setup ...
  fetchSpy = vi.fn(async (url: string) => {
    if (String(url).endsWith("/versions")) return json([{ id: "s1", timestamp: 1000, authors: ["alice", "bob"] }]);
    if (String(url).includes("/versions/s1")) return json({ content: "x", images: {} });
    return json([]);
  });
  vi.stubGlobal("fetch", fetchSpy);
  const screen = await render(VersionHistory);
  versionHistoryOpen.set(true);
  await expect.element(screen.getByText(/1970/)).toBeVisible();
  const row = screen.container.querySelector(".version-history-row")!;
  expect(row.querySelectorAll(".presence-avatar").length).toBe(2);
  expect(row.querySelector(".version-history-authors")!.getAttribute("title")).toContain("alice");
  expect(row.querySelector(".version-history-authors")!.getAttribute("title")).toContain("bob");
});

test("VER-16: a session header shows the de-duped union of its entries' editors", async () => {
  // two snapshots 35s apart -> one session; s1 authors [alice], s2 authors [bob]
  fetchSpy = vi.fn(async (url: string) => {
    if (String(url).endsWith("/versions")) return json([
      { id: "s1", timestamp: 1000, authors: ["alice"] },
      { id: "s2", timestamp: 1000 + 35_000, authors: ["bob", "alice"] },
    ]);
    if (String(url).includes("/versions/")) return json({ content: "x", images: {} });
    return json([]);
  });
  vi.stubGlobal("fetch", fetchSpy);
  const screen = await render(VersionHistory);
  versionHistoryOpen.set(true);
  await expect.element(screen.getByText(/edits/)).toBeVisible();
  const header = screen.container.querySelector(".version-history-session-header")!;
  const names = header.querySelector(".version-history-authors")!.getAttribute("title")!;
  expect(names).toBe("alice, bob"); // first-seen order, once each
});

test("VER-16: a row with no authors renders no avatar", async () => {
  fetchSpy = vi.fn(async (url: string) => {
    if (String(url).endsWith("/versions")) return json([{ id: "s1", timestamp: 1000, authors: [] }]);
    if (String(url).includes("/versions/s1")) return json({ content: "x", images: {} });
    return json([]);
  });
  vi.stubGlobal("fetch", fetchSpy);
  const screen = await render(VersionHistory);
  versionHistoryOpen.set(true);
  await expect.element(screen.getByText(/1970/)).toBeVisible();
  expect(screen.container.querySelector(".version-history-row .presence-avatar")).toBeNull();
});

test("VER-16: more than three editors collapse to 3 avatars + a +N chip", async () => {
  fetchSpy = vi.fn(async (url: string) => {
    if (String(url).endsWith("/versions")) return json([{ id: "s1", timestamp: 1000, authors: ["a", "b", "c", "d", "e"] }]);
    if (String(url).includes("/versions/s1")) return json({ content: "x", images: {} });
    return json([]);
  });
  vi.stubGlobal("fetch", fetchSpy);
  const screen = await render(VersionHistory);
  versionHistoryOpen.set(true);
  await expect.element(screen.getByText(/1970/)).toBeVisible();
  const row = screen.container.querySelector(".version-history-row")!;
  expect(row.querySelectorAll(".presence-avatar").length).toBe(3);
  expect(row.querySelector(".version-history-author-more")!.textContent).toContain("+2");
});
```

Add a `json` helper at the top of the file if not present: `const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });`. Assign `fetchSpy` from a `let` and `vi.unstubAllGlobals()` in `afterEach` (mirror the existing tests).

- [ ] **Step 2: Run — verify they FAIL**

```bash
npx vitest run --project=components tests/client/src/components/VersionHistory.test.ts -t "VER-16"
```
Expected: fail — no `.version-history-authors` element.

- [ ] **Step 3: `VersionSummary.authors`**

`client/src/history.ts` (~line 26):
```ts
export interface VersionSummary {
  id: string;
  timestamp: number;
  authors: string[];
}
```
`listSharedVersions` returns `(await res.json()) as VersionSummary[]` unchanged (the endpoint now always includes `authors`). `listVersions` (local) — its objects have no `authors`; that's handled at the `VersionHistory.svelte` map in Step 5.

- [ ] **Step 4: `LocalEntry` / `SessionEntry` gain `authors`**

`client/src/components/VersionHistory.svelte` (~line 26):
```ts
  interface LocalEntry {
    kind: "local";
    id: string;
    timestamp: number;
    authors: string[];
  }
```
`SessionEntry` (~line 39) — add `authors: string[];`.

- [ ] **Step 5: Populate them in `loadVersions`**

`~line 291`:
```ts
    const localEntries: LocalEntry[] = localList
      .map((v) => ({ kind: "local" as const, id: v.id, timestamp: v.timestamp, authors: (v as { authors?: string[] }).authors ?? [] }))
      .sort((a, b) => a.timestamp - b.timestamp);
    const groupedLocalEntries: HistoryEntry[] = groupSnapshotsIntoSessions(localEntries).map((g) =>
      g.entries.length > 1
        ? {
            kind: "session" as const,
            id: g.entries[0]!.id,
            timestamp: g.endTimestamp,
            startTimestamp: g.startTimestamp,
            endTimestamp: g.endTimestamp,
            entries: g.entries,
            authors: [...new Set(g.entries.flatMap((e) => e.authors))],
          }
        : g.entries[0]!,
    );
```

- [ ] **Step 6: Import `colorForUsername` + add the `authorAvatars` snippet**

Add to the import block: `import { colorForUsername } from "../user-color";`

Add a snippet near the top of the markup (after the `{#snippet ...}` blocks if any, else just before the main content):
```svelte
{#snippet authorAvatars(names: string[])}
  {#if names.length}
    <span class="version-history-authors" title={names.join(", ")} aria-label={`Edited by ${names.join(", ")}`}>
      {#each names.slice(0, 3) as name (name)}
        <span class="presence-avatar presence-avatar-sm" style:background={colorForUsername(name)}>{name.charAt(0).toUpperCase()}</span>
      {/each}
      {#if names.length > 3}<span class="version-history-author-more">+{names.length - 3}</span>{/if}
    </span>
  {/if}
{/snippet}
```

- [ ] **Step 7: Render it in the three row types**

- Standalone `LocalEntry` row (`~line 458`, non-commit branch) — after the `{#if i === 0}...(current){/if}`:
  `{#if v.kind === "local"}{@render authorAvatars(v.authors)}{/if}`
- `SessionEntry` header (`~line 427`) — after the `(includes current)` span:
  `{@render authorAvatars(v.authors)}`
- Nested row inside an expanded session (`~line 438`) — after the `(current)` span:
  `{@render authorAvatars(nested.authors)}`

(`CommitEntry` rows keep their existing `author` text — untouched.)

- [ ] **Step 8: Styles**

`client/src/styles/_diff-view.scss`, next to the existing `.version-history-row-label` / `.version-history-current` rules:
```scss
.version-history-authors {
  display: inline-flex;
  align-items: center;
  margin-left: auto;
  padding-left: 8px;
  .presence-avatar { margin-left: -6px; }
  .presence-avatar:first-child { margin-left: 0; }
}
.version-history-author-more {
  margin-left: 4px;
  font-size: 11px;
  color: var(--text-dim);
}
```
(If `.presence-avatar-sm` isn't already defined in `_share-workspace.scss` — it is, line 58 — leave it; reuse.)

- [ ] **Step 9: Run component tests — verify PASS**

```bash
npx vitest run --project=components tests/client/src/components/VersionHistory.test.ts
```
Expected: all pass (existing 8 + 4 new). Then `npm run typecheck`.

- [ ] **Step 10: VER-17 e2e**

Add to `tests/e2e/collab/version-history-collab.spec.ts` (imports `signInAsDevUser` — add it):

```ts
test("VER-17: a shared version is attributed to the collaborators who edited it", async ({ browser }) => {
  const ownerCtx = await browser.newContext();
  const peerCtx = await browser.newContext();
  const owner = await ownerCtx.newPage();
  const peer = await peerCtx.newPage();

  await ownerWithDoc(owner, "ver17-owner", "");
  const url = await shareAnyoneLink(owner, "Editor");
  await signInAsDevUser(peer, "ver17-peer");
  await joinSharedWorkspace(peer, url);

  // Owner's edit lands first (first sync update -> snapshot #1 captured).
  await owner.evaluate(() => { const cm = window.MDE.getEditor(); cm.dispatch({ changes: { from: 0, to: cm.state.doc.length, insert: "owner line" } }); });
  await expectEditorContains(peer, "owner line");
  await peer.evaluate(() => { const cm = window.MDE.getEditor(); cm.dispatch({ changes: { from: cm.state.doc.length, insert: " + peer line" } }); });
  await expectEditorContains(owner, "peer line");

  await peer.click("#versionHistoryBtn");
  await expect(peer.locator(".version-history-row .version-history-authors").first()).toBeVisible({ timeout: 10000 });
  // The captured snapshot's window saw the owner (and, depending on timing, the peer) — at minimum the owner is attributed.
  await expect(peer.locator(".version-history-authors").first()).toHaveAttribute("title", /ver17-owner/);
});
```
Snapshot-cadence caveat (see VER-08): only assert what the one reliably-captured snapshot contains — the owner's username. If the peer's edit also lands in-window, great, but don't require it.

- [ ] **Step 11: Run e2e**

```bash
bash tests/scripts/manual-testing/enable-dev-login.sh && npm run build
# wrangler dev on :8787
npx playwright test --project=collab tests/e2e/collab/version-history-collab.spec.ts --workers=1 --timeout=60000
# then full collab project; disable-dev-login; git status clean
```

- [ ] **Step 12: Commit**

```bash
npm run format
git add client/src/history.ts client/src/components/VersionHistory.svelte client/src/styles/_diff-view.scss tests/client/src/components/VersionHistory.test.ts tests/e2e/collab/version-history-collab.spec.ts
git commit -m "$(cat <<'EOF'
feat: show who edited each version in Version History

Shared version rows (and collapsed session headers) render a colour-coded
avatar per collaborator who edited in that window, reusing the presence
palette. Rows with no author data (pre-feature / migrated snapshots) are
unchanged.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Catalogue, 1.48.0 bookkeeping, screenshot, PR

**Files:**
- Modify: `docs/TEST-COVERAGE.md`, `CHANGELOG.md`, `client/src/whats-new-entries.ts`, `package.json`, `package-lock.json`
- Create: `tests/scripts/manual-testing/capture-version-history-authors-screenshot.mjs`, `client/public/whats-new/version-history-authors.png`

- [ ] **Step 1: Catalogue**

`docs/TEST-COVERAGE.md` §8 — add rows:
- VER-15 (or next free id): "A shared version snapshot records the usernames that edited in its window; a restore attributes the restorer" — `integration`, `covered`, `tests/src/workspace-room.test.ts`.
- VER-16: "Version History renders a colour-coded avatar per editor on shared version rows / session headers; none for author-less snapshots; 3 + overflow chip" — `component`, `covered`, `tests/client/src/components/VersionHistory.test.ts`.
- VER-17: "A shared version is attributed live to the collaborators who edited it" — `e2e-collab`, `covered`.

Bump §8 tally (`covered` +3, `total` +3 → 22) and the `**Total**` row (`covered` +3 → 301, total +3 → 314). Re-verify the subsystem rows sum to the Total.

- [ ] **Step 2: CHANGELOG**

```markdown
## [1.48.0] - <today>

### Added

- **Version History shows who edited each version.** A shared document's version list now marks every version — and every collapsed editing session — with a colour-coded avatar for each collaborator whose edits it contains, the same way the live presence avatars work. Restoring a version is attributed to whoever restored it. (Versions saved before this update carry no author and show none.)
```

- [ ] **Step 3: Bump** — `package.json` line 4 + `package-lock.json` lines 3 & ~9: `1.47.2` → `1.48.0`.

- [ ] **Step 4: Screenshot capture script**

Create `tests/scripts/manual-testing/capture-version-history-authors-screenshot.mjs`, modelled on `capture-share-collaborator-view-screenshot.mjs`: sign in two dev users (`maria`, `devon`), `maria` creates + shares a workspace, `devon` joins, both make one atomic `cm.dispatch` edit ~1.5s apart, wait for a `.version-history-authors` to appear, `devon` opens `#versionHistoryBtn`, screenshot to `client/public/whats-new/version-history-authors.png`. Use `chromium.launch({ executablePath: "/opt/pw-browsers/chromium" })` (match the sibling scripts; on a real dev machine run a temp copy with a bare `chromium.launch()`).

- [ ] **Step 5: Capture it**

```bash
bash tests/scripts/manual-testing/enable-dev-login.sh && npm run build
# wrangler dev on :8787
node tests/scripts/manual-testing/capture-version-history-authors-screenshot.mjs
bash tests/scripts/manual-testing/disable-dev-login.sh
```
Confirm `client/public/whats-new/version-history-authors.png` exists and shows the version list with avatars.

- [ ] **Step 6: What's New entry**

Append to `WHATS_NEW_ENTRIES` (oldest-first, so at the end):
```ts
  {
    version: "1.48.0",
    title: "See Who Changed What",
    description:
      "Version History now shows a colour-coded avatar for every collaborator whose edits a version contains — on each version and each collapsed editing session — so you can tell at a glance whose work you're about to restore or compare.",
    screenshot: "/whats-new/version-history-authors.png",
    category: "Version History",
  },
```

- [ ] **Step 7: Full verification**

```bash
npm run typecheck && npm test && npm run format:check
# build, wrangler dev, full collab e2e project, disable-dev-login, git status clean
```
Expected: green. `whats-new-entries.test.ts` / `whats-new.test.ts` pass (`"Version History"` is a known category; version matches `__APP_VERSION__`).

- [ ] **Step 8: Commit + PR + merge**

```bash
npm run format
git add docs/TEST-COVERAGE.md CHANGELOG.md client/src/whats-new-entries.ts package.json package-lock.json tests/scripts/manual-testing/capture-version-history-authors-screenshot.mjs client/public/whats-new/version-history-authors.png
git commit -m "$(cat <<'EOF'
chore(release): version history authorship — v1.48.0

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
git push -u origin feat/version-history-authorship
```
PR against `master`, body summarising the feature + the three test layers + the deferrals from the spec. Wait for CI green, merge with a merge commit, fast-forward local `master`.

---

## Self-Review

**Spec coverage:**
- `Snapshot.authors?` / `DocRoom.pendingAuthors` → Task 2 Step 3.
- Record in `handleDocUpdate` → Task 2 Step 4. Flush in `maybeSnapshot` → Step 5. `forceSnapshot` author + restore attribution → Step 6. List endpoint → Step 7.
- Legacy/migrated snapshots author-less, `?? []` everywhere → Task 2 Step 1 (test), Step 7; Task 3 Step 5.
- `VersionSummary.authors` → Task 3 Step 3. `LocalEntry`/`SessionEntry` + union → Steps 4–5. `authorAvatars` snippet + render → Steps 6–7. Styles → Step 8.
- `colorForUsername` reused without importing `collab.ts` → Task 1 (extraction).
- Tests: server unit (Task 2), component (Task 3 Steps 1/9), VER-17 e2e (Task 3 Step 10).
- 1.48.0 + CHANGELOG `### Added` + What's New + screenshot → Task 4.
- Non-goals (diff colouring, blame, named versions, local-doc attribution, back-fill) — not implemented; nothing in the plan touches them.

**Placeholder scan:** `<today>`, `<next free id>` are fill-ins the executor resolves. Component-test steps say "mirror VER-08's setup" — VER-08 is in the same file the executor edits and reads in Task 3 Step 1; the new assertions are given in full. No "add error handling" hand-waves.

**Type consistency:** `Snapshot.authors?: string[]` (optional, server) vs `VersionSummary.authors: string[]` (required, wire — endpoint normalises) vs `LocalEntry.authors: string[]` (required, client) — deliberate and each conversion point is named (Task 2 Step 7 `?? []`; Task 3 Step 5 `?? []`). `forceSnapshot(..., author?: string)` — signature stated once (Task 2 Step 6) and both call sites updated in the same step. `authorAvatars(names: string[])` snippet — one signature, three call sites (Task 3 Step 7).

**Ordering:** Task 1 (refactor) is independent and lands first so Task 3's import resolves. Task 2 (server) and Task 3 (client) share only the wire contract (`authors: string[]` on the list response), pinned by tests on both sides. Task 4 depends on 2+3. A reviewer can reject the client rendering without touching the server capture.
