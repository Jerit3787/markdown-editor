# Share modal & dropdown for joined collaborators — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the workspace Share modal and topbar Share dropdown address the collaboration room by `ws.remoteId` (not the local `doc.workspaceId` or the retired per-document endpoint), and render the modal read-only for collaborators who joined a workspace they don't own — Google-Docs style.

**Architecture:** Three client-side bugs, one root cause. Add a `shareRoomId(workspaceId)` resolver in `collab.ts` and route the eight share-flow API calls through it; point the topbar dropdown at the workspace access endpoint and delete the two dead legacy wrappers; add an `isReadOnly` derived in `Share.svelte` that disables the mutation controls (never the Copy-link button) for non-owners and shows the real owner. Server is unchanged.

**Tech Stack:** TypeScript, Svelte 5 runes, Vitest (`unit` + `components` projects), Playwright (`collab` project against a real `wrangler dev` + Durable Objects).

**Spec:** `docs/superpowers/specs/2026-09-07-share-modal-joined-collaborators-design.md`

## Global Constraints

- **Never commit the dev-login patch.** `tests/scripts/manual-testing/enable-dev-login.sh` mutates `src/worker.ts`; run `disable-dev-login.sh` and confirm `git status` is clean before every commit.
- **Commit trailer:** `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>` — nothing else, no `Claude-Session` link.
- **Two tsconfigs:** root (`src/**`, strict) and `client/tsconfig.json` (`client/src/**`, `strictNullChecks`/`noImplicitAny` off). Run `npm run typecheck` (does both) after code changes.
- **`npm run format` / `format:check`** — Prettier is CI-enforced.
- **e2e-collab in a sandbox:** the pinned Playwright browser may not match `/opt/pw-browsers/`. If `npm run test:e2e:collab` fails with "Executable doesn't exist", check `ls /opt/pw-browsers/` for the real `chromium-*` build and temporarily add `launchOptions: { executablePath: "/opt/pw-browsers/chromium" }` under `playwright.config.ts`'s top-level `use`, run, then revert before committing.
- **`shareRoomId` fallback is load-bearing:** `?? workspaceId` keeps the owner's *first* share correct (no `remoteId` yet). Do not tighten it to require `remoteId`.
- **Do not touch** the `workspacesStore.update((w) => w.id === doc.workspaceId ? … : w)` lines inside `setAccessMode` / `addPerson` — they key by local id on purpose.
- **Version bump only in the final task**, immediately before the PR.

---

## File Structure

| File | Responsibility | Task |
| --- | --- | --- |
| `client/src/collab.ts` | Add `shareRoomId`; route 8 share-flow calls through it; point the dropdown at `fetchWorkspaceAccess`; delete dead `fetchAccess`/`putAccess` | 1 |
| `client/src/history.ts`, `client/src/comments.ts` | One-line comment refresh (they name the deleted wrappers) | 1 |
| `client/src/components/Share.svelte` | `isReadOnly` derived; `disabled` on the 5 mutation-control groups; owner-only hint; real owner name | 2 |
| `tests/client/src/components/Share.test.ts` | New — `isReadOnly` gating in isolation | 2 |
| `tests/e2e/collab/live-collab.spec.ts` | COLLAB-23a (non-owner modal + link) and COLLAB-23b (dropdown label) | 1 + 2 |
| `docs/TEST-COVERAGE.md` | COLLAB-23 `gap → covered` | 3 |
| `CHANGELOG.md`, `client/src/whats-new-entries.ts`, `client/public/whats-new/share-collaborator-view.png`, `tests/scripts/manual-testing/capture-share-collaborator-view-screenshot.mjs`, `package.json`, `package-lock.json` | 1.47.0 release bookkeeping | 3 |

---

## Task 1: Address the collaboration room correctly everywhere

**Files:**
- Modify: `client/src/collab.ts`
- Modify: `client/src/history.ts` (1 comment), `client/src/comments.ts` (1 comment)
- Create: `tests/e2e/collab/live-collab.spec.ts` additions (COLLAB-23a partial, COLLAB-23b)

