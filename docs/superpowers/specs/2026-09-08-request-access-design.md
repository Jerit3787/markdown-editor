# Request edit access (CV2-5) — design

**Status:** draft for review
**Date:** 2026-09-08
**Related backlog:** `ROADMAP.md` → Active → "Collab-mode chrome v2" — item **CV2-5**. The other CV2 items shipped in v1.52.0; this one was split out because it needs server work.

## Goal

Let a shared-workspace collaborator who joined at `viewer` or `reviewer` ask the workspace owner for edit access, and let the owner approve or deny it from the Share dialog — without either party leaving the app. Modelled on Google Docs' "Request edit access" flow, adapted to this app's constraints (no server-side email).

## Decisions (from the brainstorm)

| # | Decision |
|---|---|
| **Requester scope** | A **joined `viewer` / `reviewer`** only. The "you have no access at all" denied-outsider screen (`workspaceAccessDenied`) is untouched — out of scope. |
| **Requested role** | Always **editor** — one button, "Request edit access", matching Google's viewer flow. The owner can still approve at a lower role via a role picker on the approve control. |
| **Owner notification** | A **count badge** on the Share button whenever requests are pending; a **live toast** (new `MESSAGE_ACCESS_REQUEST` frame) if the owner is connected; a **"Requests" section** at the top of the Share dialog to approve/deny. No email — flagged as the known gap vs Google. |
| **Live effect** | Approve/deny/any-role-change broadcasts a new **`MESSAGE_ACCESS_CHANGED`** frame; every client re-fetches `GET /access` and, if its own resolved role changed, **rejoins the workspace** (reconnecting the WebSocket at the new server-side role). Also fixes the pre-existing gap where a mid-session role edit needs a manual reload. |

## Non-goals / deferred

