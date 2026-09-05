# Session-Expiry Role Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a workspace/document grants access via `generalAccess: "anyone"` and the requester has no verifiable session, surface that ambiguity in the UI (instead of silently handing out the fallback role with no explanation), and dedupe the identical role-resolution logic currently copy-pasted across `WorkspaceRoom.authorize()` and `CollabRoom.authorize()`.

**Architecture:** A new pure function `resolveRole()` in `src/access-role.ts` replaces the duplicated inline role-resolution block in both Durable Object classes' `authorize()` methods — same behavior, one copy. Client-side, a new pure function `isIdentityUnverified()` in `collab.ts` flags the one ambiguous case (no session, yet a role was granted via general access) and writes it to a new `identityUnverified` store; a new `SignedOutIndicator.svelte` component renders an amber status dot in the status bar when that store is true, linking to the existing GitHub sign-in flow.

**Tech Stack:** TypeScript (Worker + client), Svelte 5, Vitest (`unit` + `components` projects), Playwright.

**Spec:** `docs/superpowers/specs/2026-09-05-session-expiry-role-visibility-design.md`

## Global Constraints

- No change to what role gets granted in any case — this is visibility-only.
- No cross-project code sharing between `src/` (server) and `client/src/` (client) — each keeps its own type definitions and role-resolution function, updated in parallel.
- No blocking prompt — the indicator is informational only, never gates access.
- No new persisted state — everything is computed fresh from the existing `access` record and the existing `/api/auth/github/me`-backed `window.MDE.githubUsername`.
- User-facing change → **minor** version bump (`package.json` + `package-lock.json`), `CHANGELOG.md` entry, and a `client/src/whats-new-entries.ts` entry, per `CLAUDE.md`.

---

### Task 1: Shared `resolveRole()` + its own unit tests

**Files:**

- Create: `src/access-role.ts`
- Test: `tests/src/access-role.test.ts`

**Interfaces:**

- Produces: `export type Role = "viewer" | "reviewer" | "editor"`, `export interface InvitedPerson { username: string; role: Role }`, `export interface AccessRecord { owner: string | null; generalAccess: "restricted" | "anyone"; requireAccount: boolean; role: Role; invited: InvitedPerson[] }`, `export function resolveRole(access: AccessRecord, sessionUsername: string | null): Role | null`. Task 2 and Task 3 import all four from this module.

- [ ] **Step 1: Write the failing tests**

Create `tests/src/access-role.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { resolveRole } from "../../src/access-role";
import type { AccessRecord } from "../../src/access-role";

const base: AccessRecord = { owner: "alice", generalAccess: "restricted", requireAccount: false, role: "viewer", invited: [] };

describe("resolveRole", () => {
  it("grants the owner editor access regardless of general access", () => {
    expect(resolveRole(base, "alice")).toBe("editor");
    expect(resolveRole({ ...base, generalAccess: "anyone" }, "alice")).toBe("editor");
  });

  it("grants the general-access role to anyone when the link doesn't require an account", () => {
    const access: AccessRecord = { ...base, generalAccess: "anyone", requireAccount: false, role: "reviewer" };
    expect(resolveRole(access, null)).toBe("reviewer");
    expect(resolveRole(access, "carol")).toBe("reviewer");
  });

  it("denies an anonymous visitor when the general-access link requires an account", () => {
    const access: AccessRecord = { ...base, generalAccess: "anyone", requireAccount: true, role: "reviewer" };
    expect(resolveRole(access, null)).toBeNull();
  });

  it("still grants the general-access role to a signed-in stranger when an account is required", () => {
    const access: AccessRecord = { ...base, generalAccess: "anyone", requireAccount: true, role: "reviewer" };
    expect(resolveRole(access, "carol")).toBe("reviewer");
  });

  it("grants an invited person their assigned role on a restricted workspace", () => {
    const access: AccessRecord = { ...base, invited: [{ username: "bob", role: "reviewer" }] };
    expect(resolveRole(access, "bob")).toBe("reviewer");
  });

  it("denies a signed-in stranger not on the invited list", () => {
    const access: AccessRecord = { ...base, invited: [{ username: "bob", role: "reviewer" }] };
    expect(resolveRole(access, "carol")).toBeNull();
  });

  it("denies an anonymous visitor on a restricted workspace", () => {
    expect(resolveRole(base, null)).toBeNull();
  });

  it("denies everyone when there's no owner yet", () => {
    const access: AccessRecord = { ...base, owner: null };
    expect(resolveRole(access, null)).toBeNull();
    expect(resolveRole(access, "carol")).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/src/access-role.test.ts`
