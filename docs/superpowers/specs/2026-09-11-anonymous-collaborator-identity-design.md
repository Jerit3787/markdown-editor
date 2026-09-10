# Anonymous collaborator identity — design

**Status:** approved (brainstorm 2026-09-11)
**Sizing:** feature-sized — new server identity mechanism, schema additions to
synced types, touches both integrity modules + client identity plumbing +
presence + version history. Full spec + plan.

## Goal

Give every anonymous collaborator a stable, distinct identity so that
"is this suggestion / comment mine?" is answerable — fixing the concrete
bug that an anonymous reviewer cannot withdraw their own suggestion — and
so the codebase stops treating anonymous users as a `?? "Anonymous"`
special case scattered across client and server.

## Background — the current model and the bug

Signed-in users are identified by their **GitHub username**: unique
(GitHub enforces it), stable, server-verified (the session cookie is
re-checked against the real GitHub API). It is the app's identity key
everywhere — workspace `owner`, the `invited` roster, `authorize()`.

Anonymous users have **no server identity**. `WorkspaceRoom` sessions
carry `username: null`. The integrity observers fall back to the literal
string `"Anonymous"`:

- `src/workspace-room.ts:296` (suggestions observer): `const actor = session.username ?? "Anonymous"`
- `src/workspace-room.ts:400` (comments observer): `const actor = session.username ?? "Anonymous"`
- `src/workspace-room.ts:257` (`reconcileReviewerDelta` author)
- `src/workspace-room.ts:962` (`captureReviewerPreState` reviewer)

`isValidNewSuggestionEntry(entry, actor)` / `isValidNewThread(entry, actor)`
require `entry.author === actor`, so **every anonymous person collapses to
the single identity `"Anonymous"`**.

Meanwhile the client uses *three different strings* for one anon user:

| Used for | Anon value | Source |
|---|---|---|
| suggestion `author` + awareness/presence | `"Swift Otter"` (random per tab) | `getGuestIdentity().name` (`collab.ts`) |
| comment / reply `author` | `"Anonymous"` | `viewerName()` (`AnnotationRail.svelte:173`) |
| card ownership check `viewer.name` | `""` | `AnnotationRail.svelte:338` (`githubUsername ?? ""`) |

Consequences:

1. An anon reviewer's client authors a suggestion `"Swift Otter"`; the
   server reverts it (`!== "Anonymous"`) and keeps its own auto-wrapped
   `"Anonymous"` copy. The cute name never survives in authored content.
2. The card's Withdraw button renders only when
   `annotation.author === viewer.name`, i.e. `"Anonymous" === ""` →
   **never**. An anonymous reviewer cannot withdraw their own suggestion.
3. Even if the client string matched, all anons share `"Anonymous"` — any
   anon could act on any other anon's items.

## Design

### 1. The `Author` convention (zero migration)

An author string is **either**:

- a **GitHub username** — `[A-Za-z0-9-]`, ≤ 39 chars, no prefix. This
  stays the identity for signed-in users. Every existing `author` in
  every shared doc is already a valid `Author`.
- **`anon:<random>`** — literal `anon:` followed by ~16 base62 chars.
  Namespaced so it can never collide with a username (a username has no
  `:`).

Helper (client + a hand-synced Worker copy if needed):
`isAnonAuthor(a: string): boolean` → `a.startsWith("anon:")`.

No data migration. Legacy content authored `"Anonymous"` is left as-is
(see Compatibility).

### 2. Server: minting + token + handshake

**`SessionInfo`** (`src/workspace-room.ts`) gains:

```ts
anonId?: string;    // "anon:xxxxxxxxxxxxxxxx" — set only when username === null
anonName?: string;  // "Adjective Animal" — server-assigned display label
```

**`identityOf(session: SessionInfo | undefined): string | null`** — new
module-level helper: `session?.username ?? session?.anonId ?? null`. The
single "who is this connection" accessor; replaces every
`session.username ?? "Anonymous"` / `?? undefined`.

**Minting.** In `fetch()`'s WS-upgrade branch, after `authorize()`
resolves and `auth.username === null`:

1. read `?anon=<token>` from the upgrade URL
2. `verifyAnonToken(env, token)` → on success reuse its `{ anonId, anonName }`
3. on missing / invalid / expired → mint fresh:
   - `anonId = "anon:" + randomBase62(16)` (from `crypto.getRandomValues`)
   - `anonName = pick(GUEST_ADJECTIVES) + " " + pick(GUEST_ANIMALS)`

   Name generation now happens **only** server-side. A new
   `src/guest-names.ts` holds the two word lists + a `randomGuestName()`.
   The client's `GUEST_ADJECTIVES` / `GUEST_ANIMALS` / `getGuestIdentity()`
   in `collab.ts` are deleted — the client never invents a name any more.

`handleSession(ws, username, role, isPreview, anonIdentity?)` gains an
optional `anonIdentity: { anonId: string; anonName: string }` param and
stores it on the `SessionInfo`.

**Token.** `src/auth.ts` gains:

```ts
export async function signAnonToken(env: Env, data: { anonId: string; anonName: string }): Promise<string>
export async function verifyAnonToken(env: Env, token: string): Promise<{ anonId: string; anonName: string } | null>
```

Same HMAC primitive as `encryptSession`/`decryptSession` (keyed on
`SESSION_SECRET`). Payload `{ anonId, anonName, iat }`; `verifyAnonToken`
returns `null` on a bad signature or when `iat` is older than 30 days.
The token is **only an identity label** — it grants no access (role comes
entirely from `authorize()`), and it is independent of the Turnstile
join-ticket (an anon connects with both `?ticket=` and `?anon=` when
Turnstile is on).

**Handshake frame.** New `const MESSAGE_ANON_IDENTITY = 8`. Immediately
after the `ws.send(this.encodeWorkspaceMeta())` greeting in
`handleSession`, if the session has an `anonId`, send one
`MESSAGE_ANON_IDENTITY` frame:

```
writeVarUint(MESSAGE_ANON_IDENTITY)
writeVarString(anonId)
writeVarString(anonName)
writeVarString(token)   // freshly signed — reused id or newly minted
```

### 3. Data model & integrity

**Schema (additive, optional):** `SuggestionEntry` (`src/suggestions.ts`
+ client copy), `CommentThreadEntry` (`src/comments-doc.ts` + client
copy), and each reply object gain:

```ts
authorName?: string;
```

Set **only** when `author` is an `anon:` id (a signed-in user's `author`
is already their display name). One render helper
`displayName(author: string, authorName?: string): string` →
`authorName ?? author`.

**Integrity observers become identity-uniform:**

- `src/workspace-room.ts:296` and `:400` — `const actor = identityOf(session)`.
  Both observers already bail when `!session || session.role === "viewer"`;
  add a bail when `actor === null` (should not happen for a live
  non-viewer session, defensive).
