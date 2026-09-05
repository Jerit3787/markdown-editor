# Workspace Access Denied Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the silent/inconsistent handling of a denied shared-workspace role (a session that expired, an invite that's gone, a fresh visit with no access) with one consistent, visible, read-only state and a clear path to recover.

**Architecture:** A new `workspaceAccessDenied` store (`"no-session" | "no-access" | null`) is set wherever `computeMyRole()` currently returns `null` in `client/src/collab.ts` (`joinSharedLink`, `rejoinKnownWorkspace`), locking the editor read-only/Preview-only via the same mechanism the "viewer" role already uses. A new `WorkspaceAccessBanner.svelte`, mounted prominently above the editor, reads that store and offers a Sign-in action for the recoverable case. Retrying is user-initiated: `window.MDE.onGithubAuthComplete` (set first by `collab.ts`, chained by `gist.ts`) re-runs the same join logic that got the user into the denied state in the first place.

**Tech Stack:** TypeScript, Svelte 5, Vitest (`unit` + `components` projects), Playwright (`collab` project).

**Spec:** `docs/superpowers/specs/2026-09-05-workspace-access-denied-design.md`

## Global Constraints

- Branch: `feat/workspace-access-denied`, based on `master` at commit `e938b2b`.
- No background polling/auto-retry — access is only re-checked when the user clicks Sign in and completes the popup.
- `workspaceAccessDenied` is a *separate* store from `identityUnverified` — do not conflate them (see spec's Design section for why).
- Reuse the existing viewer-role lock mechanism (`window.MDE.setReadOnly(true)` + `lockToPreviewOnly()`) — no new read-only plumbing.
- Do NOT bump `package.json`/`package-lock.json` or add a `client/src/whats-new-entries.ts` entry as part of this plan — per this repo's standing convention (confirmed this session), those happen only when told to ship. Task 4 adds a `CHANGELOG.md` entry under a provisional `## [Unreleased]`-style heading only.
- Every step that touches `client/src/collab.ts` — read the full current function body with the Read tool immediately before editing it. The file is large and actively maintained; don't edit from memory.

---

### Task 1: `workspaceAccessDenied` store + core collab.ts wiring

**Files:**
- Modify: `client/src/stores/share.ts`
- Modify: `client/src/collab.ts` (`joinSharedLink` ~176-222, `rejoinKnownWorkspace` ~319-336, `handleDocChanged` ~259-317 — re-read each before editing, line numbers may have drifted)
- Test: `tests/client/src/collab.test.ts`

**Interfaces:**
- Produces: `export type WorkspaceAccessDeniedReason = "no-session" | "no-access";` and `export const workspaceAccessDenied: Writable<WorkspaceAccessDeniedReason | null>` from `client/src/stores/share.ts` — consumed by Task 2's `WorkspaceAccessBanner.svelte`.

- [ ] **Step 1: Add the store**

In `client/src/stores/share.ts`, add after the existing `identityUnverified` export:

```ts
// Set (instead of identityUnverified) when computeMyRole() resolves no
// role at all — a session that's expired, an invite that's gone, or a
// fresh share-link visit nobody granted access to. Distinct from
// identityUnverified, which means a role WAS granted but the visitor's
// identity can't be verified (soft warning, editor stays functional);
// this means no role was granted at all (hard block — see
// WorkspaceAccessBanner.svelte). "no-session": there's no GitHub
// username at all, so signing in again is the actionable fix.
// "no-access": a username exists but still no role — signing in again
// as the same account won't help. Reset to null in the same places
// identityUnverified resets to false in collab.ts's handleDocChanged
// (see that store's own comment for why teardownWorkspace() itself is
// the wrong place), plus right after a role successfully resolves in
// joinSharedLink/rejoinKnownWorkspace.
export type WorkspaceAccessDeniedReason = "no-session" | "no-access";
export const workspaceAccessDenied = writable<WorkspaceAccessDeniedReason | null>(null);
```

- [ ] **Step 2: Write the failing unit tests**

Read `tests/client/src/collab.test.ts` in full first — it already has a `fakeSharedWorkspace` helper and a `MockWebSocket` class used by the `"join-generation race"` describe block; reuse both. Add a new describe block (anywhere after the existing ones, e.g. right after `"join-generation race..."`'s closing `});`):

```ts
describe("workspaceAccessDenied", () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="shareBtn"></div>';
    MockWebSocket.instances = [];
    vi.stubGlobal("WebSocket", MockWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    workspaceAccessDenied.set(null);
  });

  function stubDeniedFetch(access: Record<string, unknown>) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/access")) return { ok: true, json: async () => access };
        if (url.includes("/docs")) return { ok: true, json: async () => ["docA"] };
        return { ok: false, json: async () => ({}) };
      }),
    );
  }

  function stubMDE(username: string | null) {
    window.MDE = {
      enterCollabMode: vi.fn(),
      exitCollabMode: vi.fn(),
      setReadOnly: vi.fn(),
      getEditor: vi.fn(() => ({ state: { doc: { toString: () => "" } } })),
      githubUsername: username,
      githubSessionReady: Promise.resolve(),
      setDocImage: vi.fn(),
      requireGithubSignIn: vi.fn(),
    } as unknown as typeof window.MDE;
  }

  function makeDoc(suffix: string) {
    const ws = fakeSharedWorkspace({ id: `ws-${suffix}`, remoteId: `remote-${suffix}` });
    workspacesStore.set([ws]);
    const doc = { id: `doc-${suffix}`, name: "A", content: "", updatedAt: 0, createdAt: 0, workspaceId: ws.id };
    docsStore.set([doc]);
    return doc;
  }

  it("sets 'no-session' and locks the view when rejoining with no session at all", async () => {
    stubMDE(null);
    stubDeniedFetch({ owner: "alice", generalAccess: "restricted", requireAccount: false, role: "viewer", invited: [] });
    const doc = makeDoc("nosession");

    handleDocChanged(doc);
    for (let i = 0; i < 10; i++) await Promise.resolve();

    expect(get(workspaceAccessDenied)).toBe("no-session");
    expect(window.MDE.setReadOnly).toHaveBeenLastCalledWith(true);
    expect(get(viewModeLocked)).toBe(true);
  });

  it("sets 'no-access' when signed in but not granted a role", async () => {
    stubMDE("carol");
    stubDeniedFetch({
      owner: "alice",
      generalAccess: "restricted",
      requireAccount: false,
      role: "viewer",
      invited: [{ username: "bob", role: "editor" }],
    });
    const doc = makeDoc("noaccess");

    handleDocChanged(doc);
    for (let i = 0; i < 10; i++) await Promise.resolve();

    expect(get(workspaceAccessDenied)).toBe("no-access");
    expect(window.MDE.setReadOnly).toHaveBeenLastCalledWith(true);
  });

  it("clears once a subsequent rejoin resolves a real role", async () => {
    stubMDE(null);
    stubDeniedFetch({ owner: "alice", generalAccess: "restricted", requireAccount: false, role: "viewer", invited: [] });
    const doc = makeDoc("recover");

    handleDocChanged(doc);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(get(workspaceAccessDenied)).toBe("no-session");

    stubMDE("alice");
    stubDeniedFetch({ owner: "alice", generalAccess: "anyone", requireAccount: false, role: "editor", invited: [] });

    handleDocChanged(doc);
    for (let i = 0; i < 20; i++) await Promise.resolve();

    expect(get(workspaceAccessDenied)).toBeNull();
  });

  it("clears when switching away to an unrelated local doc", async () => {
    stubMDE(null);
    stubDeniedFetch({ owner: "alice", generalAccess: "restricted", requireAccount: false, role: "viewer", invited: [] });
    const doc = makeDoc("switchaway");

    handleDocChanged(doc);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(get(workspaceAccessDenied)).toBe("no-session");

    handleDocChanged({ id: "local-doc", name: "Local", content: "", updatedAt: 0, createdAt: 0, workspaceId: "some-other-ws" });

    expect(get(workspaceAccessDenied)).toBeNull();
  });
});
```

`viewModeLocked` is already imported at the top of this file (`import { viewMode, viewModeLocked } from "../../../client/src/stores/view";`) — no change needed there. Add one new import line for `workspaceAccessDenied` (this file currently has no import from `stores/share` at all — `identityUnverified`/`isIdentityUnverified` it uses elsewhere come from the `collab.ts` re-export, not directly from the store module):

```ts
import { workspaceAccessDenied } from "../../../client/src/stores/share";
```

- [ ] **Step 2b: Run tests to verify they fail**

Run: `npx vitest run --project=unit tests/client/src/collab.test.ts -t "workspaceAccessDenied"`
Expected: FAIL — `workspaceAccessDenied` is not yet exported from `stores/share.ts` usage in the test compiles (Step 1 already added the store, so this should instead fail on the actual assertions: `get(workspaceAccessDenied)` stays `null` in all four cases, since `collab.ts` doesn't set it yet).

- [ ] **Step 3: Wire `joinSharedLink`**

Read `client/src/collab.ts`'s current `joinSharedLink` function in full. First, at the top of the file, add `workspaceAccessDenied` to the single existing import line from `./stores/share` (it already imports `identityUnverified` from there — this is a one-time edit to that one import statement, shared by every function in this file including `rejoinKnownWorkspace` in Step 4 below):

```ts
import { shareModalOpen, shareAccess, shareTargetName, sharePresence, identityUnverified, workspaceAccessDenied } from "./stores/share";
```

Then, inside `joinSharedLink`, replace:

```ts
  if (!role) {
    if (!username) {
      window.MDE.requireGithubSignIn("Sign in with GitHub to open this shared workspace.");
    } else {
      alert("You don't have access to this workspace. Ask the owner to invite your GitHub username, or share a link with general access turned on.");
    }
    return;
  }
  identityUnverified.set(isIdentityUnverified(access, username));
```

with:

```ts
  if (!role) {
    workspaceAccessDenied.set(username ? "no-access" : "no-session");
    window.MDE.setReadOnly(true);
    lockToPreviewOnly();
    return;
  }
  workspaceAccessDenied.set(null);
  identityUnverified.set(isIdentityUnverified(access, username));
```

- [ ] **Step 4: Wire `rejoinKnownWorkspace`**

Read the current function body, then replace:

```ts
  const role = computeMyRole(access, window.MDE.githubUsername);
  if (!role) return;
  identityUnverified.set(isIdentityUnverified(access, window.MDE.githubUsername));
```

with:

```ts
  const role = computeMyRole(access, window.MDE.githubUsername);
  if (!role) {
    workspaceAccessDenied.set(window.MDE.githubUsername ? "no-access" : "no-session");
    window.MDE.setReadOnly(true);
    lockToPreviewOnly();
    return;
  }
  workspaceAccessDenied.set(null);
  identityUnverified.set(isIdentityUnverified(access, window.MDE.githubUsername));
```

- [ ] **Step 5: Reset the store in `handleDocChanged`'s two "leaving shared context for good" branches**

Read the current function body, then in the `!doc` branch:

```ts
  if (!doc) {
    teardownWorkspace();
    identityUnverified.set(false);
    syncShareStores();
    return;
  }
```

becomes:

```ts
  if (!doc) {
    teardownWorkspace();
    identityUnverified.set(false);
    workspaceAccessDenied.set(null);
    syncShareStores();
    return;
  }
```

And in the final bare `else` branch:

```ts
  } else {
    teardownWorkspace();
    identityUnverified.set(false);
    syncShareStores();
  }
```

becomes:

```ts
  } else {
    teardownWorkspace();
    identityUnverified.set(false);
    workspaceAccessDenied.set(null);
    syncShareStores();
  }
```

Do NOT touch the `ws && ws.shared && ws.remoteId` branch's two sub-cases (the already-connected fast path, and the `teardownWorkspace(); rejoinKnownWorkspace(...)` call) — same reasoning as `identityUnverified`: `rejoinKnownWorkspace` sets the correct value itself once it resolves (Step 4), resetting here too would race it on every redundant reactive teardown+rejoin cycle. Also don't touch the `doc.shared` (legacy migration) `else if` branch, for the same reason `identityUnverified` doesn't reset there either.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run --project=unit tests/client/src/collab.test.ts`
Expected: PASS — all tests in the file, including the 4 new ones.

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: 0 errors.

- [ ] **Step 8: Commit**

```bash
git add client/src/stores/share.ts client/src/collab.ts tests/client/src/collab.test.ts
git commit -m "feat: add workspaceAccessDenied store, lock editor when no role resolves

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: `WorkspaceAccessBanner.svelte` + mount wiring + retry-after-signin

**Files:**
- Create: `client/src/components/WorkspaceAccessBanner.svelte`
- Test: `tests/client/src/components/WorkspaceAccessBanner.test.ts`
- Modify: `client/index.html` (new mount point)
- Modify: `client/src/main.ts` (import + mount)
- Modify: `client/src/styles/_share-workspace.scss` (banner styles)
- Modify: `client/src/collab.ts` (`init()` — set `onGithubAuthComplete`)
- Modify: `client/src/gist.ts` (`init()` — chain onto `onGithubAuthComplete` instead of overwriting)

**Interfaces:**
- Consumes: `workspaceAccessDenied` (Task 1, `client/src/stores/share.ts`), `getActiveDoc` (already imported in `collab.ts` from `./stores/docs`), `handleDocChanged` (already defined in `collab.ts`).
- Produces: nothing new consumed by later tasks — this is UI + retry wiring only.

- [ ] **Step 1: Write the failing component test**

Read `tests/client/src/components/SignedOutIndicator.test.ts` first as the pattern to follow (same `vitest-browser-svelte` `render`/`screen` API). Create `tests/client/src/components/WorkspaceAccessBanner.test.ts`:

```ts
import { test, expect, beforeEach, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import WorkspaceAccessBanner from "../../../../client/src/components/WorkspaceAccessBanner.svelte";
import { workspaceAccessDenied } from "../../../../client/src/stores/share";

beforeEach(() => {
  workspaceAccessDenied.set(null);
  window.MDE = { requireGithubSignIn: vi.fn() } as unknown as typeof window.MDE;
});

test("renders nothing when access isn't denied", async () => {
  const screen = await render(WorkspaceAccessBanner);
  expect((await screen.getByRole("button").all()).length).toBe(0);
});

test("shows a sign-in prompt and button for 'no-session'", async () => {
  workspaceAccessDenied.set("no-session");
  const screen = await render(WorkspaceAccessBanner);
  await expect.element(screen.getByText(/sign in to reconnect/i)).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Sign in" })).toBeVisible();
});

test("clicking Sign in triggers the GitHub sign-in flow", async () => {
  workspaceAccessDenied.set("no-session");
  const screen = await render(WorkspaceAccessBanner);
  await screen.getByRole("button", { name: "Sign in" }).click();
  expect(window.MDE.requireGithubSignIn).toHaveBeenCalledTimes(1);
});

test("shows a no-button message for 'no-access', not a sign-in button", async () => {
  workspaceAccessDenied.set("no-access");
  const screen = await render(WorkspaceAccessBanner);
  await expect.element(screen.getByText(/ask the owner/i)).toBeVisible();
  expect((await screen.getByRole("button").all()).length).toBe(0);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --project=components tests/client/src/components/WorkspaceAccessBanner.test.ts`
Expected: FAIL — the component file doesn't exist yet.

- [ ] **Step 3: Write the component**

Create `client/src/components/WorkspaceAccessBanner.svelte`:

```svelte
<script lang="ts">
  import { workspaceAccessDenied } from "../stores/share";

  function signIn() {
    window.MDE.requireGithubSignIn("Sign in with GitHub to reconnect to this shared workspace.");
  }
</script>

{#if $workspaceAccessDenied === "no-session"}
  <div class="workspace-access-banner" role="alert">
    <span>You're signed out — sign in to reconnect to this shared workspace.</span>
    <button type="button" class="primary-btn" onclick={signIn}>Sign in</button>
  </div>
{:else if $workspaceAccessDenied === "no-access"}
  <div class="workspace-access-banner" role="alert">
    <span>You no longer have access to this shared workspace. Ask the owner to invite you, or check that you're using the right link.</span>
  </div>
{/if}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run --project=components tests/client/src/components/WorkspaceAccessBanner.test.ts`
Expected: PASS (4/4).

- [ ] **Step 5: Add the mount point and styling**

In `client/index.html`, read the area around `<div id="topbar-row">` / `<div id="content-row">` first (search for `id="topbar-row"`), then insert a new div between them:

```html
        <div id="topbar-row">
          <div id="toolbar-mount"></div>
        </div>

        <!-- WorkspaceAccessBanner.svelte, mounted in main.ts -->
        <div id="workspace-access-banner-mount"></div>

        <div id="content-row">
```

In `client/src/main.ts`, add the import alongside the other component imports (near `SignedOutIndicator`'s import) and the mount call alongside the other mount calls (near `SignedOutIndicator`'s mount):

```ts
import WorkspaceAccessBanner from "./components/WorkspaceAccessBanner.svelte";
```

```ts
mount(WorkspaceAccessBanner, { target: document.getElementById("workspace-access-banner-mount")! });
```

In `client/src/styles/_share-workspace.scss`, append at the end of the file:

```scss
.workspace-access-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 16px;
  // Matches the existing color-mix(in srgb, var(--danger) ..., transparent)
  // pattern already used in _editor-preview.scss for other danger-tinted
  // backgrounds — kept transparent-mixed (not mixed with --bg-alt) for the
  // same reason: it composes correctly over whatever --bg already is,
  // light or dark theme, with no separate dark-mode override needed.
  background: color-mix(in srgb, var(--danger) 10%, transparent);
  border-bottom: 1px solid var(--danger);
  color: var(--text);
  font-size: 13px;
}
.workspace-access-banner .primary-btn {
  flex-shrink: 0;
}
```

- [ ] **Step 6: Wire the retry — `collab.ts`'s `init()`**

Read `client/src/collab.ts`'s current `init()` function, then add one line at the end of it (after the existing `handleDocChanged(getActiveDoc());`/`joinSharedLink(...)` if/else block):

```ts
  window.MDE.onGithubAuthComplete = () => handleDocChanged(getActiveDoc());
```

- [ ] **Step 7: Wire the retry — `gist.ts`'s `init()`**

Read `client/src/gist.ts`'s current `init()` function. It currently does:

```ts
function init() {
  const existing = window.MDE.onActiveDocChanged;
  window.MDE.onActiveDocChanged = (doc) => {
    if (existing) existing(doc);
    render();
  };

  window.MDE.onGithubAuthComplete = () => {
    window.MDE.githubSessionReady = checkSession();
  };
}
```

`client/src/main.ts` imports `./collab` (line 8) before `./gist` (line 9), so `collab.ts`'s `init()` (Step 6) always sets `onGithubAuthComplete` first. Change `gist.ts`'s assignment to chain onto it, the same way it already chains onto `onActiveDocChanged` one line above:

```ts
function init() {
  const existing = window.MDE.onActiveDocChanged;
  window.MDE.onActiveDocChanged = (doc) => {
    if (existing) existing(doc);
    render();
  };

  const existingAuthComplete = window.MDE.onGithubAuthComplete;
  window.MDE.onGithubAuthComplete = () => {
    existingAuthComplete?.();
    window.MDE.githubSessionReady = checkSession();
  };
}
```

- [ ] **Step 8: Typecheck and format**

Run: `npm run typecheck && npm run format:check`
Expected: 0 errors; if `format:check` reports issues, run `npm run format` and re-check.

- [ ] **Step 9: Commit**

```bash
git add client/src/components/WorkspaceAccessBanner.svelte tests/client/src/components/WorkspaceAccessBanner.test.ts client/index.html client/src/main.ts client/src/styles/_share-workspace.scss client/src/collab.ts client/src/gist.ts
git commit -m "feat: add WorkspaceAccessBanner + retry-after-signin wiring

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: e2e coverage

**Files:**
- Modify: `tests/e2e/collab/readonly-and-editing-mode.spec.ts`

**Interfaces:**
- Consumes: `signInAsDevUser` from `./support/dev-login` (already used throughout this test file).

Read the full current file first — it already has a `dismissWhatsNew` helper and a `createFirstWorkspaceAndDoc`-style setup pattern from the existing `"a viewer-access room locks..."` test; reuse both conventions.

- [ ] **Step 1: Write the "already-known workspace becomes inaccessible" test**

Add to `tests/e2e/collab/readonly-and-editing-mode.spec.ts`:

```ts
test("an already-joined shared workspace that stops granting access shows the access-denied banner and locks the editor, and Sign-in clears it once access returns", async ({ browser }) => {
  const ownerCtx = await browser.newContext();
  const viewerCtx = await browser.newContext();
  const owner = await ownerCtx.newPage();
  const viewer = await viewerCtx.newPage();

  await signInAsDevUser(owner, "wad-owner-e2e");
  await signInAsDevUser(viewer, "wad-viewer-e2e");

  await owner.goto(BASE);
  await owner.waitForFunction(() => window.MDE && typeof window.MDE.getEditor === "function", { timeout: 15000 });
  await dismissWhatsNew(owner);
  await owner.click("#emptyNewWorkspaceBtn");
  await owner.keyboard.press("Escape").catch(() => {});
  await owner.evaluate(() => window.MDE.newDoc());
  await owner.click("#editor-mount .cm-content");
  await owner.keyboard.type("owner content");

  await owner.click('button:has-text("Share")');
  const moveDialog = owner.locator('button:has-text("Continue")');
  if (await moveDialog.isVisible({ timeout: 2000 }).catch(() => false)) await moveDialog.click();
  const accessSelect = owner.locator('select[aria-label="General access"]');
  await accessSelect.waitFor({ state: "visible" });
  await Promise.all([
    owner.waitForResponse((res) => /\/api\/workspace\/[^/]+\/access$/.test(res.url()) && res.request().method() === "PUT"),
    accessSelect.selectOption({ label: "Anyone with the link" }),
  ]);
  await owner.keyboard.press("Escape").catch(() => {});

  const shareState = await owner.evaluate(() => {
    const workspaces = JSON.parse(localStorage.getItem("mde:workspaces") || "[]");
    const docs = JSON.parse(localStorage.getItem("mde:docs") || "[]");
    const activeId = localStorage.getItem("mde:active");
    const activeDoc = docs.find((d: { id: string }) => d.id === activeId);
    const ws = workspaces.find((w: { id: string }) => w.id === activeDoc?.workspaceId);
    return { activeDoc, ws };
  });
  const shareUrl = `${BASE}/w/${shareState.ws.remoteId}/${shareState.activeDoc.id}/edit`;

  await viewer.goto(shareUrl);
  await viewer.waitForFunction(() => window.MDE && typeof window.MDE.getEditor === "function", { timeout: 15000 });
  const joinModal = viewer.locator('text="Join shared workspace"');
  if (await joinModal.isVisible({ timeout: 3000 }).catch(() => false)) {
    await viewer.click('button:has-text("Add as new workspace")');
  }
  await dismissWhatsNew(viewer);
  await expect.poll(() => viewer.evaluate(() => window.MDE.getEditor()?.state?.doc?.toString() ?? "")).toContain("owner content");

  // Owner turns general access back off — the viewer, who was never
  // individually invited, now has no role at all.
  await owner.click('button:has-text("Share")');
  const accessSelect2 = owner.locator('select[aria-label="General access"]');
  await accessSelect2.waitFor({ state: "visible" });
  await Promise.all([
    owner.waitForResponse((res) => /\/api\/workspace\/[^/]+\/access$/.test(res.url()) && res.request().method() === "PUT"),
    accessSelect2.selectOption({ label: "Restricted" }),
  ]);
  await owner.keyboard.press("Escape").catch(() => {});

  // Viewer reloads — this is the rejoin path, not a fresh visit.
  await viewer.reload();
  await viewer.waitForFunction(() => window.MDE && typeof window.MDE.getEditor === "function", { timeout: 15000 });
  await dismissWhatsNew(viewer);

  await expect(viewer.locator(".workspace-access-banner")).toBeVisible();
  await expect(viewer.locator(".workspace-access-banner")).toContainText("no longer have access");
  await expect.poll(() => viewer.evaluate(() => window.MDE.getEditor().state.readOnly)).toBe(true);

  await ownerCtx.close();
  await viewerCtx.close();
});
```

- [ ] **Step 2: Write the "fresh share-link visit with no access" test**

Add to the same file:

```ts
test("a fresh visit to a share link with no accessible role shows the access-denied banner instead of a blocking alert", async ({ browser }) => {
  const ownerCtx = await browser.newContext();
  const strangerCtx = await browser.newContext();
  const owner = await ownerCtx.newPage();
  const stranger = await strangerCtx.newPage();

  await signInAsDevUser(owner, "wad-fresh-owner-e2e");
  await signInAsDevUser(stranger, "wad-fresh-stranger-e2e");

  await owner.goto(BASE);
  await owner.waitForFunction(() => window.MDE && typeof window.MDE.getEditor === "function", { timeout: 15000 });
  await dismissWhatsNew(owner);
  await owner.click("#emptyNewWorkspaceBtn");
  await owner.keyboard.press("Escape").catch(() => {});
  await owner.evaluate(() => window.MDE.newDoc());
  await owner.click("#editor-mount .cm-content");
  await owner.keyboard.type("restricted content");

  await owner.click('button:has-text("Share")');
  const moveDialog = owner.locator('button:has-text("Continue")');
  if (await moveDialog.isVisible({ timeout: 2000 }).catch(() => false)) await moveDialog.click();
  // Inviting a specific person (not "anyone") keeps general access
  // restricted — a signed-in stranger who isn't that person gets no role.
  // Confirmed against Share.svelte's real markup: aria-label="Add people
  // by GitHub username" on a plain text input (collab.ts's addPerson
  // also seeds the workspace's content to the server on first invite,
  // even though general access itself stays restricted).
  const addInput = owner.locator('input[aria-label="Add people by GitHub username"]');
  await addInput.waitFor({ state: "visible" });
  await addInput.fill("someone-else-entirely");
  await Promise.all([
    owner.waitForResponse((res) => /\/api\/workspace\/[^/]+\/access$/.test(res.url()) && res.request().method() === "PUT"),
    owner.keyboard.press("Enter"),
  ]);

  const shareState = await owner.evaluate(() => {
    const workspaces = JSON.parse(localStorage.getItem("mde:workspaces") || "[]");
    const docs = JSON.parse(localStorage.getItem("mde:docs") || "[]");
    const activeId = localStorage.getItem("mde:active");
    const activeDoc = docs.find((d: { id: string }) => d.id === activeId);
    const ws = workspaces.find((w: { id: string }) => w.id === activeDoc?.workspaceId);
    return { activeDoc, ws };
  });
  const shareUrl = `${BASE}/w/${shareState.ws.remoteId}/${shareState.activeDoc.id}/edit`;
  await owner.keyboard.press("Escape").catch(() => {});

  const dialogMessages: string[] = [];
  stranger.on("dialog", (d) => {
    dialogMessages.push(d.message());
    d.dismiss();
  });

  await stranger.goto(shareUrl);
  await stranger.waitForFunction(() => window.MDE && typeof window.MDE.getEditor === "function", { timeout: 15000 });
  await dismissWhatsNew(stranger);

  await expect(stranger.locator(".workspace-access-banner")).toBeVisible();
  await expect(stranger.locator(".workspace-access-banner")).toContainText("no longer have access");
  expect(dialogMessages).toEqual([]);

  await ownerCtx.close();
  await strangerCtx.close();
});
```

- [ ] **Step 3: Run the new tests**

Enable dev-login and rebuild/start wrangler dev per `CLAUDE.md`'s documented flow (`tests/scripts/manual-testing/enable-dev-login.sh`, `npm run build`, `npx wrangler dev --port 8787`), apply the sandbox Playwright `executablePath` workaround to `playwright.config.ts` if running in this sandbox (revert before committing), then:

Run: `npx playwright test --project=collab tests/e2e/collab/readonly-and-editing-mode.spec.ts -g "access-denied|accessible role"`
Expected: both new tests PASS.

- [ ] **Step 4: Run the full collab e2e suite to check for regressions**

Run: `npx playwright test --project=collab tests/e2e/collab/`
Expected: all tests PASS. Revert the sandbox Playwright workaround and disable dev-login (`tests/scripts/manual-testing/disable-dev-login.sh`) before committing — neither belongs in the diff.

- [ ] **Step 5: Commit**

```bash
git add tests/e2e/collab/readonly-and-editing-mode.spec.ts
git commit -m "test: e2e coverage for the workspace-access-denied banner

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: CHANGELOG entry + final verification

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add the CHANGELOG entry**

Read `CHANGELOG.md`'s current top section first. Add a new `### Added` bullet under whatever the current top (unreleased/next) version heading is — if the top heading already has an unreleased `### Added`/`### Fixed` section from other in-flight work, append to it rather than creating a new heading, per this repo's convention that a branch shouldn't stack multiple never-shipped version headings. If the top heading is already a shipped, tagged version, add a new heading one minor version above it (this ships user-facing behavior, so it's a minor bump — the actual `package.json` bump itself stays deferred to ship time, per this plan's Global Constraints).

```markdown
### Added

- **A shared workspace that can no longer be reached — an expired session, a revoked invite, or a share link nobody granted you access to — now says so clearly instead of silently dropping you into a disconnected, fully-editable local copy.** The editor locks to read-only Preview with a banner explaining why, and a Sign-in button when signing in again could restore access.
```

- [ ] **Step 2: Run the full verification suite**

Run: `npm test && npm run typecheck && npm run format:check && npm run build`
Expected: all pass, build succeeds.

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: add CHANGELOG entry for the workspace-access-denied banner

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

- [ ] **Step 4: Report completion**

Summarize to the user: all 4 tasks complete, full verification green, branch `feat/workspace-access-denied` ready. Remind them that the actual version bump (`package.json`/`package-lock.json`) and the `client/src/whats-new-entries.ts` entry (with its required screenshot) are still needed before this can ship, per this repo's convention — to be done only when they say to create the PR.