Expected: FAIL — `src/access-role.ts` doesn't exist yet (`Cannot find module '../../src/access-role'`).

- [ ] **Step 3: Write the implementation**

Create `src/access-role.ts`:

```ts
export type Role = "viewer" | "reviewer" | "editor";

export interface InvitedPerson {
  username: string;
  role: Role;
}

export interface AccessRecord {
  owner: string | null;
  generalAccess: "restricted" | "anyone";
  // Only meaningful when generalAccess is "anyone" — false (default) means
  // a fully public link, no account needed; true means any signed-in
  // GitHub account works without being individually invited.
  requireAccount: boolean;
  role: Role;
  invited: InvitedPerson[];
}

// Pure extraction of the identical logic previously duplicated in
// WorkspaceRoom.authorize() and CollabRoom.authorize(). `sessionUsername`
// is the caller's already-decrypted session's username, or null for no/
// invalid session. Returns null when the requester has no access at all —
// the caller decides the exact 401 vs 403 status and message (the two
// rooms word them slightly differently — "this document" vs "this
// workspace") and is also responsible for the "no owner yet" check before
// ever calling this, since that's a distinct, room-specific error case.
export function resolveRole(access: AccessRecord, sessionUsername: string | null): Role | null {
  if (sessionUsername && sessionUsername === access.owner) return "editor";
  if (access.generalAccess === "anyone") {
    if (access.requireAccount && !sessionUsername) return null;
    return access.role;
  }
  if (!sessionUsername) return null;
  const invited = access.invited.find((p) => p.username === sessionUsername);
  return invited ? invited.role : null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/src/access-role.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/access-role.ts tests/src/access-role.test.ts
git commit -m "feat: extract shared resolveRole() for workspace/document access control"
```

---

### Task 2: `WorkspaceRoom.authorize()` delegates to `resolveRole()`

**Files:**

- Modify: `src/workspace-room.ts:55-70` (local `Role`/`InvitedPerson`/`AccessRecord` definitions), `src/workspace-room.ts:322-345` (`authorize()` body)

**Interfaces:**

- Consumes: `Role`, `InvitedPerson`, `AccessRecord`, `resolveRole` from `./access-role` (Task 1).

- [ ] **Step 1: Replace the local type definitions with imports**

In `src/workspace-room.ts`, the import block at the top currently ends with:

```ts
import type { ResolvedSuggestion } from "./suggestions";
import type { Env } from "./env";
```

Change to:

```ts
import type { ResolvedSuggestion } from "./suggestions";
import type { Env } from "./env";
import { resolveRole } from "./access-role";
import type { Role, InvitedPerson, AccessRecord } from "./access-role";
```

Then delete the now-redundant local definitions (originally at lines 55-68):

```ts
export type Role = "viewer" | "reviewer" | "editor";

export interface InvitedPerson {
  username: string;
  role: Role;
}

export interface AccessRecord {
  owner: string | null;
  generalAccess: "restricted" | "anyone";
  requireAccount: boolean;
  role: Role;
  invited: InvitedPerson[];
}

```

Leave the line right after them untouched:

```ts
export const DEFAULT_ACCESS: AccessRecord = { owner: null, generalAccess: "restricted", requireAccount: false, role: "viewer", invited: [] };
```

`Role`/`InvitedPerson`/`AccessRecord` were exported from this module before — re-export them from the new import so nothing importing them from `workspace-room.ts` elsewhere breaks:

```ts
export type { Role, InvitedPerson, AccessRecord };
```

Place that re-export line immediately after the `import type { Role, InvitedPerson, AccessRecord } from "./access-role";` line.

- [ ] **Step 2: Replace the `authorize()` body**

Find (originally lines 322-345):

```ts
  async authorize(request: Request): Promise<{ ok: true; username: string | null; role: Role } | { ok: false; status: number; message: string }> {
    const session = await this.getSession(request);
    const access = await this.getAccess();
    if (!access.owner) {
      return { ok: false, status: 403, message: "This workspace hasn't been shared." };
    }
    if (session && session.username === access.owner) {
      return { ok: true, username: session.username, role: "editor" };
    }
    if (access.generalAccess === "anyone") {
      if (access.requireAccount && (!session || !session.username)) {
        return { ok: false, status: 401, message: "Sign in with GitHub to join this workspace." };
      }
      return { ok: true, username: session ? session.username : null, role: access.role };
    }
    if (!session || !session.username) {
      return { ok: false, status: 401, message: "Sign in with GitHub to join this workspace." };
    }
    const invited = access.invited.find((p) => p.username === session.username);
    if (invited) {
      return { ok: true, username: session.username, role: invited.role };
    }
    return { ok: false, status: 403, message: "You don't have access to this workspace." };
  }
```