**Interfaces:**
- Produces: `function shareRoomId(workspaceId: string): string` — module-private in `collab.ts`. Returns `workspacesStore` entry's `remoteId` if present, else the passed `workspaceId`.
- Consumes: existing `fetchWorkspaceAccess(workspaceId: string)`, `putWorkspaceAccess(workspaceId: string, body)`, `get`, `workspacesStore` — all already imported in `collab.ts`.

- [ ] **Step 1: Write the failing e2e test (COLLAB-23b — dropdown label)**

Append to `tests/e2e/collab/live-collab.spec.ts` (imports `ownerWithDoc, shareAnyoneLink` already present at the top of that file):

```ts
test("COLLAB-23b: the topbar Share dropdown shows the real general-access level, not always 'Restricted'", async ({ browser }) => {
  const ctx = await browser.newContext();
  const owner = await ctx.newPage();

  await ownerWithDoc(owner, "share-dropdown-e2e", "body");
  await shareAnyoneLink(owner, "Editor"); // sets general access to "anyone with the link"

  // Open the split-button dropdown next to Share.
  await owner.click("#shareDropdownBtn");
  await expect(owner.locator("#shareAccessTitle")).toHaveText("Anyone with the link", { timeout: 5000 });

  await ctx.close();
});
```

- [ ] **Step 2: Write the failing e2e test (COLLAB-23a — non-owner modal access + link)**

Append to the same file. `signInAsDevUser` needs importing — add `import { signInAsDevUser } from "./support/dev-login";` to the file's import block.

```ts
test("COLLAB-23a: a joined non-owner's Share modal shows the real access and copies a room-id link", async ({ browser }) => {
  const ownerCtx = await browser.newContext();
  const peerCtx = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const owner = await ownerCtx.newPage();
  const peer = await peerCtx.newPage();

  await ownerWithDoc(owner, "share-owner-e2e", "shared body");
  const url = await shareAnyoneLink(owner, "Editor");
  const roomId = url.match(/\/w\/([^/]+)\//)![1]!;

  // A different signed-in GitHub user joins the link as their own new workspace.
  await signInAsDevUser(peer, "share-peer-e2e");
  await joinSharedWorkspace(peer, url);
  await expectEditorContains(peer, "shared body");

  const localWsId = await peer.evaluate(() => {
    const wss = JSON.parse(localStorage.getItem("mde:workspaces") || "[]");
    const active = localStorage.getItem("mde:activeWorkspace");
    return wss.find((w: { id: string }) => w.id === active)?.id ?? null;
  });
  expect(localWsId).toBeTruthy();
  expect(localWsId).not.toBe(roomId);

  await peer.click("#shareBtn");
  // The General-access select reflects the real setting (was always "restricted").
  await expect(peer.locator('select[aria-label="General access"]')).toHaveValue("anyone-link", { timeout: 5000 });

  await peer.locator('button.secondary-btn:has-text("Copy link")').click();
  const copied = await peer.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain(`/w/${roomId}/`);
  expect(copied).not.toContain(`/w/${localWsId}/`);

  await ownerCtx.close();
  await peerCtx.close();
});
```

`joinSharedWorkspace`, `expectEditorContains` are already imported in this file. Verify the import line reads:
`import { ownerWithDoc, shareAnyoneLink, joinSharedWorkspace, editorText, expectEditorContains, BASE } from "./support/collab";` — it does; leave it.

- [ ] **Step 3: Run the two new tests — verify they FAIL**

```bash
bash tests/scripts/manual-testing/enable-dev-login.sh
npx wrangler dev --local-upstream localhost:8787 &
# wait for http://localhost:8787 to answer
npx playwright test --project=collab tests/e2e/collab/live-collab.spec.ts -g "COLLAB-23" --workers=1 --timeout=60000
```
Expected: **COLLAB-23b** fails — `#shareAccessTitle` reads "Restricted". **COLLAB-23a** fails — the General-access select reads "restricted" (and/or the copied link contains the local id / Copy link is disabled).

- [ ] **Step 4: Add the `shareRoomId` resolver**

In `client/src/collab.ts`, immediately after `fetchWorkspaceAccess` (ends ~line 1131), add:

```ts
// The collaboration room's id for a given local workspace id. A workspace
// this session JOINED has a local id distinct from the room's id — the two
// only coincide for the workspace's original owner, and only once their
// first share has claimed the room (before that, remoteId is undefined and
// the local id IS the id the room will be keyed by, so the ?? fallback is
// correct). Same resolution as wikilink-rename-cascade.ts and, since
// PR #159, CommentsPanel / VersionHistory.
function shareRoomId(workspaceId: string): string {
  const ws = get(workspacesStore).find((w) => w.id === workspaceId);
  return ws?.remoteId ?? workspaceId;
}
```

- [ ] **Step 5: Route `openShareModal` through it**

In `openShareModal` (~line 1407), change:

```ts
  currentAccess = await fetchWorkspaceAccess(targetWorkspaceId);
```
to:
```ts
  currentAccess = await fetchWorkspaceAccess(shareRoomId(targetWorkspaceId));
```

(`targetWorkspaceId` stays `doc.workspaceId` or the freshly-created workspace's id — `shareRoomId` resolves either correctly. Leave the rest of `openShareModal` untouched.)

- [ ] **Step 6: Route the five mutation functions through it**

In `client/src/collab.ts`, change the first argument of `putWorkspaceAccess` from `doc.workspaceId` to `shareRoomId(doc.workspaceId)` in each of:

- `setAccessMode` (~line 1429)
- `setRole` (~line 1462)
- `addPerson` (~line 1500)
- `setInviteRole` (~line 1533)
- `removeInvite` (~line 1552)

Example (`setRole`):
```ts
  const access = await putWorkspaceAccess(shareRoomId(doc.workspaceId), {
    generalAccess: "anyone",
    requireAccount: currentAccess.requireAccount,
    role,
    invited: currentAccess.invited,
  });
```
Do **not** change the `workspacesStore.update(...)` blocks below those calls.

- [ ] **Step 7: Fix `buildShareLink`**

In `buildShareLink` (~line 1489), change:
```ts
  return `${location.origin}/w/${encodeURIComponent(doc.workspaceId)}/${encodeURIComponent(doc.id)}/${segment}`;
```
to:
```ts
  return `${location.origin}/w/${encodeURIComponent(shareRoomId(doc.workspaceId))}/${encodeURIComponent(doc.id)}/${segment}`;
```

- [ ] **Step 8: Point the topbar dropdown at the workspace endpoint**

In `setupShareUI`'s `dropdownBtn` click handler (~line 1287), change:
```ts
        currentAccess = await fetchAccess(doc.id);
```
to:
```ts
        currentAccess = await fetchWorkspaceAccess(shareRoomId(doc.workspaceId));
```

- [ ] **Step 9: Delete the dead legacy wrappers**

Remove `fetchAccess` (~lines 1099-1107) and `putAccess` (~lines 1109-1121) from `client/src/collab.ts` entirely — they now have zero callers (the `putAccess` in `tests/src/collab-room.test.ts` is that file's own local helper, unrelated).

- [ ] **Step 10: Refresh the two stale references**

`client/src/history.ts` ~line 174 — the comment `// ... same ... style as collab.ts's own fetchAccess/putAccess ...`: change `fetchAccess/putAccess` to `fetchWorkspaceAccess/putWorkspaceAccess`.

`client/src/comments.ts` ~lines 3-4 — the comment `... as collab.ts's own fetchAccess/ // putAccess ...`: same change to `fetchWorkspaceAccess/ // putWorkspaceAccess`.

- [ ] **Step 11: Typecheck + unit suite**

```bash
npm run typecheck
npm test
```
Expected: 0 type errors; all vitest tests pass (940). If `svelte-check` flags an unused import from the deletions, remove it.

- [ ] **Step 12: Run the e2e tests — COLLAB-23b passes, COLLAB-23a passes**

```bash
npm run build   # collab project serves the built bundle
# restart wrangler dev, then:
npx playwright test --project=collab tests/e2e/collab/live-collab.spec.ts -g "COLLAB-23" --workers=1 --timeout=60000
```
Expected: both COLLAB-23a and COLLAB-23b **pass**. (COLLAB-23a's disabled-controls/hint assertions are added in Task 2 — for now it only asserts real access + correct link, which pass here.)

- [ ] **Step 13: Full e2e-collab regression**

```bash
npx playwright test --project=collab --workers=1
```
Expected: all pass (was 17, now 19 with the two new). Then `bash tests/scripts/manual-testing/disable-dev-login.sh` and confirm `git status` shows no `src/worker.ts`.

- [ ] **Step 14: Format + commit**

```bash
npm run format
git add client/src/collab.ts client/src/history.ts client/src/comments.ts tests/e2e/collab/live-collab.spec.ts
git commit -m "$(cat <<'EOF'
fix: address the collaboration room by remoteId across the whole share flow

openShareModal, setAccessMode/setRole/addPerson/setInviteRole/removeInvite,
buildShareLink and the topbar Share dropdown all addressed the room by
doc.workspaceId (the local id) or the retired per-document
/api/collab/:id/access endpoint. For a joined workspace (local id !=
ws.remoteId) that meant: the dropdown always read "Restricted", a
non-owner's modal showed wrong access with a dead Copy link, and a
mutation would have forked a second room under the local id. New
shareRoomId() resolver routes every call at ws.remoteId (falling back to
the local id for an owner's not-yet-claimed first share). Deletes the
now-unused fetchAccess/putAccess legacy wrappers.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Read-only Share modal for joined collaborators

**Files:**
- Modify: `client/src/components/Share.svelte`
- Create: `tests/client/src/components/Share.test.ts`
- Modify: `tests/e2e/collab/live-collab.spec.ts` (extend COLLAB-23a)

**Interfaces:**
- Consumes: `shareAccess` store (`AccessRecord | null`), `githubUsername` store (`string | null`) — both already imported in `Share.svelte`. `AccessRecord.owner: string | null`.
- Produces: `const isReadOnly` derived inside `Share.svelte` (not exported; asserted through DOM state).

- [ ] **Step 1: Write the failing component test**

Create `tests/client/src/components/Share.test.ts`:

Primary approach — import `../collab` directly (the app's own path; `collab.ts`'s `DOMContentLoaded`-gated `init()` does not fire in a test because the event has already dispatched, same as jsdom):

```ts
import { test, expect, beforeEach } from "vitest";
import { render } from "vitest-browser-svelte";
import Share from "../../../../client/src/components/Share.svelte";
import { shareModalOpen, shareAccess } from "../../../../client/src/stores/share";
import { githubUsername } from "../../../../client/src/stores/github";

beforeEach(() => {
  window.MDE = { formatRelativeTime: () => "just now" } as unknown as typeof window.MDE;
  shareModalOpen.set(true);
  shareAccess.set(null);
  githubUsername.set(null);
});
```

Fallback if importing `../collab` fails to load in the browser test env: add a `vi.mock("../../../../client/src/collab", () => ({ closeShareModal: vi.fn(), setAccessMode: vi.fn(), setRole: vi.fn(), setInviteRole: vi.fn(), buildShareLink: vi.fn(() => "https://x/w/r/d/edit"), addPerson: vi.fn(), removeInvite: vi.fn(), colorForUsername: () => "#888", DEFAULT_ACCESS: { owner: null, generalAccess: "restricted", requireAccount: false, role: "viewer", invited: [] } }))` above the `Share` import (and add `vi` to the vitest import).

test("COLLAB-23: a joined non-owner sees disabled controls, the owner-only hint, and the real owner", async () => {
  shareAccess.set({ owner: "alice", generalAccess: "anyone", requireAccount: false, role: "editor", invited: [{ username: "bob", role: "editor" }] });
  githubUsername.set("bob");

  const screen = await render(Share);

  await expect.element(screen.getByLabelText("General access")).toBeDisabled();
  await expect.element(screen.getByLabelText("Access level for people with the link")).toBeDisabled();
  await expect.element(screen.getByLabelText("Add people by GitHub username")).toBeDisabled();
  await expect.element(screen.getByText("Only the workspace's owner can change who has access.")).toBeVisible();
  await expect.element(screen.getByText("alice")).toBeVisible(); // owner row shows the real owner
  await expect.element(screen.getByRole("button", { name: "Copy link" })).not.toBeDisabled();
});

test("COLLAB-23: the owner themselves gets live controls and no hint", async () => {
  shareAccess.set({ owner: "alice", generalAccess: "anyone", requireAccount: false, role: "editor", invited: [] });
  githubUsername.set("alice");

  const screen = await render(Share);

  await expect.element(screen.getByLabelText("General access")).not.toBeDisabled();
  expect(screen.container.textContent).not.toContain("Only the workspace's owner can change");
});

test("COLLAB-23: a not-yet-claimed workspace (owner null) is treated as the local user's own", async () => {
  shareAccess.set({ owner: null, generalAccess: "restricted", requireAccount: false, role: "viewer", invited: [] });
  githubUsername.set("bob");

  const screen = await render(Share);

  await expect.element(screen.getByLabelText("General access")).not.toBeDisabled();
  await expect.element(screen.getByText("bob")).toBeVisible(); // owner row falls back to the local user
});
```

- [ ] **Step 2: Run it — verify it FAILS**

```bash
npx vitest run --project=components tests/client/src/components/Share.test.ts
```
Expected: fails — no `isReadOnly`, controls not disabled, hint text absent, owner row shows `$githubUsername` unconditionally.

- [ ] **Step 3: Add the `isReadOnly` derived**

In `client/src/components/Share.svelte`, after the `accessMode` derived (~line 37), add:

```ts
  // A collaborator viewing a workspace someone else owns (they JOINED it).
  // access.owner is null only before any share has claimed the room — i.e.
  // the local user's own first share — which is never read-only.
  const isReadOnly = $derived(!!(access.owner && $githubUsername && access.owner !== $githubUsername));
```

- [ ] **Step 4: Disable the five mutation-control groups**

In the same file, add `disabled={isReadOnly}` to:

1. The add-people `<input class="share-add-people-input" ...>` (~line 122).
2. The per-invitee `<select class="share-role-select" aria-label={`Access level for ${person.username}`} ...>` (~line 142).
3. The per-invitee remove `<button class="share-person-remove" ...>` (~line 152).
4. The General-access `<select bind:this={accessSelectEl} class="share-access-select" aria-label="General access" ...>` (~line 164).
5. The link-role `<select class="share-role-select" aria-label="Access level for people with the link" hidden={!isAnyone} ...>` (~line 172).

For a `<select>` that already has attributes, place `disabled={isReadOnly}` alongside them, e.g.:
```svelte
      <select bind:this={accessSelectEl} class="share-access-select" aria-label="General access" value={accessMode} onchange={onAccessModeChange} disabled={isReadOnly}>
```

- [ ] **Step 5: Add the owner-only hint**

Immediately after the General-access `<span class="modal-hint">{hint}</span>` (~line 170), add:

```svelte
        {#if isReadOnly}
          <span class="modal-hint">Only the workspace's owner can change who has access.</span>
        {/if}
```

- [ ] **Step 6: Show the real owner in the owner row**

Change the owner row's name span (~line 135) from:
```svelte
        <span class="share-person-name">{$githubUsername || "Not signed in"}</span>
```
to:
```svelte
        <span class="share-person-name">{access.owner || $githubUsername || "Not signed in"}</span>
```
And the avatar just above it (~line 134) — change both the `style:background` username and the `initial(...)` argument to match:
```svelte
        <span class="presence-avatar" style:background={access.owner || $githubUsername ? colorForUsername(access.owner || $githubUsername) : "var(--text-dim)"}>{initial(access.owner || $githubUsername || "")}</span>
```

- [ ] **Step 7: Run the component test — verify it PASSES**

```bash
npx vitest run --project=components tests/client/src/components/Share.test.ts
```
Expected: all three tests pass.

- [ ] **Step 8: Extend the e2e COLLAB-23a with the read-only assertions**

In `tests/e2e/collab/live-collab.spec.ts`, in the COLLAB-23a test, after the `await expect(peer.locator('select[aria-label="General access"]')).toHaveValue("anyone-link", ...)` line and before the Copy-link click, add:

```ts
  await expect(peer.locator('select[aria-label="General access"]')).toBeDisabled();
  await expect(peer.locator('select[aria-label="Access level for people with the link"]')).toBeDisabled();
  await expect(peer.locator('text="Only the workspace\'s owner can change who has access."')).toBeVisible();
  await expect(peer.locator(".share-person-owner .share-person-name")).toHaveText("share-owner-e2e");
```

- [ ] **Step 9: Typecheck + full unit suite + e2e**

```bash
npm run typecheck
npm test
npm run build
# enable-dev-login, restart wrangler dev
npx playwright test --project=collab tests/e2e/collab/live-collab.spec.ts -g "COLLAB-23" --workers=1 --timeout=60000
# then disable-dev-login, confirm git status clean of src/worker.ts
```
Expected: all green (unit now 943 with the 3 new component tests).

- [ ] **Step 10: Format + commit**

```bash
npm run format
git add client/src/components/Share.svelte tests/client/src/components/Share.test.ts tests/e2e/collab/live-collab.spec.ts
git commit -m "$(cat <<'EOF'
feat: read-only Share modal for collaborators who don't own the workspace

A joined collaborator opening Share now sees the real access level and
roster with the mutation controls (access selects, invite box, role
selects, remove buttons) disabled and an "only the owner can change who
has access" hint — Copy link stays live. The owner row shows the real
owner, not whoever opened the modal.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Catalogue, release bookkeeping, screenshot, PR

**Files:**
- Modify: `docs/TEST-COVERAGE.md`, `CHANGELOG.md`, `client/src/whats-new-entries.ts`, `package.json`, `package-lock.json`
- Create: `tests/scripts/manual-testing/capture-share-collaborator-view-screenshot.mjs`, `client/public/whats-new/share-collaborator-view.png`

- [ ] **Step 1: Update the coverage catalogue**

In `docs/TEST-COVERAGE.md`:

Change the COLLAB-23 row (§10 table) from `gap` to `covered`:
```
| COLLAB-23 | Share modal + topbar dropdown: a joined collaborator sees the real general-access level and roster (controls disabled, "only the owner" hint), the Copy-link uses the room id, and the topbar dropdown label matches the real access | e2e-collab, component | covered | `tests/e2e/collab/live-collab.spec.ts`, `tests/client/src/components/Share.test.ts` | **fixed 3 bugs in this PR:** the dropdown always read "Restricted" (`fetchAccess(doc.id)` legacy endpoint); a joined non-owner's modal showed wrong access + dead Copy link + wrong owner (`doc.workspaceId` vs `ws.remoteId`); `buildShareLink` emitted a `/w/<localId>/` URL. Owner-side full CRUD through the modal (invite/role-change/revoke) still `gap`. |
```
Adjust the §10 subsystem tally row: `covered` +1, `gap` −1. Adjust the `**Total**` row the same way (it should read `298 / 3 / 10`). Verify the subsystem rows still sum to the Total (they were reconciled in PR #159).

- [ ] **Step 2: Add the CHANGELOG section**

At the top of `CHANGELOG.md`'s entries (above `## [1.46.10]`):

```markdown
## [1.47.0] - 2026-09-07

### Fixed

- **The Share dropdown next to the Share button always read "Restricted".** It was querying a retired per-document endpoint that no workspace-shared document ever writes to; it now reads the workspace's real general-access level.
- **A collaborator who joined a shared workspace saw a broken Share dialog.** It showed "Restricted" whatever the real setting, the Copy-link button was dead, and it labelled the viewer "Owner". The dialog now shows the real access level, roster, and owner, with a working Copy link and the access controls disabled (only the workspace owner can change sharing — enforced server-side already). Same root cause fixed the copied link, which pointed at an unreachable id for non-owners.
```

- [ ] **Step 3: Bump the version (three places, by hand)**

- `package.json` line 4: `"version": "1.46.10"` → `"version": "1.47.0"`
- `package-lock.json` line 3 and line ~9 (the two `"version"` fields): `1.46.10` → `1.47.0`

- [ ] **Step 4: Write the screenshot capture script**

Create `tests/scripts/manual-testing/capture-share-collaborator-view-screenshot.mjs`, modelled on `capture-workspace-access-denied-screenshot.mjs`:

```js
// One-off: captures the What's New screenshot for the joined-collaborator
// Share dialog (client/public/whats-new/share-collaborator-view.png).
// Run manually against a wrangler dev instance with the dev-login route
// applied (enable-dev-login.sh).
import { chromium } from "playwright";

const BASE = "http://localhost:8787";
const OUT = "client/public/whats-new/share-collaborator-view.png";

async function signIn(page, username) {
  await page.route("**/api/auth/github/me", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ connected: true, username }) }),
  );
  await page.goto(`${BASE}/api/dev/login?username=${username}`);
}
async function dismissWhatsNew(page) {
  const gotIt = page.locator('button:has-text("Got it")');
  if (await gotIt.isVisible({ timeout: 2000 }).catch(() => false)) await gotIt.click();
}

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const ownerCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const peerCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const owner = await ownerCtx.newPage();
const peer = await peerCtx.newPage();

await signIn(owner, "maria");
await owner.goto(BASE);
await owner.waitForFunction(() => window.MDE && typeof window.MDE.getEditor === "function", { timeout: 15000 });
await dismissWhatsNew(owner);
await owner.click("#emptyNewWorkspaceBtn");
await owner.keyboard.press("Escape").catch(() => {});
await owner.evaluate(() => window.MDE.newDoc());
await owner.waitForSelector("#editor-mount .cm-content", { state: "visible" });
await owner.click("#editor-mount .cm-content");
await owner.keyboard.type("# Team Handbook\n\nShared with the whole team.");

await owner.click('button:has-text("Share")');
const cont = owner.locator('button:has-text("Continue")');
if (await cont.isVisible({ timeout: 2000 }).catch(() => false)) await cont.click();
const accessSelect = owner.locator('select[aria-label="General access"]');
await accessSelect.waitFor({ state: "visible" });
await Promise.all([
  owner.waitForResponse((r) => /\/api\/workspace\/[^/]+\/access$/.test(r.url()) && r.request().method() === "PUT"),
  accessSelect.selectOption({ label: "Anyone with the link" }),
]);
const roleSelect = owner.locator('select[aria-label="Access level for people with the link"]');
await Promise.all([
  owner.waitForResponse((r) => /\/api\/workspace\/[^/]+\/access$/.test(r.url()) && r.request().method() === "PUT"),
  roleSelect.selectOption({ label: "Editor" }),
]);
const state = await owner.evaluate(() => {
  const wss = JSON.parse(localStorage.getItem("mde:workspaces") || "[]");
  const docs = JSON.parse(localStorage.getItem("mde:docs") || "[]");
  const active = localStorage.getItem("mde:active");
  const d = docs.find((x) => x.id === active);
  return { d, ws: wss.find((w) => w.id === d?.workspaceId) };
});
await owner.keyboard.press("Escape").catch(() => {});
const shareUrl = `${BASE}/w/${state.ws.remoteId}/${state.d.id}/edit`;

await signIn(peer, "devon");
await peer.goto(shareUrl);
await peer.waitForFunction(() => window.MDE && typeof window.MDE.getEditor === "function", { timeout: 15000 });
const addAsNew = peer.locator('button:has-text("Add as new workspace")');
if (await addAsNew.isVisible({ timeout: 3000 }).catch(() => false)) await addAsNew.click();
await dismissWhatsNew(peer);
await peer.waitForSelector("#editor-mount .cm-content", { state: "visible" });
await peer.waitForTimeout(500);

await peer.click("#shareBtn");
await peer.waitForSelector('text="Only the workspace\'s owner can change who has access."', { timeout: 10000 });
await peer.waitForTimeout(300);
await peer.screenshot({ path: OUT });
console.log(`Saved ${OUT}`);

await ownerCtx.close();
await peerCtx.close();
await browser.close();
```

- [ ] **Step 5: Capture the screenshot**

```bash
bash tests/scripts/manual-testing/enable-dev-login.sh
npm run build
npx wrangler dev --local-upstream localhost:8787 &
# wait for :8787
node tests/scripts/manual-testing/capture-share-collaborator-view-screenshot.mjs
bash tests/scripts/manual-testing/disable-dev-login.sh
```
Confirm `client/public/whats-new/share-collaborator-view.png` exists and shows the Share dialog with the owner-only hint. If the `executablePath` in the script is wrong for this machine, adjust to whatever `ls /opt/pw-browsers/` shows (or a plain `chromium.launch()` on a real dev machine).

- [ ] **Step 6: Add the What's New entry**

Append to `WHATS_NEW_ENTRIES` in `client/src/whats-new-entries.ts` (oldest-first, so at the end of the array):

```ts
  {
    version: "1.47.0",
    title: "Sharing, Seen Correctly",
    description:
      "The access level shown next to the Share button now reflects the real setting instead of always saying \"Restricted.\" And if you open Share on a workspace someone shared with you, you'll see the true access, the owner, and a working Copy link — with the controls that only the owner can change clearly marked, instead of a dialog that looked broken.",
    screenshot: "/whats-new/share-collaborator-view.png",
    category: "Collaboration",
  },
```

- [ ] **Step 7: Typecheck, format, full suite**

```bash
npm run typecheck
npm run format
npm test
npm run format:check
```
Expected: green. `whats-new-entries.test.ts` and `whats-new.test.ts` pass (category is a known one; version matches `__APP_VERSION__` now).

- [ ] **Step 8: Commit the release bookkeeping**

```bash
git add docs/TEST-COVERAGE.md CHANGELOG.md client/src/whats-new-entries.ts package.json package-lock.json tests/scripts/manual-testing/capture-share-collaborator-view-screenshot.mjs client/public/whats-new/share-collaborator-view.png
git commit -m "$(cat <<'EOF'
chore(release): share-modal fixes for joined collaborators — v1.47.0

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 9: Push and open the PR**

```bash
git push -u origin fix/share-modal-joined-collaborators
```
Open a PR against `master` titled `fix: Share modal & dropdown for joined collaborators`. Body: summarise the three bugs (table from the spec), the `shareRoomId` approach, the read-only-for-non-owners treatment, the test additions, and the 1.47.0 bump. End with:
```
🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

- [ ] **Step 10: Wait for CI green, then merge**

Poll `gh pr checks`. When `test`, `e2e`, `e2e-collab`, `typecheck`, `format:check`, CodeQL all pass, merge with a merge commit (`gh pr merge --merge --delete-branch`). Fast-forward local `master`. Auto-tag + Cloudflare deploy handle the rest.

---

## Self-Review

**Spec coverage:**
- Bug 1 (dropdown "Restricted") → Task 1 Steps 8, 1 (test), 12.
- Bug 2 (non-owner modal) → Task 1 Steps 5-6 (addressing) + Task 2 (read-only UI).
- Bug 3 (`buildShareLink`) → Task 1 Step 7 + Task 1 Step 2 (clipboard assertion).
- `shareRoomId` resolver → Task 1 Step 4.
- Delete `fetchAccess`/`putAccess` → Task 1 Step 9; stale comments → Step 10.
- Read-only modal (5 control groups + hint + owner row) → Task 2 Steps 3-6.
- Server unchanged → no task, asserted by existing COLLAB-03 staying green (Task 1 Step 13).
- Tests: e2e COLLAB-23a/b → Task 1 + Task 2; component → Task 2.
- Catalogue → Task 3 Step 1. Versioning (1.47.0 + CHANGELOG + whats-new + screenshot) → Task 3 Steps 2-6.

**Placeholder scan:** No TBD/TODO. Every code step has literal before/after. Line numbers are "~approx" because earlier steps shift them — the anchor strings are exact.

**Type consistency:** `shareRoomId(workspaceId: string): string` — same signature used in Task 1 Steps 4-8. `isReadOnly` — `$derived(boolean)`, referenced identically in Task 2 Steps 3-6 and the tests. `access.owner: string | null` matches `AccessRecord` and `DEFAULT_ACCESS`.

**Ordering:** Task 1 leaves COLLAB-23a partially asserting (access + link only); Task 2 Step 8 extends it. This is deliberate and called out in Task 1 Step 12. A reviewer can still reject Task 2's UX independently of Task 1's addressing fix.
