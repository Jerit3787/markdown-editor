# Share modal & dropdown for joined collaborators — Design Spec

## Goal

The workspace-sharing UI still addresses the collaboration room by
`doc.workspaceId` (a document's **local** workspace id) or by the retired
per-document `/api/collab/:id/access` endpoint in three places. For the
workspace's original owner those happen to resolve correctly, so the bugs
are invisible to the person who does most sharing — but for anyone who
**joined** a shared workspace (local workspace id ≠ the room's `remoteId`)
all three misfire:

1. **The topbar Share split-button dropdown always reads "Restricted"**,
   for _everyone_ including the owner, even when general access is
   "Anyone with the link". Its open handler calls `fetchAccess(doc.id)` —
   the legacy `CollabRoom` per-document endpoint, which no
   workspace-shared document has ever written to, so it always returns
   `DEFAULT_ACCESS`.

2. **A joined non-owner's Share modal is wrong and half-dead.** It shows
   "Restricted" regardless of the real setting, the "Copy link" button is
   disabled, and the local user is labelled "Owner" when they are not.
   `openShareModal` and every mutation function pass `doc.workspaceId` to
   `fetchWorkspaceAccess` / `putWorkspaceAccess`; for a joined workspace
   that id hits an unshared Durable Object. Worse, a mutation attempt
   (changing access, inviting someone) `PUT`s to that wrong DO, whose
   "first PUT claims ownership" rule would mint a **second, separate
   shared room** under the joiner's local id.

3. **`buildShareLink()` returns a dead `/w/<localId>/…` URL** for a
   non-owner — same `doc.workspaceId` bug. (This is only independently
   reachable once bug 2 is fixed; today bug 2 masks it by returning
   `null` from the disabled-button path.)

The target behaviour is Google Docs': any collaborator with access can
open the Share surface, see the real current settings and roster, and
copy a working link; only the owner gets live controls.

## Non-goals / deferred scope

- **No "let the owner allow editors to change sharing" toggle.** Google
  Docs has one; this app has no per-share permission settings and adding
  a settings surface is out of scope. All access mutations stay
  owner-only, enforced server-side exactly as today (`handleAccessRequest`
  rejects non-owner `PUT`s — COLLAB-03).
- **No server changes.** `handleAccessRequest`'s `GET` already returns the
  full access record (roster included) to any authenticated participant
  and blanks it only for non-participants. The fix is entirely
  client-side: stop asking the wrong DO.
- **The legacy `/api/collab/:id/access` route stays on the server.** Old
  single-document share links still migrate through `CollabRoom`
  (`migrateLegacyDoc`). Only the now-unused **client** wrappers
  (`fetchAccess`, `putAccess` in `collab.ts`) are removed.
- **No change to the join flow, presence bar, `decideShareTarget`, the
  access-denied banner, or `computeMyRole`.**
- **No new "you're a viewer, you can't do X" messaging beyond the one
  hint line** described below. The disabled controls plus a single hint
  are the whole treatment.
- **VER-08's shared-version _restore_ click-through test** stays deferred
  (snapshot-cadence-bound, unrelated).

## Current behaviour (root cause)

### The `doc.workspaceId` vs `ws.remoteId` split

`adoptSharedWorkspace` / `previewSharedWorkspace` (`stores/workspaces.ts`)
give a joined workspace a fresh local `id` and store the room's id
separately as `remoteId`. Only the owner's own workspace has
`id === remoteId` (set at first share: `remoteId: w.remoteId || doc.workspaceId`).
Every `/api/workspace/:id/...` call must therefore address the room by
`remoteId`. `wikilink-rename-cascade.ts` already does this
(`workspace.remoteId!`); PR #159 fixed the same bug in `CommentsPanel` and
`VersionHistory`. The share flow is the last cluster still on
`doc.workspaceId`.

### The share-flow call sites (all in `client/src/collab.ts`)

| Function | Line (approx) | Wrong call |
| --- | --- | --- |
| `openShareModal` | 1407 | `currentAccess = await fetchWorkspaceAccess(targetWorkspaceId)` where `targetWorkspaceId = doc.workspaceId` |
| `setAccessMode` | 1429 | `putWorkspaceAccess(doc.workspaceId, …)` |
| `setRole` | 1462 | `putWorkspaceAccess(doc.workspaceId, …)` |
| `addPerson` | 1500 | `putWorkspaceAccess(doc.workspaceId, …)` |
| `setInviteRole` | 1540 | `putWorkspaceAccess(doc.workspaceId, …)` |
| `removeInvite` | 1559 | `putWorkspaceAccess(doc.workspaceId, …)` |
| `buildShareLink` | 1489 | `/w/${encodeURIComponent(doc.workspaceId)}/…` |
| `setupShareUI` dropdown handler | 1287 | `currentAccess = await fetchAccess(doc.id)` (legacy per-doc endpoint) |

The `workspacesStore.update((w) => w.id === doc.workspaceId ? … : w)`
lines inside `setAccessMode` / `addPerson` (which _tag_ the local
workspace record as `shared` and fill in its `remoteId`) are **correct as
written** — they key by local id on purpose — and are not touched.

## Design

### A. One room-id resolver

Add to `client/src/collab.ts`, near `fetchWorkspaceAccess`:

```ts
// The collaboration room's id for whatever workspace `doc` lives in.
// A workspace this session JOINED has a local id (doc.workspaceId)
// distinct from the room's id — the two only coincide for the
// workspace's original owner, and only after their first share has
// claimed it (before that, remoteId is undefined and the local id IS
// what the room will be keyed by, so the ?? fallback is correct).
// Same resolution as wikilink-rename-cascade.ts and, since PR #159,
// CommentsPanel / VersionHistory.
function shareRoomId(doc: Doc): string {
  const ws = get(workspacesStore).find((w) => w.id === doc.workspaceId);
  return ws?.remoteId ?? doc.workspaceId;
}
```

Then:

- **`openShareModal`** — keep `targetWorkspaceId` as-is for the
  isolate-into-a-new-workspace branch (`choice === "document"` creates a
  brand-new local workspace that is genuinely unshared, so its local id
  _is_ its future room id). Change only the fetch:
  `currentAccess = await fetchWorkspaceAccess(shareRoomId(getActiveDoc()!))`.
  Since `decideShareTarget` returns `{kind:"direct"}` for any
  already-`shared` workspace, a joined workspace never hits the
  `choice` branch, so `shareRoomId` there always resolves to `remoteId`.
- **`setAccessMode`, `setRole`, `addPerson`, `setInviteRole`,
  `removeInvite`** — replace the first argument to `putWorkspaceAccess`
  with `shareRoomId(doc)`.
- **`buildShareLink`** — build the path from `shareRoomId(doc)`.

### B. Dropdown reads the workspace endpoint

In `setupShareUI`'s `dropdownBtn` click handler, replace
`currentAccess = await fetchAccess(doc.id)` with
`currentAccess = await fetchWorkspaceAccess(shareRoomId(doc))`.

The subsequent `if (currentAccess.generalAccess === "anyone") { … }`
branch that sets `#shareAccessTitle` / `#shareAccessDesc` is already
correct once `currentAccess` is right — no other change.

Delete `fetchAccess` (`collab.ts:1099`) and `putAccess` (`collab.ts:1109`)
— the legacy `/api/collab/:id/access` wrappers, now with zero callers.
(`putAccess` already has none.)

### C. Read-only Share modal for joined collaborators

`client/src/components/Share.svelte`:

```ts
import { githubUsername } from "../stores/github"; // already imported

// A collaborator viewing a workspace they joined (someone else owns it).
// access.owner is null only before any share has claimed the room, i.e.
// the local user's own first share — never read-only.
const isReadOnly = $derived(
  !!(access.owner && $githubUsername && access.owner !== $githubUsername),
);
```

When `isReadOnly`:

| Element | Change |
| --- | --- |
| `.share-add-people-input` | `disabled={isReadOnly}` |
| `.share-access-select` (General access) | `disabled={isReadOnly}` |
| `.share-role-select` (link role, `aria-label="Access level for people with the link"`) | `disabled={isReadOnly}` |
| `.share-role-select` (per-invitee) | `disabled={isReadOnly}` |
| `.share-person-remove` buttons | `disabled={isReadOnly}` |
| "Copy link" footer button | **unchanged** — still gated only by `linkDisabled`; a joined workspace is always shared, so it stays live |

Add, after the General-access `.modal-hint`:

```svelte
{#if isReadOnly}
  <span class="modal-hint">Only the workspace's owner can change who has access.</span>
{/if}
```

**Owner row.** Today the first `.share-person` row hard-codes the local
user as "Owner":

```svelte
<span class="share-person-name">{$githubUsername || "Not signed in"}</span>
<span class="share-person-role">Owner</span>
```

Change the name to the real owner, falling back to the local user for the
pre-claim first-share case:

```svelte
<span class="share-person-name">{access.owner || $githubUsername || "Not signed in"}</span>
<span class="share-person-role">Owner</span>
```

The avatar's `initial(...)` / `colorForUsername(...)` follow the same
value. The local joined user still appears in the list if they were
explicitly invited (they come through `access.invited`); no extra "you"
row is added.

### D. Server

No change. Confirmed sufficient:

- `handleAccessRequest` `GET` returns the full record (including
  `invited`) to any request whose `authorize()` resolves a role;
  `redactAccessForOutsider` only applies to non-participants. A joined
  collaborator is a participant.
- `handleAccessRequest` `PUT` already returns 403 for any non-owner
  (COLLAB-03: "rejects a non-owner's attempt to change access"). The
  disabled client controls are UX; the server stays the boundary. Even if
  a disabled control were bypassed, the `PUT` now goes to the _correct_
  room and is cleanly rejected rather than silently forking a new one.

## Data flow after the fix

```
Joined collaborator clicks #shareBtn
  openShareModal()
    → decideShareTarget → {kind:"direct"}   (workspace is already shared)
    → fetchWorkspaceAccess(shareRoomId(doc))  ── GET /api/workspace/<remoteId>/access
        ← { owner:"alice", generalAccess:"anyone", role:"editor", invited:[…] }
    → currentAccess = that;  syncShareStores() → shareAccess store
  Share.svelte renders:
    isReadOnly = ("alice" && "bob" && "alice" !== "bob") = true
    → access <select>s disabled, hint shown, owner row = "alice"
    → Copy link enabled
  Click "Copy link" → buildShareLink()
    → `${origin}/w/<remoteId>/<docId>/edit`     ← correct
```

```
Any user opens the topbar Share dropdown
  → fetchWorkspaceAccess(shareRoomId(doc))  ← was fetchAccess(doc.id) (legacy)
  → #shareAccessTitle = "Anyone with the link"   ← was always "Restricted"
```

## Testing

### e2e-collab — `tests/e2e/collab/live-collab.spec.ts`

**COLLAB-23a — joined non-owner's Share modal.** A signed-in second
GitHub user (`signInAsDevUser`) joins an "Anyone with the link / Editor"
workspace. Opens `#shareBtn`. Asserts:
- the General-access `<select>` value reflects "anyone-link" (not
  "restricted"),
- that `<select>` and the link-role `<select>` are `disabled`,
- the "Only the workspace's owner can change who has access." hint is
  visible,
- the owner row shows the owner's username, not the joiner's,
- clicking "Copy link" (context granted `clipboard-read`/`-write`) puts
  `"/w/<remoteId>/"` on the clipboard and **not** `"/w/<localWsId>/"`
  (localWsId read from `localStorage["mde:workspaces"]`).

**COLLAB-23b — topbar Share dropdown label.** The owner sets a workspace
to "Anyone with the link" (via `shareAnyoneLink`), then opens the
`#shareDropdownBtn` menu. Asserts `#shareAccessTitle` reads "Anyone with
the link", not "Restricted".

### component — `tests/client/src/components/Share.test.ts` (new)

Mount `Share.svelte` with `shareModalOpen` true and a stubbed
`shareAccess`:
- `access.owner = "alice"`, `githubUsername` store = `"bob"` → the five
  control groups are `disabled`, hint present, owner row = "alice".
- `access.owner = "bob"`, store = `"bob"` → controls enabled, no hint.
- `access.owner = null` (pre-first-share), store = `"bob"` → controls
  enabled, owner row = "bob".

`Share.svelte` imports `setAccessMode` etc. from `../collab`; the test
stubs `window.MDE` and the `../collab` module functions it calls (or
relies on them being no-ops under jsdom — mirror `MenuBar.test.ts`'s
existing approach).

### Existing coverage that must stay green

- `shareAnyoneLink` helper (owner happy path) — used by ~all collab e2e.
- COLLAB-03 integration (server access rules) — untouched.
- COLLAB-25 (single-doc share receipt) — untouched.

### Catalogue

`docs/TEST-COVERAGE.md`: COLLAB-23 `gap → covered` (§10). New sub-rows or
an expanded COLLAB-23 note covering the dropdown-label and read-only-modal
cases. Net: one gap closed (298/311).

## Versioning

User-facing — the Share dropdown is visibly wrong for everyone today, and
the read-only Share modal is a newly-correct surface for collaborators.

- **Minor bump `1.47.0`** (`package.json` + both `package-lock.json`
  fields).
- `CHANGELOG.md` `## [1.47.0]` with `### Fixed` (the three bugs).
- `client/src/whats-new-entries.ts` entry + a real screenshot in
  `client/public/whats-new/` (captured against a locally-built client:
  the joined-collaborator Share modal showing real access + the
  owner-only hint).

## Files touched

| File | Change |
| --- | --- |
| `client/src/collab.ts` | add `shareRoomId`; swap 7 call sites; swap the dropdown's `fetchAccess`→`fetchWorkspaceAccess`; delete `fetchAccess` + `putAccess` |
| `client/src/components/Share.svelte` | `isReadOnly` derived; `disabled` on 5 control groups; owner-only hint; real owner name in the owner row |
| `tests/e2e/collab/live-collab.spec.ts` | COLLAB-23a + COLLAB-23b |
| `tests/client/src/components/Share.test.ts` | new — `isReadOnly` gating |
| `docs/TEST-COVERAGE.md` | COLLAB-23 gap→covered |
| `CHANGELOG.md`, `client/src/whats-new-entries.ts`, `client/public/whats-new/`, `package.json`, `package-lock.json` | 1.47.0 release bookkeeping |