Replace with:

```ts
  async authorize(request: Request): Promise<{ ok: true; username: string | null; role: Role } | { ok: false; status: number; message: string }> {
    const session = await this.getSession(request);
    const access = await this.getAccess();
    if (!access.owner) {
      return { ok: false, status: 403, message: "This workspace hasn't been shared." };
    }
    const role = resolveRole(access, session?.username ?? null);
    if (!role) {
      if (!session || !session.username) {
        return { ok: false, status: 401, message: "Sign in with GitHub to join this workspace." };
      }
      return { ok: false, status: 403, message: "You don't have access to this workspace." };
    }
    return { ok: true, username: session?.username ?? null, role };
  }
```

- [ ] **Step 3: Run the existing WorkspaceRoom test suite to confirm behavior is unchanged**

Run: `npx vitest run tests/src/workspace-room.test.ts`
Expected: PASS — all pre-existing tests (including the 5 in `describe("WorkspaceRoom.authorize", ...)`) pass unchanged. This is the proof that the refactor preserves exact behavior; no new tests are needed here since the existing suite already covers every branch resolveRole's own tests (Task 1) exercise in isolation.

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors (confirms the re-export keeps every other file importing `Role`/`InvitedPerson`/`AccessRecord` from `workspace-room.ts` compiling).

- [ ] **Step 5: Commit**

```bash
git add src/workspace-room.ts
git commit -m "refactor: WorkspaceRoom.authorize() delegates to shared resolveRole()"
```

---

### Task 3: `CollabRoom.authorize()` delegates to `resolveRole()`

**Files:**

- Modify: `src/collab-room.ts:59-75` (local `Role`/`InvitedPerson`/`AccessRecord` definitions), `src/collab-room.ts:339-371` (`authorize()` body)

**Interfaces:**

- Consumes: `Role`, `InvitedPerson`, `AccessRecord`, `resolveRole` from `./access-role` (Task 1).

- [ ] **Step 1: Replace the local type definitions with imports**

In `src/collab-room.ts`, the import block currently ends with:

```ts
import { redactAccessForOutsider } from "./access-visibility";
import type { Env } from "./env";
```

Change to:

```ts
import { redactAccessForOutsider } from "./access-visibility";
import type { Env } from "./env";
import { resolveRole } from "./access-role";
import type { Role, InvitedPerson, AccessRecord } from "./access-role";

export type { Role, InvitedPerson, AccessRecord };
```

Then delete the now-redundant local definitions (originally at lines 59-75):

```ts
export type Role = "viewer" | "reviewer" | "editor";

export interface InvitedPerson {
  username: string;
  role: Role;
}

export interface AccessRecord {
  owner: string | null;
  generalAccess: "restricted" | "anyone";
  // Only meaningful when generalAccess is "anyone" — false (default)
  // means a fully public link, no account needed; true means any signed
  // -in GitHub account works without being individually invited.
  requireAccount: boolean;
  role: Role;
  invited: InvitedPerson[];
}

```

Leave the surrounding lines (`function uid() {...}` above, `type AuthResult = ...` and `interface SessionInfo {...}` below) untouched — they still reference `Role`, which now resolves via the import.

- [ ] **Step 2: Replace the `authorize()` body**

Find (originally lines 339-371):

```ts
  async authorize(request: Request): Promise<AuthResult> {
    const session = await this.getSession(request);
    const access = await this.getAccess();
    if (!access.owner) {
      // Nobody has ever configured this room — treat it as private and
      // unreachable until the owner explicitly opens access via PUT
      // /access. (Ownership itself is claimed there, not here, so two
      // people racing to open a fresh link can't accidentally both become
      // "the owner".)
      return { ok: false, status: 403, message: "This document hasn't been shared." };
    }
    if (session && session.username === access.owner) {
      return { ok: true, username: session.username, role: "editor" };
    }
    if (access.generalAccess === "anyone") {
      if (access.requireAccount && (!session || !session.username)) {
        return { ok: false, status: 401, message: "Sign in with GitHub to join this document." };
      }
      // A public link (requireAccount false) needs no account at all —
      // session may be null here. Restricted (invite-only) rooms below
      // this still require a real signed-in identity, since that's the
      // only way to check the invited list.
      return { ok: true, username: session ? session.username : null, role: access.role };
    }
    if (!session || !session.username) {
      return { ok: false, status: 401, message: "Sign in with GitHub to join this document." };
    }
    const invited = access.invited.find((p) => p.username === session.username);
    if (invited) {
      return { ok: true, username: session.username, role: invited.role };
    }
    return { ok: false, status: 403, message: "You don't have access to this document." };
  }
```