- `src/workspace-room.ts:257` — `reconcileReviewerDelta(doc, delta, identityOf(session) ?? "Anonymous")`
  (keep a string fallback here since the signature is non-null; `null`
  can't occur for a reviewer session).
- `src/workspace-room.ts:962` — `captureReviewerPreState(docRoom.doc, identityOf(session) ?? "Anonymous")`.
  **This is the change that lets an anon reviewer's own-insert deletion
  be recognised as theirs, so Withdraw actually applies** (the
  COLLAB-05b "withdraw-own survives" path keys the reviewer's own insert
  ranges on this string).
- `src/comment-integrity.ts` `isValidNewThread(entry, username)` — the
  `if (!entry || !username) return false` early-return keeps the `!entry`
  guard but drops `!username` (an anon session now has a real `anonId`).
  Rename the param `actor` for clarity.
- `isValidNewSuggestionEntry`, `isAllowedThreadTransition`, the
  reply-append `appended.author === actor` checks — logic unchanged; the
  `actor` value can now be an `anon:` id.

**Name stamping (server authoritative).** In the suggestions-map and
comments-map observers, when a new or updated entry is *valid* and its
`author` is an `anon:` id, the observer rewrites `authorName` from
`session.anonName` inside its existing reconcile-origin transaction
(`"suggestion"` / `"comment-reconcile"` — the origin it already skips).
The client never has to set `authorName` correctly; a guest cannot spoof
a label.

### 4. Client

**`client/src/stores/collabIdentity.ts` (new):**

```ts
import { writable } from "svelte/store";
export const collabIdentity = writable<{ id: string; name: string }>({ id: "", name: "" });
```

The single client-side "who am I". Set:
- signed in → `{ id: username, name: username }` wherever `githubUsername`
  is resolved (`collab.ts` / `gist.ts` `checkSession`)
- anon → from the `MESSAGE_ANON_IDENTITY` frame

**`client/src/collab.ts`:**
- The workspace WS upgrade URL gains `?anon=<localStorage["mde_anon_token"] || "">`.
- Handle `MESSAGE_ANON_IDENTITY`: persist **both** the opaque `token`
  (`localStorage["mde_anon_token"]`) and the plaintext
  `{ anonId, anonName }` (`localStorage["mde_anon_identity"]`), each in a
  try/catch, then `collabIdentity.set({ id: anonId, name: anonName })`.

**Identity timing.** An anon's identity is only authoritative once the
`MESSAGE_ANON_IDENTITY` frame lands (one round-trip after connect).
Handled by:
- **Returning visitor:** on module load, if `localStorage["mde_anon_identity"]`
  parses, seed `collabIdentity` from it synchronously — no flash, and it
  will match what the server sends back (same token → same id).
- **First-ever visit / server re-mint:** `collabIdentity.id` is `""` until
  the frame arrives. A store subscription in `collab.ts` rebuilds the
  editing-mode compartment (awareness identity + `suggestionExtensions`)
  whenever `collabIdentity.id` actually changes — the same compartment
  `enterCollabMode` already reconfigures on a mode switch.
- A suggestion authored in the sub-second gap before the frame (id `""`)
  is reverted by the server (`"" !== anon:…`) and re-created by the
  auto-wrap under the correct actor — self-correcting, and not reachable
  by a human typing that fast in practice.
- `getGuestIdentity()` and the client word lists are **deleted**.
  Presence / awareness identity now derives from `collabIdentity`:
  `name` = the assigned label, `color` = `colorForUsername(id)`
  (`user-color.ts`'s hash already accepts any string — no change there).
  The awareness identity and the authored-content identity are now the
  same person. The two `applyEditorMode` / rebuild sites that compute
  `identity` (`collab.ts:1026`, `:1134`) read `get(collabIdentity)`
  instead of branching on `username ? … : getGuestIdentity()`.
- `suggestionExtensions(binding.ydoc, identity.id, { viewerRole, viewerName: identity.name })`
  — the `author` passed in is the **id**.

**`client/src/components/AnnotationRail.svelte`:**
- `viewer = $derived({ role: $collabRole, id: $collabIdentity.id })`.
- The authoring calls (`createCommentThread`, `addCommentReply`,
  `addSuggestionReply`, and the suggestion path) pass `$collabIdentity.id`.
- `viewerName()` helper removed.

**`client/src/annotations.ts` / `AnnotationCard.svelte`:**
- `RailAnnotation` carries `authorName?: string`; `suggestionCards` and
  `commentCard` pass it through from the resolved entry (for a grouped
  replace-pair card, take the delete half's — both halves have the same
  author).
- `AnnotationCard`: `isOwn = !!viewer.id && annotation.author === viewer.id`;
  header shows `displayName(annotation.author, annotation.authorName)`;
  avatar — `isAnonAuthor(annotation.author)` → generic `#icon-user`
  `<svg>` instead of the `https://github.com/<author>.png` URL.
- `viewer` prop type changes from `{ role; name }` to `{ role; id }`
  across `AnnotationCard` and `AnnotationRail`.

**Version history:** `DocRoom.pendingAuthors` accumulates `identityOf(session)`
(was `session.username` only — anon edits were dropped). The snapshot
gains `authorNames?: Record<string, string>` populated from
`session.anonName` for any `anon:` author in that window.
`VersionHistory.svelte` resolves an `anon:` author via `authorNames`
(fallback `"Guest"`) and uses the generic avatar. `authors` for
pre-feature snapshots stays `string[]` of usernames — unchanged.

### 5. Resolved-entry plumbing

`listResolvedSuggestions` (`src/suggestions.ts` + client copy) and
`listResolvedCommentThreads` (`src/comments-doc.ts` + client copy) carry
`authorName` through onto `ResolvedSuggestion` / `ResolvedCommentThread`
(both already `Omit` `from`/`to` and re-add the numeric versions — add
`authorName` to the passthrough).

## Compatibility

- **Zero data migration.** Existing `author: "<username>"` entries — an
  unprefixed string is a GitHub user, permanently. Existing anon content
  authored `"Anonymous"` stays: `displayName` shows "Anonymous", `isOwn`
  is false for everyone (no session's `identityOf` is literally
  `"Anonymous"`), so an editor can still accept/reject those, nobody
  withdraws them. Acceptable for pre-feature content.
- The client stops ever writing the literal `"Anonymous"`; the string is
  recognised in *display* only.
- An old client (no `?anon`, ignores `MESSAGE_ANON_IDENTITY`) still
  connects — the server mints an id, the frame is ignored, that client
  keeps behaving as today (its anon content gets reverted/auto-wrapped
  server-side as before, now under the minted id + `"Anonymous"`-less
  actor). No hard break.

## Non-goals

- User-editable guest names (server assigns; a rename UI is a later pass).
- Migrating legacy `"Anonymous"`-authored content to real ids.
- Retroactively reassigning a guest's content to their username when they
  sign in mid-session.
- Cross-device guest identity (the token is per-browser `localStorage`).
- Opaque / numeric ids for signed-in users — the GitHub username stays
  the identity key (owner field, invite roster, session verification all
  key on it; changing that is a large migration for a rare edge case).
- Guest-name uniqueness within a workspace, or rate-limiting anon mints
  (two "Swift Otter"s can coexist — each has a distinct id; the collision
  is cosmetic).
- The D4 suggestion line-grouping brainstorm (paused; resumes after this).

## Edge cases

| Case | Behaviour |
|---|---|
| `localStorage` blocked / cleared | no token sent → fresh mint each connect; guest works, new name per session |
| Token from another deploy / rotated `SESSION_SECRET` | signature fails → treated as missing → fresh mint, no error surfaced |
| Signed-in user signs out mid-session | reconnect → `username === null` → picks up / mints an anon identity; prior content keeps the username author |
| Anon signs in mid-session | reconnect → identity switches to username; the guest's pending suggestions stay `anon:xxx` (Non-goal to migrate) |
| `?preview=1` socket | still pinned `viewer`, authors nothing; an anon id is minted but unused — harmless |
| Two tabs, one browser | share the one `localStorage` token → same guest identity (intended) |
| Awareness colour for an `anon:` id | `colorForId` hashes the id, same palette |
| Two guests, same random name | distinct ids; withdraw/ownership still correct; only the label collides |

## Testing

**`tests/src/auth.test.ts`** — `signAnonToken` / `verifyAnonToken`
round-trip; tampered token → `null`; `iat` > 30 days → `null`.

**`tests/src/workspace-room.test.ts`**
- WS upgrade, no `?anon` → session gets an `anonId` + `anonName`; a
  `MESSAGE_ANON_IDENTITY` frame is sent with a verifiable token.
- WS upgrade with that token → same `anonId` / `anonName` reused.
- WS upgrade with a tampered token → fresh mint (different id).
- An anon reviewer's suggestion authored with their `anonId` is **kept**
  (not reverted) and its `authorName` is stamped to `anonName`.
- An anon reviewer withdrawing (rejecting) their own pending insert
  **applies** — the text is removed and the entry deleted (the line-962
  `captureReviewerPreState` change).
- A *second* anon session cannot withdraw the first anon's suggestion
  (its `identityOf` differs) — reverted.
- An anon comment thread authored with the `anonId` is kept and
  `authorName`-stamped; a second anon can't edit/delete it; the owner
  can delete it.

**`tests/src/comment-integrity.test.ts` / `reviewer-integrity.test.ts`** —
`actor` as an `anon:` id: `isValidNewThread` / `isValidNewSuggestionEntry`
/ `isAllowedThreadTransition` pass for the matching id, fail for a
different one; the dropped `!username` guard no longer rejects a real
anon id.

**`tests/client/src/`**
- `displayName(author, authorName)` unit cases.
- `annotations.ts` — `authorName` flows onto `RailAnnotation` for a plain
  card and a grouped replace-pair.
- component (`tests/client/src/components/AnnotationCard.test.ts`): an
  anon reviewer (`collabIdentity.id === annotation.author`) sees the
  `[data-act="withdraw"]` button (the original bug); an `anon:` author
  renders the generic avatar, not a `github.com` `<img>`.

**Full suite:** `npm test`, `npx vitest run --project=components`,
`npm run typecheck`, `npm run build`, `npm run format:check`,
`npm run check:no-dev-login`.

## Versioning

User-facing (guests are now distinct and named; an anon reviewer can
withdraw their own suggestion) → **minor** bump. `CHANGELOG.md` `### Added`
/ `### Fixed`, and a `client/src/whats-new-entries.ts` entry **with a real
captured screenshot** (two differently-named guests' cards in the rail).
ROADMAP: close the "Friendly identities for anonymous link viewers" item
under *Google Docs parity*; note the withdraw bug fixed.
