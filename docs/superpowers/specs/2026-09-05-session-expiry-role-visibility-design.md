# Session-Expiry Role Visibility — Design Spec

## Goal

When a workspace/document's `generalAccess` is `"anyone"`, anyone with an
invalid or missing session (the owner's session expired, an invited
collaborator's session expired, or a genuine first-time anonymous visitor)
is granted that general-access role — this is correct, intentional
behavior: without a verified identity, granting anything more would be a
real security hole. But right now nobody is ever told *why* — an owner
whose session quietly expired sees themselves silently locked into
Preview-only with no explanation, indistinguishable from an actual
permissions problem. Surface that ambiguity to the user (a small,
dismissible status indicator, not a blocking prompt) so someone in that
situation has an actionable next step: sign in again.

Separately (and independently useful regardless of the above): the role-
resolution algorithm this depends on is currently duplicated, verbatim,
across three places — `WorkspaceRoom.authorize()`, `CollabRoom.authorize()`
(both server-side), and `computeMyRole()` (client-side, in `collab.ts`,
called before ever joining a room). The two server-side copies are
deduplicated into one shared function as part of this work.

## Non-goals / deferred scope

- **No change to what role gets granted.** This is purely about visibility
  — the actual access-control decision (which role a given
  session/access-record combination resolves to) does not change at all.
- **No cross-project (client ↔ server) code sharing.** Client (`client/src`)
  and server (`src`) are separate TypeScript projects with independently
  duplicated copies of `AccessRecord`/`Role` already (confirmed: neither
  imports the other's definitions) — restructuring that is well outside
  this fix's scope. The client keeps its own `computeMyRole()`, updated in
  parallel with the server's new shared function, not sharing code with it.
- **No blocking prompt.** Per the approved design, a visitor whose identity
  can't be verified always joins immediately as the general-access role;
  the indicator is purely informational, never gates access.
- **No new persisted state.** Nothing about a workspace/document's identity
  ("was I ever signed in as its owner") is newly stored anywhere — the
  indicator is computed fresh, client-side, from the same public
  `access` record and the same `/api/auth/github/me` check the app already
  performs on every load.

## Server-side: shared `resolveRole()`

New file `src/access-role.ts`:

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

// Pure extraction of the identical logic previously duplicated in
// WorkspaceRoom.authorize() and CollabRoom.authorize() — same behavior,
// same return shape, just one copy. `sessionUsername` is the caller's
// already-decrypted session's username, or null for no/invalid session.
// Returns null when the requester has no access at all (caller decides
// the exact 401 vs 403 and message, since the two rooms word them
// slightly differently today — "this document" vs "this workspace").
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

`WorkspaceRoom.authorize()` (`src/workspace-room.ts:322-345`) and
`CollabRoom.authorize()` (`src/collab-room.ts:339-371`) both replace their
inline role-resolution block with a call to `resolveRole(access,
session?.username ?? null)`, keeping their own (already slightly
different) "no owner yet" / "sign in" wording and status codes around it —
only the actual role-decision logic moves, not the HTTP-shaping around it.
Each file's own local `Role`/`AccessRecord`/`InvitedPerson` type
definitions are replaced with imports from `./access-role`, removing that
duplication too.

## Client-side: surfacing the ambiguity

`collab.ts` gains one small pure function, next to the existing
`computeMyRole()`:

```ts
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

A new store, alongside the existing `sharePresence`/`shareAccess` in
`stores/share.ts`:

```ts
export const identityUnverified = writable(false);
```

Set wherever `collab.ts` currently resolves role before/while joining a
room (`decideJoinTarget`/`joinWorkspace`'s call sites around
`computeMyRole(access, window.MDE.githubUsername)`, both the initial-join
path around line 181 and the reconnect path around line 276): immediately
after each such call, `identityUnverified.set(isIdentityUnverified(access,
window.MDE.githubUsername))`. Reset to `false` in `teardownWorkspace()`
(same place `sharePresence`/`shareAccess` already get reset on leaving a
room), so it never lingers into an unrelated, unshared document.

## UI: status bar indicator

`#statusbar`'s existing status dot (`_statusbar.scss`'s `.status-dot`,
currently `.status-shared` / `.status-reconnecting` / `.status-idle`)
gains a fourth state, `.status-signed-out`, same amber as
`.status-reconnecting` (both mean "something needs your attention, but
nothing is broken"). Whatever Svelte component currently renders that dot
(driven by `sharePresence`/connection state) adds one more condition: when
`$identityUnverified` is true, render the amber dot with label "Signed
out" instead of whatever it would otherwise show, with a `title`/tooltip
"You're not signed in — sign in with GitHub if you own or were invited to
this workspace, to restore full access." Clicking it calls the existing
`window.MDE.requireGithubSignIn(...)` flow (same one `openShareModal()`
and the Gist/repo-scope guards already use) — no new sign-in mechanism.

This indicator is independent of, and can coexist with, the existing
`.status-reconnecting` state (a session can be simultaneously
reconnecting *and* have unverified identity) — `identityUnverified` takes
display priority when both are true, since "sign in" is the actionable
step and "reconnecting" resolves itself.

## Testing

- `tests/src/access-role.test.ts` (new): unit tests for `resolveRole()` —
  owner match, general-access fallback (with and without `requireAccount`),
  invited-list match, invited-list miss, no-owner-yet, restricted with no
  session. Directly ports the existing inline-logic test coverage (if any)
  from `workspace-room.test.ts`/`collab-room.test.ts`, plus confirms both
  files' `authorize()` now delegate to it (a call-through check, not
  re-testing the same cases twice).
- `tests/client/src/collab.test.ts` (extend): unit tests for
  `isIdentityUnverified()` — true only for the no-session +
  owner-set + generalAccess:"anyone" combination; false when a session
  exists (even a non-matching one), false when `generalAccess:
  "restricted"`, false when there's no owner at all.
- `tests/e2e/collab/readonly-and-editing-mode.spec.ts` (extend): a
  variant of the existing viewer-lock test where the "viewer" arrives
  with **no session at all** (skip `signInAsDevUser` for that page)
  rather than a signed-in-as-someone-else viewer — asserts the status bar
  shows the signed-out indicator and that clicking it invokes the sign-in
  flow (`window.MDE.requireGithubSignIn` called, or the popup-opening
  behavior it triggers).

## Versioning

User-facing (a new status indicator, visible whenever this ambiguous case
occurs) — minor version bump, with a What's New entry, per this repo's
versioning convention in `CLAUDE.md`.