Replace with:

```ts
  async authorize(request: Request): Promise<AuthResult> {
    const session = await this.getSession(request);
    const access = await this.getAccess();
    if (!access.owner) {
      // Nobody has ever configured this room — treat it as private and
      // unreachable until the owner explicitly opens access via PUT
      // /access. (Ownership itself is claimed there, not here, so two
      // people racing to open a fresh link can't accidentally both become
      // "the owner".)
      return { ok: false, status: 403, message: "This document hasn't been shared." };
    }
    const role = resolveRole(access, session?.username ?? null);
    if (!role) {
      if (!session || !session.username) {
        return { ok: false, status: 401, message: "Sign in with GitHub to join this document." };
      }
      return { ok: false, status: 403, message: "You don't have access to this document." };
    }
    return { ok: true, username: session?.username ?? null, role };
  }
```

- [ ] **Step 3: Run the existing CollabRoom test suite to confirm behavior is unchanged**

Run: `npx vitest run tests/src/collab-room.test.ts`
Expected: PASS — all pre-existing tests (including the 7 in `describe("CollabRoom.authorize", ...)`) pass unchanged.

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/collab-room.ts
git commit -m "refactor: CollabRoom.authorize() delegates to shared resolveRole()"
```

---

### Task 4: Client-side `isIdentityUnverified()` + `identityUnverified` store

**Files:**

- Modify: `client/src/stores/share.ts` (add store)
- Modify: `client/src/collab.ts` (add function, wire both call sites, reset on teardown)
- Test: `tests/client/src/collab.test.ts` (extend)

**Interfaces:**

- Produces: `export const identityUnverified = writable(false)` in `stores/share.ts`; `export function isIdentityUnverified(access: typeof DEFAULT_ACCESS, username: string | null): boolean` in `collab.ts`. Task 5's `SignedOutIndicator.svelte` consumes `identityUnverified`.

- [ ] **Step 1: Add the store**

In `client/src/stores/share.ts`, after the existing `sharePresence` export (last line of the file):

```ts
export const sharePresence = writable<PresenceEntry[]>([]);
// True only in the one genuinely ambiguous case: there's no session at
// all (not merely a session belonging to someone else), yet the access
// record still granted a role via general access — see
// collab.ts's isIdentityUnverified(). Doesn't gate anything; purely
// tells the UI the role shown might not be what this visitor would get
// if they were recognized. Reset to false in collab.ts's
// teardownWorkspace() so it never lingers into an unrelated document.
export const identityUnverified = writable(false);
```

- [ ] **Step 2: Write the failing unit tests**

In `tests/client/src/collab.test.ts`, this line near the top of the file already statically imports several plain exported functions from `collab.ts`:

```ts
import { decideShareTarget, decideJoinTarget, handleDocChanged, workspaceRoom, setAccessMode } from "../../../client/src/collab";
```

Extend it to also pull in `isIdentityUnverified` and `DEFAULT_ACCESS`:

```ts
import { decideShareTarget, decideJoinTarget, handleDocChanged, workspaceRoom, setAccessMode, isIdentityUnverified, DEFAULT_ACCESS } from "../../../client/src/collab";
```

Then add a new `describe` block anywhere after the existing `fakeWorkspace` helper (e.g. right before `describe("decideShareTarget", ...)`):

```ts
describe("isIdentityUnverified", () => {
  it("is true only when there's no session, an owner is set, and general access is 'anyone'", () => {
    const access = { ...DEFAULT_ACCESS, owner: "alice", generalAccess: "anyone" as const };
    expect(isIdentityUnverified(access, null)).toBe(true);
  });

  it("is false when a session exists, even one that doesn't match the owner", () => {
    const access = { ...DEFAULT_ACCESS, owner: "alice", generalAccess: "anyone" as const };
    expect(isIdentityUnverified(access, "bob")).toBe(false);
  });

  it("is false when general access is restricted", () => {
    const access = { ...DEFAULT_ACCESS, owner: "alice", generalAccess: "restricted" as const };
    expect(isIdentityUnverified(access, null)).toBe(false);
  });

  it("is false when there's no owner at all", () => {
    const access = { ...DEFAULT_ACCESS, owner: null, generalAccess: "anyone" as const };
    expect(isIdentityUnverified(access, null)).toBe(false);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/client/src/collab.test.ts -t "isIdentityUnverified"`
Expected: FAIL — `isIdentityUnverified` is not exported from `collab.ts` yet.

- [ ] **Step 4: Implement `isIdentityUnverified()` and wire it in**

In `client/src/collab.ts`, add the import for the new store (extend the existing import line):

```ts
import { shareModalOpen, shareAccess, shareTargetName, sharePresence, identityUnverified } from "./stores/share";
```

Add the new function right after `computeMyRole` (which sits at line 223-232):

```ts
function computeMyRole(access: typeof DEFAULT_ACCESS, username: string | null): string | null {
  if (username && access.owner === username) return "editor";
  if (access.generalAccess === "anyone") {
    if (access.requireAccount && !username) return null;
    return access.role;
  }
  if (!username) return null;
  const invited = access.invited.find((p) => p.username === username);
  return invited ? invited.role : null;
}

// True only in the one genuinely ambiguous case: there's no session at
// all (not merely a session belonging to someone else), yet the access
// record still grants a role via general access. Doesn't change what
// role is granted (computeMyRole already does the right thing here) —
// this only flags that the *reason* is unverifiable identity, not a
// deliberate permissions decision, so the UI can say so.
export function isIdentityUnverified(access: typeof DEFAULT_ACCESS, username: string | null): boolean {
  return !username && access.owner !== null && access.generalAccess === "anyone";
}
```

In `joinSharedLink` (originally lines 176-221), the role is computed and checked like this:

```ts
  const role = computeMyRole(access, username);
  if (!role) {
    if (!username) {
      window.MDE.requireGithubSignIn("Sign in with GitHub to open this shared workspace.");
    } else {
      alert("You don't have access to this workspace. Ask the owner to invite your GitHub username, or share a link with general access turned on.");
    }
    return;
  }

  if (localMatch) {
```

Insert the store write right after the `if (!role) { ...; return; }` block, before `if (localMatch)`:

```ts
  const role = computeMyRole(access, username);
  if (!role) {
    if (!username) {
      window.MDE.requireGithubSignIn("Sign in with GitHub to open this shared workspace.");
    } else {
      alert("You don't have access to this workspace. Ask the owner to invite your GitHub username, or share a link with general access turned on.");
    }
    return;
  }
  identityUnverified.set(isIdentityUnverified(access, username));

  if (localMatch) {
```

(Setting it only once role is confirmed non-null keeps it from being written — and then never cleared — on the early-return path where no workspace is actually joined.)

In `rejoinKnownWorkspace` (originally lines 266-282):

```ts
async function rejoinKnownWorkspace(remoteId: string, docId: string) {
  const myGeneration = joinGeneration;
  await window.MDE.githubSessionReady;
  if (myGeneration !== joinGeneration) return;
  const access = await fetchWorkspaceAccess(remoteId);
  if (myGeneration !== joinGeneration) return;
  const role = computeMyRole(access, window.MDE.githubUsername);
  if (!role) return;
  const joined = await joinWorkspace(remoteId, { role });
  if (joined !== joinGeneration) return;
  bindActiveDoc(docId);
  syncShareStores();
}
```

Change to:

```ts
async function rejoinKnownWorkspace(remoteId: string, docId: string) {
  const myGeneration = joinGeneration;
  await window.MDE.githubSessionReady;
  if (myGeneration !== joinGeneration) return;
  const access = await fetchWorkspaceAccess(remoteId);
  if (myGeneration !== joinGeneration) return;
  const role = computeMyRole(access, window.MDE.githubUsername);
  if (!role) return;
  identityUnverified.set(isIdentityUnverified(access, window.MDE.githubUsername));
  const joined = await joinWorkspace(remoteId, { role });
  if (joined !== joinGeneration) return;
  bindActiveDoc(docId);
  syncShareStores();
}
```

Finally, in `teardownWorkspace()` (originally lines 522-563), add the reset next to the other store reset already there:

```ts
function teardownWorkspace(): void {
  joinGeneration++;
  backgroundSyncDebounce.flush();
  remotePresenceByUsername.clear();
  workspacePresence.set(new Map());
  identityUnverified.set(false);
  window.MDE.setReadOnly(false);
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/client/src/collab.test.ts -t "isIdentityUnverified"`
Expected: PASS (4 tests).

- [ ] **Step 6: Run the full collab.test.ts file to check for regressions**

Run: `npx vitest run tests/client/src/collab.test.ts`
Expected: PASS — all pre-existing tests in this file still pass.

- [ ] **Step 7: Commit**

```bash
git add client/src/stores/share.ts client/src/collab.ts tests/client/src/collab.test.ts
git commit -m "feat: flag unverified-identity role grants with isIdentityUnverified()"
```

---

### Task 5: `SignedOutIndicator.svelte` status bar UI

**Files:**

- Create: `client/src/components/SignedOutIndicator.svelte`
- Modify: `client/index.html` (add mount point in `#statusbar`)
- Modify: `client/src/main.ts` (mount the component)
- Modify: `client/src/styles/_statusbar.scss` (add `.status-signed-out` + button-reset styles)
- Test: `tests/client/src/components/SignedOutIndicator.test.ts`

**Interfaces:**

- Consumes: `identityUnverified` store from `../stores/share` (Task 4); `window.MDE.requireGithubSignIn(hint?: string): void` (existing, `client/src/types.ts:217`).

- [ ] **Step 1: Add the mount point in `index.html`**

In `client/index.html`, the `#statusbar` footer currently reads (around line 517):

```html
      <footer id="statusbar">
        <span id="wordCount">0 words</span>
        <span id="charCount">0 characters</span>
        <span class="spacer"></span>
        <span id="keybindingMode" class="keybinding-mode-indicator" hidden></span>
        <span id="cursorPos">Ln 1, Col 1</span>
        <a
          href="https://github.com/Jerit3787/markdown-editor"
```

Add the mount div right after the `keybindingMode` span:

```html
      <footer id="statusbar">
        <span id="wordCount">0 words</span>
        <span id="charCount">0 characters</span>
        <span class="spacer"></span>
        <span id="keybindingMode" class="keybinding-mode-indicator" hidden></span>
        <!-- SignedOutIndicator.svelte, mounted in main.ts -->
        <div id="signed-out-indicator-mount"></div>
        <span id="cursorPos">Ln 1, Col 1</span>
        <a
          href="https://github.com/Jerit3787/markdown-editor"
```

- [ ] **Step 2: Write the failing component test**

Create `tests/client/src/components/SignedOutIndicator.test.ts`:

```ts
import { test, expect, beforeEach, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import SignedOutIndicator from "../../../../client/src/components/SignedOutIndicator.svelte";
import { identityUnverified } from "../../../../client/src/stores/share";

beforeEach(() => {
  identityUnverified.set(false);
  window.MDE = { requireGithubSignIn: vi.fn() } as unknown as typeof window.MDE;
});

test("renders nothing when identity is verified", async () => {
  const screen = await render(SignedOutIndicator);
  expect((await screen.getByRole("button").all()).length).toBe(0);
});

test("shows a signed-out indicator when identity is unverified", async () => {
  identityUnverified.set(true);
  const screen = await render(SignedOutIndicator);
  await expect.element(screen.getByRole("button", { name: "Signed out" })).toBeVisible();
});

test("clicking the indicator triggers the GitHub sign-in flow", async () => {
  identityUnverified.set(true);
  const screen = await render(SignedOutIndicator);
  await screen.getByRole("button", { name: "Signed out" }).click();
  expect(window.MDE.requireGithubSignIn).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run --project=components tests/client/src/components/SignedOutIndicator.test.ts`
Expected: FAIL — `client/src/components/SignedOutIndicator.svelte` doesn't exist yet.

- [ ] **Step 4: Implement the component**

Create `client/src/components/SignedOutIndicator.svelte`:

```svelte
<script lang="ts">
  import { identityUnverified } from "../stores/share";

  function signIn() {
    window.MDE.requireGithubSignIn("Sign in with GitHub to restore your access to this shared workspace.");
  }
</script>

{#if $identityUnverified}
  <button
    type="button"
    class="signed-out-indicator"
    title="You're not signed in — sign in with GitHub if you own or were invited to this workspace, to restore full access."
    onclick={signIn}
  >
    <span class="status-dot status-signed-out"></span>
    Signed out
  </button>
{/if}
```

- [ ] **Step 5: Add the CSS**

In `client/src/styles/_statusbar.scss`, after the existing `.status-dot.status-idle` rule:

```scss
.status-dot.status-idle {
  background: var(--text-dim);
}
.status-dot.status-signed-out {
  background: #f59f00;
}
.signed-out-indicator {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text-dim);
  background: none;
  border: none;
  padding: 0;
  font: inherit;
  cursor: pointer;
}
.signed-out-indicator:hover {
  color: var(--accent);
}
```

- [ ] **Step 6: Mount the component**

In `client/src/main.ts`, add the import alongside the other component imports:

```ts
import ShortcutsModal from "./components/ShortcutsModal.svelte";
import SignedOutIndicator from "./components/SignedOutIndicator.svelte";
```

And add the mount call, grouped with the other always-visible (non-modal) components near `Toast`/`MenuBar`:

```ts
mount(Toast, { target: document.getElementById("toast-mount")! });
mount(SignedOutIndicator, { target: document.getElementById("signed-out-indicator-mount")! });
mount(MenuBar, { target: document.getElementById("menubar-mount")! });
```

- [ ] **Step 7: Run the component test to verify it passes**

Run: `npx vitest run --project=components tests/client/src/components/SignedOutIndicator.test.ts`
Expected: PASS (3 tests). If a test fails, check `tests/client/src/components/__screenshots__/` for the auto-saved failure screenshot first.

- [ ] **Step 8: Typecheck and format**

Run: `npm run typecheck && npx prettier --check client/index.html client/src/main.ts client/src/components/SignedOutIndicator.svelte client/src/styles/_statusbar.scss`
Expected: no errors. If prettier reports formatting issues, run `npx prettier --write` on the same file list.

- [ ] **Step 9: Commit**

```bash
git add client/index.html client/src/main.ts client/src/components/SignedOutIndicator.svelte client/src/styles/_statusbar.scss tests/client/src/components/SignedOutIndicator.test.ts
git commit -m "feat: show a status bar indicator when identity can't be verified"
```

---

### Task 6: End-to-end coverage for the no-session viewer case

**Files:**

- Modify: `tests/e2e/collab/readonly-and-editing-mode.spec.ts`

**Interfaces:**

- Consumes: `createFirstWorkspaceAndDoc`, `dismissWhatsNew` (already defined at the top of this file); `signInAsDevUser` from `./support/dev-login` (already imported).

- [ ] **Step 1: Write the new test**

Add this test at the end of `tests/e2e/collab/readonly-and-editing-mode.spec.ts`, after the existing `"a viewer-access room locks the app to Preview-only..."` test:

```ts
test("a viewer with no session at all sees the signed-out indicator and can sign in from it", async ({ browser }) => {
  const ownerCtx = await browser.newContext();
  const viewerCtx = await browser.newContext();
  const owner = await ownerCtx.newPage();
  const viewer = await viewerCtx.newPage();

  await signInAsDevUser(owner, "sig-owner-e2e");
  // Deliberately no signInAsDevUser(viewer, ...) — this viewer has no
  // session at all, the exact case isIdentityUnverified() flags.

  await owner.goto(BASE);
  await owner.waitForFunction(() => window.MDE && typeof window.MDE.getEditor === "function", { timeout: 15000 });
  await dismissWhatsNew(owner);
  await createFirstWorkspaceAndDoc(owner);
  await owner.click("#editor-mount .cm-content");
  await owner.keyboard.type("owner-authored content");

  await owner.click('button:has-text("Share")');
  const moveDialog = owner.locator('button:has-text("Continue")');
  if (await moveDialog.isVisible({ timeout: 2000 }).catch(() => false)) await moveDialog.click();
  const accessSelect = owner.locator('select[aria-label="General access"]');
  await accessSelect.waitFor({ state: "visible" });
  await Promise.all([
    owner.waitForResponse((res) => /\/api\/workspace\/[^/]+\/access$/.test(res.url()) && res.request().method() === "PUT"),
    accessSelect.selectOption({ label: "Anyone with the link" }),
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

  await viewer.goto(shareUrl);
  await viewer.waitForFunction(() => window.MDE && typeof window.MDE.getEditor === "function", { timeout: 15000 });
  const joinModal = viewer.locator('text="Join shared workspace"');
  if (await joinModal.isVisible({ timeout: 3000 }).catch(() => false)) {
    await viewer.click('button:has-text("Add as new workspace")');
  }
  await dismissWhatsNew(viewer);

  await expect.poll(() => viewer.evaluate(() => window.MDE.getEditor()?.state?.doc?.toString() ?? "")).toContain("owner-authored content");

  const indicator = viewer.locator('button.signed-out-indicator:has-text("Signed out")');
  await expect(indicator).toBeVisible();

  await indicator.click();
  await expect(viewer.locator('text="Sign in required"')).toBeVisible();

  await ownerCtx.close();
  await viewerCtx.close();
});
```

(`"Sign in required"` is the `title` passed to `Modal` in `GithubSignInModal.svelte`, which mounts conditionally on `{#if $githubSignInModalOpen}` — same "open" signal `requireGithubSignIn()` sets, so this confirms the click actually reached the existing sign-in flow.)

- [ ] **Step 2: Run the new test**

Run: `npm run test:e2e:collab`

This spins up a real Worker + Durable Objects (`tests/scripts/e2e-collab.sh`) — it is slow. If running the full script isn't practical in the current environment, at minimum confirm the test file has no syntax errors via `npx tsc --noEmit -p tests/e2e/tsconfig.json` (or whatever config governs the e2e test files — check for one; if none exists, rely on `npx playwright test --list` to confirm the test is discovered without errors) and flag to the user that the full collab e2e run should happen before this ships.

Expected: PASS once run.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/collab/readonly-and-editing-mode.spec.ts
git commit -m "test: e2e coverage for the signed-out indicator on a no-session viewer"
```

---

### Task 7: Version bump, CHANGELOG, What's New

**Files:**

- Modify: `package.json`, `package-lock.json`, `CHANGELOG.md`, `client/src/whats-new-entries.ts`

- [ ] **Step 1: Bump the version**

In `package.json`, change `"version": "1.42.5"` to `"version": "1.43.0"`.

In `package-lock.json`, change both top-level `"version"` fields (the root package's own version, appearing twice near the top of the file — once at the document root and once in the nested self-reference under `"packages": { "": { ... } }`) from `"1.42.5"` to `"1.43.0"`. Hand-edit both; do not run `npm install --package-lock-only`.

- [ ] **Step 2: Add the CHANGELOG entry**

In `CHANGELOG.md`, insert a new section above `## [1.42.5] - 2026-09-05`:

```markdown
## [1.43.0] - 2026-09-05

### Added

- **A small status bar indicator now appears when your access to a shared workspace can't actually be verified** — e.g. your GitHub session quietly expired while you were the owner or an invited collaborator. Previously you'd just silently end up with whatever role the link's general access grants (often Preview-only), with nothing telling you why. Click the "Signed out" indicator to sign in again and restore your real access.

### Changed

- **`WorkspaceRoom` and `CollabRoom`'s identical role-resolution logic is now one shared function** (`src/access-role.ts`'s `resolveRole()`) instead of two copy-pasted copies — no behavior change, just one place to read and update it going forward.
```

- [ ] **Step 3: Add the What's New entry**

In `client/src/whats-new-entries.ts`, append after the `"1.42.0"` (Wikilink Rename Cascade) entry, before the closing `];`:

```ts
  {
    version: "1.43.0",
    title: "Signed-Out Indicator",
    description:
      "If your GitHub session expires while you're the owner or an invited collaborator on a shared workspace, you'll now see a status bar indicator instead of silently landing in whatever role the link's general access grants. Click it to sign in again.",
    screenshot: "/whats-new/signed-out-indicator.png",
    category: "Collaboration",
  },
```

Note: per this repo's existing convention (see e.g. `docs/superpowers/plans/2026-09-02-wikilink-rename-cascade.md`'s own note on this), the `screenshot` path points at an asset (`client/public/whats-new/signed-out-indicator.png`) that doesn't exist yet. `WhatsNew.svelte`'s dev-mode check only warns about a missing *entry* whose version doesn't match `__APP_VERSION__`, not a missing image, so this doesn't block anything — flag it to the user/reviewer rather than fabricating a placeholder image.

- [ ] **Step 4: Verify formatting**

Run: `npx prettier --check package.json CHANGELOG.md client/src/whats-new-entries.ts`
Expected: no errors. If it reports issues, run `npx prettier --write` on the same file list.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json CHANGELOG.md client/src/whats-new-entries.ts
git commit -m "chore: bump version to 1.43.0 for the signed-out indicator"
```

---

### Task 8: Final verification

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: all tests pass (`unit` and `components` projects).

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Format check**

Run: `npm run format:check`
Expected: no errors.

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: builds successfully.

- [ ] **Step 5: Report status**

Summarize for the user: all local checks passing, plus explicitly flag (a) whether `npm run test:e2e:collab` was actually run end-to-end for Task 6's new test, and (b) that `client/public/whats-new/signed-out-indicator.png` still needs a real screenshot before/after this ships (per Task 7, Step 3's note).