- **Denied-outsider requests** ("let me in at all" from the access-denied screen).
- **Email / any out-of-app notification.** This app has no server-side mail (Gist/repo use the user's own GitHub token). In-app only.
- **A request queue / history.** A denied request is simply removed; there's no "declined" record. The requester can request again.
- **`CollabRoom` (legacy).** Migration-path-only; not touched.
- **Requester picks a role**, per-document requests, request expiry.

## Background — current state

- **Access model** (`src/access-role.ts`): `AccessRecord = { owner, generalAccess, requireAccount, role, invited: {username, role}[] }` in DO storage key `"access"`. `resolveRole(access, username)` → the session's `Role | null`.
- **Endpoints** (`src/workspace-room.ts`): `GET /api/workspace/:id/access` — readable without auth, but `redactAccessForOutsider()` strips `owner` + `invited` for anyone `authorize()` doesn't clear. `PUT /access` — owner-only, replaces the whole record.
- **Transport:** one WebSocket per workspace. `this.sessions: Map<WebSocket, { username, role, viewingDocId }>`. `broadcast(msg, exceptWs)` sends to all. Message types 0–5 (`MESSAGE_SYNC` … `MESSAGE_WORKSPACE_DELETED`). Frames for types ≥ some point are docId-prefixed; META / PRESENCE / DELETED are not.
- **Client** (`client/src/collab.ts`): `fetchWorkspaceAccess(remoteId)` → `currentAccess` + `syncShareStores()` → `shareAccess` store → `Share.svelte`. `computeMyRole(access, username)` mirrors `resolveRole`. `joinWorkspace({ role, isOwner })` bakes `role` into `workspaceRoom.role` **and every `DocBinding`** — so a role change needs a rejoin, not just a store poke. `rejoinKnownWorkspace(remoteId, docId)` already does fetch-access → computeMyRole → joinWorkspace.
- **v1.52.0 hook:** `#shareBtn` is greyed for a `nonEditorCollaborator` and `openShareModal()` early-returns for viewer/reviewer. That greyed button is where the requester's affordance attaches.
- `#shareBtn` is plain HTML in `index.html` (`#shareBtnGroup`), wired in `collab.ts`. `showToast(msg, type)` from `stores/toast.ts`. `.comment-badge` style (`_comments.scss`) is the badge pattern.

## Design

### 1. Data model — a separate storage key

New DO storage key **`"accessRequests"`**: `AccessRequest[]` where

```ts
// src/access-role.ts
export interface AccessRequest {
  username: string;
  message: string; // "" if none; capped at 500 chars server-side
  createdAt: number;
}
```

Kept separate from the `access` record so `PUT /access` (roster editing) and the request flow don't entangle. `getAccessRequests(): Promise<AccessRequest[]>` helper alongside `getAccess()`.

### 2. Server — endpoints

**`POST /api/workspace/:id/access-request`** (the requester):

- Body: `{ message?: string }`.
- `authorize()` → must be `ok` with role `viewer` or `reviewer`. Else:
  - `editor` / owner → `400` "You already have edit access."
  - not `ok` → propagate its `401` / `403` (denied outsiders are out of scope — they get the plain 403).
- Upsert into `accessRequests` by `username` (replace any existing entry). `message` trimmed + sliced to 500. `createdAt = Date.now()`.
- `broadcast(MESSAGE_ACCESS_REQUEST frame, null)` — `[6, username, message]`.
- `Response.json({ ok: true })`.

**`POST /api/workspace/:id/access-request/:username`** (the owner):

- Body: `{ action: "approve" | "deny", role?: Role }` (`role` only for approve; defaults `editor`).
- Session username must equal `access.owner` → else `403`.
- `approve`: upsert `{ username, role: role ?? "editor" }` into `access.invited`, persist `access`; remove `username` from `accessRequests`, persist. `broadcast(MESSAGE_ACCESS_CHANGED, null)`.
- `deny`: remove `username` from `accessRequests`, persist. `broadcast(MESSAGE_ACCESS_CHANGED, null)`.
- `404` if no such pending request.
- `Response.json({ ok: true })`.

**`GET /api/workspace/:id/access`** (extended):

- For the **owner** (`auth.ok && auth.username === access.owner`): add `accessRequests` (the full list) to the response.
- For an **authenticated non-owner**: add `myAccessRequestPending: boolean` (`accessRequests.some(r => r.username === auth.username)`) — but **not** the list (other people's usernames/messages stay private).
- For an **outsider** (redacted): neither field.

### 3. Wire protocol — two new frame types

```ts
const MESSAGE_ACCESS_REQUEST = 6; // [6, username(varString), message(varString)] — no docId
const MESSAGE_ACCESS_CHANGED  = 7; // [7] — no payload, no docId
```

Both handled with an early `return` in `client/src/collab.ts`'s `handleServerMessage`, before the `docId = decoding.readVarString(decoder)` at the shared tail (same placement as `MESSAGE_WORKSPACE_META` / `_DELETED`). No back-compat guard needed beyond that — the client is served from the same deploy as the Worker.

Optionally, `PUT /access` also `broadcast(MESSAGE_ACCESS_CHANGED)` on a successful change, so a mid-session role edit from the roster UI propagates too (small, and it's the same handler). **Include it.**

### 4. Client — requester side

- `stores/share.ts`: `myAccessRequestPending` writable (seeded from `GET /access`'s field on join and on `MESSAGE_ACCESS_CHANGED`).
- `#shareBtn` click wiring (`collab.ts`): today `addEventListener("click", openShareModal)`. Change to a dispatcher —
  - `nonEditorCollaborator` (viewer/reviewer in a shared room) → `requestAccessModalOpen.set(true)` (new store).
  - otherwise → `openShareModal()` as today.
- New `client/src/components/RequestAccessModal.svelte` (mounted in `main.ts` next to `Share`): a `Modal` with an optional `<textarea>` "Add a note to the owner (optional)" + "Send request" / "Cancel". Bound to `requestAccessModalOpen`.
  - Send → `POST /api/workspace/<remoteId>/access-request` with `{ message }` → on `ok`: close, `showToast("Request sent to the owner", "info")`, `myAccessRequestPending.set(true)`.
  - If `myAccessRequestPending` is already `true` when the button is clicked, skip the modal and just `showToast("Your access request is still pending", "info")` (or open the modal pre-filled disabled with a "Cancel request" option — **v1: just the toast**, keep it simple).
- The greyed `#shareBtn`'s `title` (set by `Share.svelte`'s CV2-2 `$effect`) becomes `"Request edit access"` for a `nonEditorCollaborator` without a pending request, `"Edit access requested"` with one.

### 5. Client — owner side

- `MESSAGE_ACCESS_REQUEST` handler: if `get(collabIsOwner)` → `showToast(\`${username} requested edit access\`, "info")`. (The badge count comes from `shareAccess`.)
- `shareAccess` store gains `accessRequests?: AccessRequest[]` (owner only). `syncShareStores()` carries it through from `currentAccess`.
- `#shareBtn` badge: a new `<span id="shareRequestBadge" class="comment-badge" hidden>` inside `#shareBtn` in `index.html`; a `Share.svelte` `$effect` sets its text/`hidden` from `$shareAccess.accessRequests?.length` when `$collabIsOwner`. (Does not show while the button itself is greyed — it never is for an owner.)
- `Share.svelte` dialog — new **"Requests"** section rendered above "People with access" when `$collabIsOwner && accessRequests?.length`:
  ```
  <div class="menu-section-label">Requests</div>
  {#each accessRequests as req}
    <div class="share-person share-request">
      avatar · username · (message, muted, if any)
      <select> Viewer / Reviewer / Editor (default Editor) </select>
      <button>Approve</button>  <button class="share-person-remove">Deny</button>
    </div>
  {/each}
  ```
  - Approve → `POST /access-request/<username> { action: "approve", role: <select> }` → on ok, re-`fetchWorkspaceAccess` + `syncShareStores`.
  - Deny → `{ action: "deny" }` → same refresh.
  - `collab.ts` exports thin `approveAccessRequest(remoteId, username, role)` / `denyAccessRequest(remoteId, username)` wrappers (like `addPerson` / `removeInvite`), so `Share.svelte` doesn't build URLs.

### 6. Client — `MESSAGE_ACCESS_CHANGED` handler (all clients)

```
if (messageType === MESSAGE_ACCESS_CHANGED) {
  const remoteId = workspaceRoom.workspaceId;
  const local = remoteId ? get(workspacesStore).find(w => w.remoteId === remoteId) : null;
  if (local) void handleAccessChanged(local, remoteId);
  return;
}
```

`handleAccessChanged(local, remoteId)`:

1. `const access = await fetchWorkspaceAccess(remoteId);` — updates `currentAccess`; `syncShareStores()` refreshes `shareAccess` (roster + requests for an owner with the dialog open).
2. `myAccessRequestPending.set(access.myAccessRequestPending ?? false)`.
3. `const newRole = computeMyRole(access, window.MDE.githubUsername);`
4. If `newRole !== workspaceRoom.role`:
   - `showToast(newRole ... > old ? "You now have edit access" : "Your access to this workspace changed", "info")`.
   - `await rejoinKnownWorkspace(remoteId, workspaceRoom.activeDocId ?? <first doc>)` — reconnects the WS at the new role, rebuilds bindings, re-applies chrome.
5. Else if the requester had a pending request that is now gone and role is unchanged → `showToast("Your access request was declined", "info")`.

`rejoinKnownWorkspace` already exists and does exactly steps of a re-join; confirm it tolerates being called while connected (it calls `joinWorkspace` which calls `teardownWorkspace()` first — good).

### 7. Redaction & auth edge cases

- `GET /access` **must not** leak `accessRequests` (usernames + free-text messages) to non-owners. Only `myAccessRequestPending: boolean` for an authenticated non-owner; nothing for an outsider.
- `POST /access-request` from an already-`editor` / owner → `400`, no state change, no broadcast.
- `POST /access-request/:username` (owner action) for a username not in `accessRequests` → `404`.
- A request from a user later removed from `invited` while their request is pending: harmless — the request still lists them; approve re-adds them.
- Two owners? Not possible — `access.owner` is a single string.

## Data flow

```
viewer clicks greyed #shareBtn
  └─▶ RequestAccessModal → POST /access-request {message}
        server: upsert accessRequests, broadcast MESSAGE_ACCESS_REQUEST[6,user,msg]
          ├─▶ owner client: toast "user requested edit access"; GET /access badge++ (on next open/refresh)
          └─▶ (others ignore)
        requester: myAccessRequestPending = true; button title → "Edit access requested"

owner opens Share → Requests section (from GET /access accessRequests)
  ├─ Approve → POST /access-request/:user {action:approve, role}
  │     server: invited += {user, role}; accessRequests -= user; broadcast MESSAGE_ACCESS_CHANGED[7]
  └─ Deny   → POST /access-request/:user {action:deny}
        server: accessRequests -= user; broadcast MESSAGE_ACCESS_CHANGED[7]

every client on MESSAGE_ACCESS_CHANGED:
  GET /access → syncShareStores; myAccessRequestPending = resp.field
  newRole = computeMyRole(access)
  newRole !== workspaceRoom.role  → toast + rejoinKnownWorkspace (WS reconnects at new role → chrome updates)
  else if had-pending & now-gone  → toast "declined"
```

## Testing

| Area | Test | File |
|---|---|---|
| `POST /access-request` | viewer/reviewer → 200 + stored + `MESSAGE_ACCESS_REQUEST` broadcast; editor/owner → 400; outsider → 403; message trimmed/capped; re-request replaces | `tests/src/workspace-room.test.ts` |
| `POST /access-request/:username` | owner approve → `invited` updated + request removed + `MESSAGE_ACCESS_CHANGED`; deny → request removed + broadcast; non-owner → 403; unknown username → 404 | `tests/src/workspace-room.test.ts` |
| `GET /access` redaction | owner sees `accessRequests`; authed non-owner sees only `myAccessRequestPending` (bool); outsider sees neither; `redactAccessForOutsider` unchanged for owner/invited | `tests/src/workspace-room.test.ts`, `tests/src/access-visibility.test.ts` |
| `PUT /access` also broadcasts `MESSAGE_ACCESS_CHANGED` | after an owner role edit | `tests/src/workspace-room.test.ts` |
| client handlers | `MESSAGE_ACCESS_REQUEST` → owner toast only; `MESSAGE_ACCESS_CHANGED` → `handleAccessChanged` re-fetches, rejoins on role change, toasts "declined" when a pending request vanished with no role change | `tests/client/src/collab.test.ts` |
| `#shareBtn` dispatch | a `nonEditorCollaborator` click opens `RequestAccessModal` not the share modal; an editor/owner/local click still opens the share modal | `tests/client/src/collab.test.ts` |
| `RequestAccessModal` | renders the textarea + buttons; Send posts and toasts; a pending request short-circuits to a toast | `tests/client/src/components/RequestAccessModal.test.ts` |
| `Share.svelte` Requests section | shown only for an owner with pending requests; Approve/Deny call the wrappers with the right args; badge reflects the count | `tests/client/src/components/Share.test.ts` |
| e2e | owner shares as Viewer → B joins → B clicks Share → sends a request → A sees the toast + badge → A opens Share, approves → B's editor surface unlocks live (no reload) | `tests/e2e/collab/request-access.spec.ts` (new) |

## Rollout

User-facing → **minor bump**. `CHANGELOG.md` `### Added` (request edit access + owner approve/deny; mid-session role changes now take effect live). One `whats-new-entries.ts` entry ("Ask for Edit Access" — "Collaboration") with a real screenshot (the owner's Share dialog with a pending request row). `docs/TEST-COVERAGE.md` — new COLLAB rows. `ROADMAP.md` — CV2-5 → shipped; the "Google Docs parity" deferred list drops the "Request edit access" bullet.

`dev-login.patch` note: this adds routes to `src/workspace-room.ts` (not `src/worker.ts`), so the e2e-collab/e2e-github dev-login patch is unaffected — but double-check `git apply --check` still passes after the change, per `project_dev_login_patch_fragility`.

## Open questions

1. **A pending request the requester wants to cancel.** v1 has no "cancel my request" — the button just says "Edit access requested" and a re-click toasts "still pending". Add a `DELETE /access-request` (self) + a "Cancel request" affordance, or leave it?
2. **Owner offline when the request lands.** The badge + Requests section surface it on next Share open — but nothing pulls the owner's attention if they never open Share. Acceptable for v1 (matches "no email" being the known gap), or add a one-time app-load toast for the owner when `accessRequests` is non-empty?
