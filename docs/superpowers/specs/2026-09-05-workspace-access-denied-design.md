# Workspace Access Denied — Design Spec

## Goal

Closes the "silent disconnection" gap from [issue #129](https://github.com/Jerit3787/markdown-editor/issues/129): when a shared workspace can no longer be reached — the user's session expired, their invite was revoked, or a first-time share-link visit is simply denied — the client currently gives no consistent, visible signal. An already-known workspace's rejoin (`rejoinKnownWorkspace`) silently drops into fully-editable local mode with zero indication anything is wrong; a fresh share-link visit at least shows a blocking `alert()`, but that's a different (and cruder) behavior from the same underlying condition. Either way, anything the user types in that state saves locally and never reaches anyone.

## Non-goals / deferred scope

- **Not fixing points 1-2 of #129** (remote-vs-local workspace identification, `lastAuthenticatedStatus` tracking) — `Workspace.remoteId` already distinguishes local from remote, and `computeMyRole()`/`isIdentityUnverified()`/the "Signed out" indicator (shipped in v1.43.0) already re-verify role against the server on every join and flag when access came through an unverified identity. This spec only covers the case those mechanisms don't: role resolution failing *entirely*.
- **Not fixing point 4 of #129** (same user, two devices, same link) — a distinct concern from access denial, left for its own future spec.
- **No background polling/auto-retry.** Re-checking access happens only when the user takes an action (clicking Sign in and completing the popup). No `setInterval`, no reconnect-on-visibility-change.
- **No new state for "workspace no longer exists at all."** `fetchWorkspaceAccess()` already falls back to `DEFAULT_ACCESS` on any fetch failure (network error, 404, 500), which naturally denies a role the same way a genuinely-restricted workspace does — that's an acceptable, honest-enough message for a rare edge case, not a third UI variant.
- **No change to the legacy `migrateLegacyDoc` path** (`/api/collab/:id/migrate`) — it doesn't go through `computeMyRole` and already has its own fallback.

## Current behavior (root cause)

`computeMyRole(access, username)` returns `null` when the current session (or lack of one) doesn't resolve to any role. Its two callers handle that inconsistently:

- **`joinSharedLink`** (a fresh share-link visit): shows `window.MDE.requireGithubSignIn(...)` (no session) or a blocking `alert(...)` (signed in, no access), then returns — no lasting UI state, no read-only lock (there's nothing loaded into the editor yet at this point in a fresh visit, so this is mostly fine as-is, but the messaging pattern is what carries forward).
- **`rejoinKnownWorkspace`** (a workspace already joined before, now being reconnected to — e.g. on page refresh): `if (!role) return;`. Nothing else happens. `handleDocChanged` already called `teardownWorkspace()` before this, which resets the editor to plain, fully-editable local mode. The user is left looking at whatever was last cached locally in `localStorage`, with **zero indication** the live connection failed, free to type into a document that will never sync anywhere.

## Design

### New store: `workspaceAccessDenied`

In `client/src/stores/share.ts`, alongside the existing `identityUnverified`:

```ts
export type WorkspaceAccessDeniedReason = "no-session" | "no-access";
export const workspaceAccessDenied: Writable<WorkspaceAccessDeniedReason | null> = writable(null);
```

Deliberately a *separate* store from `identityUnverified`, not an extension of it — `identityUnverified` means "a role **was** granted, but we can't verify who you are" (soft warning, editor stays fully functional); `workspaceAccessDenied` means "no role was granted at all" (hard block). Conflating the two would muddy both.

`"no-session"`: `computeMyRole` returned `null` and there is no GitHub username at all (`!username`) — signing in again is the actionable fix, since the eventual role depends on who signs in. `"no-access"`: a username exists but still no role — signing in again as the *same* account won't help; the fix is being invited, or using a different link/account.

### `client/src/collab.ts` changes

**`joinSharedLink`'s no-role branch** — replace:

```ts
if (!role) {
  if (!username) {
    window.MDE.requireGithubSignIn("Sign in with GitHub to open this shared workspace.");
  } else {
    alert("You don't have access to this workspace. Ask the owner to invite your GitHub username, or share a link with general access turned on.");
  }
  return;
}
```

with:

```ts
if (!role) {
  workspaceAccessDenied.set(username ? "no-access" : "no-session");
  window.MDE.setReadOnly(true);
  lockToPreviewOnly();
  return;
}
```

**`rejoinKnownWorkspace`'s no-role branch** — replace `if (!role) return;` with the same three-line treatment (`workspaceAccessDenied.set(...)`, `setReadOnly(true)`, `lockToPreviewOnly()`), using the same `username ? "no-access" : "no-session"` logic (`window.MDE.githubUsername`, already resolved by this point in the function).

**Clearing the store** — everywhere `handleDocChanged` already resets `identityUnverified.set(false)` (the `!doc` branch and the final bare `else` branch — the two "leaving shared context for good" cases), add `workspaceAccessDenied.set(null)` alongside it. Also clear it in both `joinSharedLink` and `rejoinKnownWorkspace` at the exact point each already runs `identityUnverified.set(isIdentityUnverified(access, username))` — that line only executes once role resolution has *succeeded* (the `if (!role) {...} return;` block above it already exited on failure), so adding `workspaceAccessDenied.set(null);` right next to it is the one place per function where "a role was just resolved successfully" is already known — a doc that was previously denied and is now reachable again must not keep showing the stale banner. Switching to an unrelated local (never-shared) doc already resets read-only/view-lock unconditionally via `teardownWorkspace()`, so no extra unlock call is needed there — just the store reset.

**Retry wiring** — `client/src/main.ts` imports `./collab` (line 8) before `./gist` (line 9), so `collab.ts`'s `document.addEventListener("DOMContentLoaded", init)` registers — and fires — first. `collab.ts`'s `init()` is therefore the one that sets `window.MDE.onGithubAuthComplete` first, not the one chaining onto it:

```ts
// client/src/collab.ts's init()
window.MDE.onGithubAuthComplete = () => handleDocChanged(getActiveDoc());
```

`gist.ts`'s own `init()` currently *overwrites* `onGithubAuthComplete` unconditionally (`window.MDE.onGithubAuthComplete = () => { window.MDE.githubSessionReady = checkSession(); };`), which would silently discard collab.ts's hook the moment gist.ts's later `init()` runs. Fix `gist.ts` to chain instead — the exact pattern it already uses one line above for `onActiveDocChanged`:

```ts
// client/src/gist.ts's init(), alongside its existing onActiveDocChanged chain
const existingAuthComplete = window.MDE.onGithubAuthComplete;
window.MDE.onGithubAuthComplete = () => {
  existingAuthComplete?.();
  window.MDE.githubSessionReady = checkSession();
};
```

Re-running `handleDocChanged(getActiveDoc())` reuses the exact same join logic that got the user here in the first place — no bespoke "retry" code path, no extra state to keep in sync. If it succeeds, the clearing logic above fires naturally. If it fails again (e.g. wrong account), the store is set again with whatever reason applies now.

### New component: `WorkspaceAccessBanner.svelte`

Mounted once, prominently, above the editor area — not the small `.status-dot` treatment `SignedOutIndicator` uses (that's a soft, dismissable-feeling warning; this is a hard block and needs to be seen). Subscribes to `workspaceAccessDenied`; renders nothing at `null`.

- `"no-session"`: *"You're signed out — sign in to reconnect to this shared workspace."* + a **Sign in** button calling `window.MDE.requireGithubSignIn("Sign in with GitHub to reconnect to this shared workspace.")`.
- `"no-access"`: *"You no longer have access to this shared workspace. Ask the owner to invite you, or check that you're using the right link."* — no button; signing in again as the same account wouldn't change anything.

Wired the same way `SignedOutIndicator` was: a dedicated mount point (`#workspace-access-banner-mount`) added to `client/index.html`, mounted in `client/src/main.ts`.

### Why this is safe

- Reuses the *existing* viewer-role lock mechanism (`setReadOnly(true)` + `lockToPreviewOnly()`, from `bindActiveDoc`'s own viewer handling) — no new read-only plumbing, no new interaction with CodeMirror internals.
- `fetchWorkspaceAccess()`'s existing `DEFAULT_ACCESS` fallback on any failure already routes cleanly into this same "no role" handling — no special-casing needed for network errors or a genuinely-deleted workspace.
- `gist.ts`'s new chain onto `onGithubAuthComplete` follows the exact pattern it already established for `onActiveDocChanged` one line above it — proven safe, no new coordination primitive, and consistent with `collab.ts` (imported first in `main.ts`) always being the one that sets a hook first, `gist.ts` the one chaining onto it.
- The store reset points mirror `identityUnverified`'s own reset points exactly (same branches in `handleDocChanged`), so there's no new lifecycle to reason about independently — anywhere the existing store already gets zeroed, this one does too.

## Testing

- **Unit** (`tests/client/src/collab.test.ts`): extend the existing `MockWebSocket`-based harness with cases for `joinSharedLink` and `rejoinKnownWorkspace` — `workspaceAccessDenied` set to `"no-session"` when there's no `githubUsername`, `"no-access"` when signed in but `fetchWorkspaceAccess` resolves to a restricted/empty access record; cleared on a subsequent successful join and on switching to an unrelated local doc.
- **Component** (`tests/client/src/components/WorkspaceAccessBanner.test.ts`, new): renders nothing at `null`; correct copy and button presence/absence for each reason.
- **e2e** (`tests/e2e/collab/`): a signed-out visitor opens an already-joined workspace that now denies all access (general access turned off, not invited) — asserts the banner appears with the right copy, the editor is read-only and Preview-locked, and clicking Sign-in + completing the dev-login auth flow clears the banner and restores normal access. Mirrors the existing "no session at all sees the signed-out indicator" test's structure.

## Versioning

User-facing (a workspace that's actually unreachable now says so, instead of silently pretending to work) — minor version bump, with a What's New entry (screenshot required, captured in the same change per `CLAUDE.md`'s hard requirement), per `CLAUDE.md`'s versioning convention.
