# Anonymous Collaborator Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every anonymous collaborator a stable, distinct server-minted identity (`anon:<random>`) so "is this mine?" is answerable — fixing the bug that an anonymous reviewer cannot withdraw their own suggestion — and collapse the scattered `?? "Anonymous"` special-casing into one `identityOf()` accessor.

**Architecture:** On the WS upgrade a session with no GitHub username is assigned `{ anonId, anonName }` — reused from a signed HMAC token the client stored in `localStorage`, or freshly minted. The server sends it back in a new `MESSAGE_ANON_IDENTITY` frame; the client mirrors it into a `collabIdentity` store used for authoring and the card-ownership check. The `suggestions` / `comments` integrity observers switch from `session.username ?? "Anonymous"` to `identityOf(session)` and stamp an authoritative `authorName` label onto anon-authored entries.

**Tech Stack:** TypeScript, Cloudflare Workers (Durable Objects), Web Crypto (HMAC-SHA256), Yjs, Svelte 5, Vitest (`unit` = node/jsdom; `components` = real headless Chromium via `vitest-browser-svelte`).

**Spec:** `docs/superpowers/specs/2026-09-11-anonymous-collaborator-identity-design.md`

## Global Constraints

- **`Author` convention:** an author string is a GitHub username (`[A-Za-z0-9-]`, ≤39, no prefix) OR `anon:` + 16 base62 chars. Unprefixed = GitHub user, permanently. **Zero data migration** — every existing `author` is already valid.
- `client/src/comments-doc.ts` and `src/comments-doc.ts` MUST stay **byte-identical** — `tests/src/comments-doc-parity.test.ts` enforces it. `client/src/suggestions.ts` and `src/suggestions.ts` are hand-synced byte-identical too (no test, keep them so).
- `src/reviewer-integrity.ts` and `src/comment-integrity.ts` are **server-only**, not synced to client.
- The anon token grants **no access** — role always comes from `authorize()`. It is independent of the Turnstile join-ticket (an anon connects with both `?ticket=` and `?anon=` when Turnstile is on).
- Never write the literal string `"Anonymous"` as an author from the client after this change; it is recognised in display only.
- New message type constant: `MESSAGE_ANON_IDENTITY = 8` (0,1,2,3,5,6,7 taken; 4 retired).
- Token TTL: **30 days** (`iat + 30d <= now` → invalid).
- Version bump is the **last step before the PR**; hand-edit `package.json` + both `package-lock.json` `"version"` fields (lines ~3 and ~9). This is **user-facing** → **minor** bump + `CHANGELOG.md` + a `client/src/whats-new-entries.ts` entry **with a real captured screenshot** in `client/public/whats-new/`.
- Commit trailer: `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`. PR body ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. Never add a `Claude-Session:` link.
- Branch `feat/anon-collaborator-identity` already exists off `master` with the spec committed.
- Full verification before PR: `npm test`, `npx vitest run --project=components`, `npm run typecheck`, `npm run build`, `npm run format:check`, `npm run check:no-dev-login`.

### Deviations from the spec (decided during planning)

1. **`viewer` prop keeps the field name `name`** (not renamed to `id`) — it now *holds* the identity (username or `anon:id`); `AnnotationCard`'s only use is `annotation.author === viewer.name`. Avoids renaming ~10 existing test call sites; existing tests pass unchanged (a username is its own id).
2. **No `isAnonAuthor()` helper** — inline `author.startsWith("anon:")` at the 2 sites that need it (card avatar, name stamping). Not worth a shared module.
3. **Version history:** `pendingAuthors` records the display name (`session.username ?? session.anonName`); `Snapshot.authors` stays `string[]`, `VersionHistory.svelte` unchanged (already renders author strings as coloured initials, no avatar fetch).

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `src/auth.ts` | Modify | Add `signAnonToken` / `verifyAnonToken` (HMAC-SHA256 over `SESSION_SECRET`, 30-day `iat` check). |
| `tests/src/auth.test.ts` | Modify | Round-trip / tamper / expiry cases for the anon token. |
| `src/guest-names.ts` | Create | `GUEST_ADJECTIVES`, `GUEST_ANIMALS`, `randomGuestName()`, `randomAnonId()`. Server-only. |
| `tests/src/guest-names.test.ts` | Create | Shape of a minted id/name. |
| `src/workspace-room.ts` | Modify | `SessionInfo.anonId/anonName`; `identityOf()`; mint in the WS-upgrade branch; `handleSession` param + `MESSAGE_ANON_IDENTITY` frame; the 4 integrity call sites → `identityOf`; `authorName` stamping in both observers; `pendingAuthors` records display name. |
| `src/comment-integrity.ts` | Modify | `isValidNewThread` param `username` → `actor`, drop the `!username` early-return. |
| `src/suggestions.ts` + `client/src/suggestions.ts` | Modify (identical) | `SuggestionEntry.authorName?`, `ResolvedSuggestion` passthrough, `recordInsertSuggestion` preserves `authorName` on contiguous-extend. |
| `src/comments-doc.ts` + `client/src/comments-doc.ts` | Modify (byte-identical) | `Reply.authorName?`, `CommentThreadEntry.authorName?`, `ResolvedCommentThread.authorName?`, `listResolvedCommentThreads` passthrough. |
| `tests/src/workspace-room.test.ts` | Modify | Mint / reuse / tamper; anon suggestion kept + stamped; anon withdraw-own applies; second anon can't; anon comment kept + stamped; version-history anon author. |
| `tests/src/comment-integrity.test.ts`, `tests/src/reviewer-integrity.test.ts` | Modify | `actor` as an `anon:` id. |
| `client/src/stores/collabIdentity.ts` | Create | `collabIdentity` writable `{ id, name }`; synchronous seed from `localStorage["mde_anon_identity"]`. |
| `client/src/collab.ts` | Modify | `?anon=` on the WS URL; `MESSAGE_ANON_IDENTITY` handler (persist token + identity, set store); delete `getGuestIdentity` + word lists; `applyEditorMode` reads `collabIdentity`; rebuild the editing compartment when `collabIdentity.id` changes; set `collabIdentity` for a signed-in user. |
| `client/src/components/AnnotationRail.svelte` | Modify | `viewer.name` / `viewerName()` → `$collabIdentity.id`. |
| `client/src/annotations.ts` | Modify | `RailAnnotation.authorName?`; `suggestionCards` / `commentCard` passthrough; export `displayName`. |
| `client/src/components/AnnotationCard.svelte` | Modify | header shows `displayName(...)`; generic avatar when `author.startsWith("anon:")`. |
| `tests/client/src/components/AnnotationCard.test.ts` | Modify | anon-reviewer-sees-withdraw regression; generic avatar. |
| `tests/client/src/annotations.test.ts` (or new) | Modify/Create | `authorName` passthrough; `displayName`. |
| `CHANGELOG.md`, `client/src/whats-new-entries.ts`, `client/public/whats-new/<file>.png`, `ROADMAP.md`, `docs/TEST-COVERAGE.md`, `package.json`, `package-lock.json` | Modify | Release. |

---

## Task 1: Anon token — `signAnonToken` / `verifyAnonToken`

**Files:**
- Modify: `src/auth.ts`
- Test: `tests/src/auth.test.ts`

**Interfaces:**
- Consumes: `Env` (`env.SESSION_SECRET`), Web Crypto.
- Produces:
  - `signAnonToken(env: Env, data: { anonId: string; anonName: string }): Promise<string>` — `<base64url(json)>.<base64url(hmac)>`
  - `verifyAnonToken(env: Env, token: string): Promise<{ anonId: string; anonName: string } | null>` — `null` on bad signature, malformed JSON, missing fields, `anonId` not starting `anon:`, or `iat` older than 30 days.

- [ ] **Step 1: Write the failing tests**

Add to `tests/src/auth.test.ts` (it already imports from `../../src/auth` and has `fakeEnv` + `THIRTY_DAYS_MS`):

```ts
import { encryptSession, decryptSession, cookieHeader, getCookie, signAnonToken, verifyAnonToken } from "../../src/auth";

describe("anon token round trip", () => {
  it("verifies a token it just signed", async () => {
    const t = await signAnonToken(fakeEnv, { anonId: "anon:abc123", anonName: "Swift Otter" });
    expect(await verifyAnonToken(fakeEnv, t)).toEqual({ anonId: "anon:abc123", anonName: "Swift Otter" });
  });

  it("rejects a token signed under a different secret", async () => {
    const t = await signAnonToken({ SESSION_SECRET: "other" } as unknown as Env, { anonId: "anon:abc123", anonName: "Swift Otter" });
    expect(await verifyAnonToken(fakeEnv, t)).toBeNull();
  });

  it("rejects a tampered payload", async () => {
    const t = await signAnonToken(fakeEnv, { anonId: "anon:abc123", anonName: "Swift Otter" });
    const [, sig] = t.split(".");
    const forged = `${btoa(JSON.stringify({ anonId: "anon:evil", anonName: "x", iat: Date.now() })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}.${sig}`;
    expect(await verifyAnonToken(fakeEnv, forged)).toBeNull();
  });

  it("rejects a malformed value", async () => {
    expect(await verifyAnonToken(fakeEnv, "nope")).toBeNull();
  });

  it("rejects a token older than 30 days", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const t = await signAnonToken(fakeEnv, { anonId: "anon:abc123", anonName: "Swift Otter" });
    vi.setSystemTime(new Date("2026-02-05T00:00:00Z")); // +35 days
    expect(await verifyAnonToken(fakeEnv, t)).toBeNull();
    vi.useRealTimers();
  });

  it("rejects a payload whose anonId lacks the anon: prefix", async () => {
    const t = await signAnonToken(fakeEnv, { anonId: "danishhakim", anonName: "x" });
    expect(await verifyAnonToken(fakeEnv, t)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests — verify they fail**

Run: `npx vitest run tests/src/auth.test.ts`
Expected: FAIL — `signAnonToken` / `verifyAnonToken` are not exported.

- [ ] **Step 3: Implement in `src/auth.ts`**

Add after `decryptSession` (reuses the existing `toBase64Url` / `fromBase64Url` helpers):

```ts
// A signed (not encrypted) identity label for an anonymous collaborator.
// The payload isn't secret — anonId/anonName are visible to every
// collaborator as an entry's `author` — it only needs to be
// tamper-proof, so HMAC-SHA256 over SESSION_SECRET, not AES-GCM.
const ANON_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

async function anonHmacKey(env: Env): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(env.SESSION_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function signAnonToken(env: Env, data: { anonId: string; anonName: string }): Promise<string> {
  const body = toBase64Url(new TextEncoder().encode(JSON.stringify({ ...data, iat: Date.now() })).buffer);
  const sig = await crypto.subtle.sign("HMAC", await anonHmacKey(env), new TextEncoder().encode(body));
  return `${body}.${toBase64Url(sig)}`;
}

export async function verifyAnonToken(env: Env, token: string): Promise<{ anonId: string; anonName: string } | null> {
  try {
    const [body, sig] = token.split(".");
    if (!body || !sig) return null;
    const ok = await crypto.subtle.verify("HMAC", await anonHmacKey(env), fromBase64Url(sig), new TextEncoder().encode(body));
    if (!ok) return null;
    const p = JSON.parse(new TextDecoder().decode(fromBase64Url(body))) as { anonId?: unknown; anonName?: unknown; iat?: unknown };
    if (typeof p.anonId !== "string" || typeof p.anonName !== "string" || typeof p.iat !== "number") return null;
    if (!p.anonId.startsWith("anon:")) return null;
    if (p.iat + ANON_TOKEN_TTL_MS <= Date.now()) return null;
    return { anonId: p.anonId, anonName: p.anonName };
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run the tests — verify they pass**

Run: `npx vitest run tests/src/auth.test.ts`
Expected: PASS (all, including the pre-existing session tests).

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck` → clean.

```bash
git add src/auth.ts tests/src/auth.test.ts
git commit -m "feat: signed anon identity token (signAnonToken / verifyAnonToken)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 2: `src/guest-names.ts` — id + name generation

**Files:**
- Create: `src/guest-names.ts`
- Test: `tests/src/guest-names.test.ts`

**Interfaces:**
- Produces:
  - `randomAnonId(): string` — `"anon:" + 16 chars from [0-9A-Za-z]`, via `crypto.getRandomValues`
  - `randomGuestName(): string` — `"<Adjective> <Animal>"`
  - `GUEST_ADJECTIVES: string[]`, `GUEST_ANIMALS: string[]` (exported for tests)

- [ ] **Step 1: Write the failing test**

Create `tests/src/guest-names.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { randomAnonId, randomGuestName, GUEST_ADJECTIVES, GUEST_ANIMALS } from "../../src/guest-names";

describe("guest-names", () => {
  it("mints an anon id with the anon: prefix and 16 base62 chars", () => {
    const id = randomAnonId();
    expect(id).toMatch(/^anon:[0-9A-Za-z]{16}$/);
  });

  it("mints distinct ids", () => {
    expect(randomAnonId()).not.toBe(randomAnonId());
  });

  it("makes a two-word guest name from the lists", () => {
    const name = randomGuestName();
    const [adj, animal] = name.split(" ");
    expect(GUEST_ADJECTIVES).toContain(adj);
    expect(GUEST_ANIMALS).toContain(animal);
  });
});
```

- [ ] **Step 2: Run — verify it fails**

Run: `npx vitest run tests/src/guest-names.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/guest-names.ts`**

```ts
// Server-side generation of an anonymous collaborator's identity —
// a stable id and a human label. The client no longer invents either
// (it did, per-tab, in collab.ts's deleted getGuestIdentity).

export const GUEST_ADJECTIVES = ["Quiet", "Curious", "Swift", "Gentle", "Bold", "Clever", "Calm", "Bright"];
export const GUEST_ANIMALS = ["Fox", "Owl", "Otter", "Falcon", "Panda", "Lynx", "Heron", "Wren"];

const ID_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

export function randomAnonId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let s = "";
  for (const b of bytes) s += ID_ALPHABET[b % ID_ALPHABET.length];
  return `anon:${s}`;
}

export function randomGuestName(): string {
  const adj = GUEST_ADJECTIVES[Math.floor(Math.random() * GUEST_ADJECTIVES.length)]!;
  const animal = GUEST_ANIMALS[Math.floor(Math.random() * GUEST_ANIMALS.length)]!;
  return `${adj} ${animal}`;
}
```

- [ ] **Step 4: Run — verify it passes**

Run: `npx vitest run tests/src/guest-names.test.ts` → PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
git add src/guest-names.ts tests/src/guest-names.test.ts
git commit -m "feat: server-side anon id + guest-name generation

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 3: Server — mint the identity on WS upgrade + `MESSAGE_ANON_IDENTITY` frame

**Files:**
- Modify: `src/workspace-room.ts` (`SessionInfo` ~149; message consts ~30-62; `handleSession` ~875; WS-upgrade branch ~479-515)
- Test: `tests/src/workspace-room.test.ts`

**Interfaces:**
- Consumes: `verifyAnonToken` / `signAnonToken` (Task 1), `randomAnonId` / `randomGuestName` (Task 2).
- Produces:
  - `SessionInfo.anonId?: string`, `SessionInfo.anonName?: string`
  - `identityOf(session: SessionInfo | undefined | null): string | null` — module-level, `session?.username ?? session?.anonId ?? null`
  - `const MESSAGE_ANON_IDENTITY = 8`
  - `handleSession(ws, username, role, isPreview?, anon?: { anonId: string; anonName: string; token: string })` — stores `anonId`/`anonName` on the `SessionInfo` and, when `anon` is present, sends one `MESSAGE_ANON_IDENTITY` frame right after the meta greeting.

- [ ] **Step 1: Write the failing tests**

Context — how the existing WS-upgrade tests work (`describe("WorkspaceRoom websocket session role")`, ~line 412): `vitest.setup.ts` provides a `MockWebSocket` (no-op `send`/`accept`/`close`/`addEventListener`) via a fake `globalThis.WebSocketPair`. `room.fetch(new Request(url, { headers: { Upgrade: "websocket" } }))` runs `handleSession` synchronously (populating `room.sessions`) and then **throws** on `new Response(null, { status: 101, webSocket })` — so every call is wrapped in `.catch(() => {})` and assertions read `room.sessions`.

To also capture the frames `handleSession` sends, the anon-identity describe block installs a **recording** `WebSocketPair` for its lifetime:

```ts
import { verifyAnonToken, signAnonToken } from "../../src/auth";

const MESSAGE_ANON_IDENTITY = 8;

function decodeAnonIdentityFrame(buf: ArrayBuffer): { anonId: string; anonName: string; token: string } | null {
  const d = decoding.createDecoder(new Uint8Array(buf));
  if (decoding.readVarUint(d) !== MESSAGE_ANON_IDENTITY) return null;
  return { anonId: decoding.readVarString(d), anonName: decoding.readVarString(d), token: decoding.readVarString(d) };
}

describe("WorkspaceRoom anon identity", () => {
  const fakeEnvWithSecret = { SESSION_SECRET: "test-secret-key-not-real" } as unknown as Env;
  let serverSends: ArrayBuffer[];
  const origPair = (globalThis as unknown as { WebSocketPair: unknown }).WebSocketPair;

  beforeEach(() => {
    serverSends = [];
    class Rec {
      accept() {}
      close() {}
      addEventListener() {}
      removeEventListener() {}
      send(d: ArrayBuffer) { serverSends.push(d); }
    }
    (globalThis as unknown as { WebSocketPair: unknown }).WebSocketPair = class {
      0 = new Rec(); // client
      1 = new Rec(); // server — the one handleSession writes to
    };
  });
  afterEach(() => {
    (globalThis as unknown as { WebSocketPair: unknown }).WebSocketPair = origPair;
  });

  async function upgrade(room: WorkspaceRoom, opts: { anon?: string; cookie?: string } = {}) {
    const headers: Record<string, string> = { Upgrade: "websocket" };
    if (opts.cookie) headers.Cookie = `mde_gh_session=${opts.cookie}`;
    const q = opts.anon !== undefined ? `?anon=${encodeURIComponent(opts.anon)}` : "";
    await room.fetch(new Request(`https://example.com/api/workspace/ws1${q}`, { headers })).catch(() => {});
    return [...room.sessions.values()].at(-1)!;
  }

  it("mints an anonId + anonName and sends a MESSAGE_ANON_IDENTITY frame when no token is presented", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnvWithSecret);
    await room.state.storage.put("access", { owner: "alice", generalAccess: "anyone", requireAccount: false, role: "editor", invited: [] });
    const session = await upgrade(room);
    const frame = serverSends.map(decodeAnonIdentityFrame).find((f) => f !== null)!;
    expect(frame.anonId).toMatch(/^anon:[0-9A-Za-z]{16}$/);
    expect(frame.anonName).toMatch(/^\w+ \w+$/);
    expect(await verifyAnonToken(fakeEnvWithSecret, frame.token)).toEqual({ anonId: frame.anonId, anonName: frame.anonName });
    expect(session.anonId).toBe(frame.anonId);
    expect(session.anonName).toBe(frame.anonName);
  });

  it("reuses the identity from a valid token", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnvWithSecret);
    await room.state.storage.put("access", { owner: "alice", generalAccess: "anyone", requireAccount: false, role: "editor", invited: [] });
    const token = await signAnonToken(fakeEnvWithSecret, { anonId: "anon:keepme0000000000", anonName: "Bold Wren" });
    const session = await upgrade(room, { anon: token });
    expect(session.anonId).toBe("anon:keepme0000000000");
    expect(session.anonName).toBe("Bold Wren");
  });

  it("re-mints when the token signature is bad", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnvWithSecret);
    await room.state.storage.put("access", { owner: "alice", generalAccess: "anyone", requireAccount: false, role: "editor", invited: [] });
    const session = await upgrade(room, { anon: "garbage.token" });
    expect(session.anonId).toMatch(/^anon:/);
  });

  it("does not mint for a signed-in session", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnvWithSecret);
    await room.state.storage.put("access", { owner: "alice", generalAccess: "restricted", requireAccount: false, role: "viewer", invited: [] });
    const cookie = await encryptSession(fakeEnvWithSecret, { token: "gh-token", username: "alice" });
    const session = await upgrade(room, { cookie });
    expect(session.anonId).toBeUndefined();
    expect(serverSends.some((b) => decodeAnonIdentityFrame(b) !== null)).toBe(false);
  });

  it("does not mint for a ?preview=1 socket", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnvWithSecret);
    await room.state.storage.put("access", { owner: "alice", generalAccess: "anyone", requireAccount: false, role: "editor", invited: [] });
    await room.fetch(new Request("https://example.com/api/workspace/ws1?preview=1", { headers: { Upgrade: "websocket" } })).catch(() => {});
    expect([...room.sessions.values()].at(-1)!.anonId).toBeUndefined();
  });
});
```

Add `beforeEach, afterEach` to the file's top `import { describe, it, expect, vi } from "vitest"` line if not already there.

- [ ] **Step 2: Run — verify they fail**

Run: `npx vitest run tests/src/workspace-room.test.ts -t "anon identity"`
Expected: FAIL — `session.anonId` is `undefined`, no frame sent.

- [ ] **Step 3: Add the message constant + `SessionInfo` fields + `identityOf`**

In `src/workspace-room.ts`:

Near the other `MESSAGE_*` consts (~line 62):
```ts
// [type][anonId][anonName][token] — docId-less. Sent once to an
// anonymous session right after the meta greeting so the client knows
// its own server-assigned identity and can persist the token.
const MESSAGE_ANON_IDENTITY = 8;
```

In `interface SessionInfo` (after `isPreview?`):
```ts
  // Server-assigned identity for an anonymous connection (username === null).
  // `identityOf(session)` is the single accessor; the integrity observers
  // key ownership on it. Absent for a signed-in session.
  anonId?: string;
  anonName?: string;
```

Just below the `interface SessionInfo` block:
```ts
function identityOf(session: SessionInfo | undefined | null): string | null {
  return session?.username ?? session?.anonId ?? null;
}
```

- [ ] **Step 4: Mint in the WS-upgrade branch**

In `fetch()`, between the `this.deleted` re-check (~line 508) and `new WebSocketPair()`:

```ts
// An anonymous connection is assigned a stable identity — reused from a
// signed token the client stored, or freshly minted. It grants no access
// (role is already resolved above) and is independent of the Turnstile
// join ticket.
let anon: { anonId: string; anonName: string; token: string } | undefined;
if (auth.username === null && !isPreview) {
  const presented = url.searchParams.get("anon");
  const reused = presented ? await verifyAnonToken(this.env, presented) : null;
  const anonId = reused?.anonId ?? randomAnonId();
  const anonName = reused?.anonName ?? randomGuestName();
  anon = { anonId, anonName, token: await signAnonToken(this.env, { anonId, anonName }) };
}
```

Change the `handleSession` call:
```ts
this.handleSession(server, auth.username, effectiveRole, isPreview, anon);
```

Add the imports at the top of the file:
```ts
import { /* …existing… */, signAnonToken, verifyAnonToken } from "./auth";
import { randomAnonId, randomGuestName } from "./guest-names";
```

- [ ] **Step 5: `handleSession` — store fields + send the frame**

```ts
handleSession(ws: WebSocket, username: string | null, role: Role, isPreview = false, anon?: { anonId: string; anonName: string; token: string }): void {
  ws.accept();
  this.sessions.set(ws, { username, role, viewingDocId: null, isPreview, ...(anon ? { anonId: anon.anonId, anonName: anon.anonName } : {}) });
  // … existing per-doc step1 / awareness loop …
  ws.send(this.encodeWorkspaceMeta());

  if (anon) {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MESSAGE_ANON_IDENTITY);
    encoding.writeVarString(enc, anon.anonId);
    encoding.writeVarString(enc, anon.anonName);
    encoding.writeVarString(enc, anon.token);
    ws.send(encoding.toUint8Array(enc));
  }

  ws.addEventListener("message", /* … unchanged … */);
  // … unchanged …
}
```

(Place the `if (anon)` block immediately after the existing `ws.send(this.encodeWorkspaceMeta())`.)

- [ ] **Step 6: Run — verify the tests pass**

Run: `npx vitest run tests/src/workspace-room.test.ts -t "anon identity"` → PASS.
Run: `npx vitest run tests/src/workspace-room.test.ts` → all pass (no regression in the existing upgrade / session tests).

- [ ] **Step 7: Typecheck + commit**

```bash
git add src/workspace-room.ts tests/src/workspace-room.test.ts
git commit -m "feat: mint a stable identity for anonymous WS sessions

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 4: Server — `identityOf` through the integrity observers

**Files:**
- Modify: `src/workspace-room.ts` (`reconcileReviewerDelta` call ~257; suggestions observer `actor` ~296; comments observer `actor` ~400; `captureReviewerPreState` call ~962)
- Modify: `src/comment-integrity.ts` (`isValidNewThread`)
- Test: `tests/src/workspace-room.test.ts`, `tests/src/comment-integrity.test.ts`, `tests/src/reviewer-integrity.test.ts`

**Interfaces:**
- Consumes: `identityOf` (Task 3).
- Produces: no new exports. `isValidNewThread(entry, actor)` — param renamed, `!username` early-return removed (an anon session now has a real `anonId`).

- [ ] **Step 1: Write the failing tests**

`tests/src/comment-integrity.test.ts` — add:
```ts
it("accepts a new thread authored by an anon: id actor", () => {
  const entry = makeThread({ author: "anon:abc123" }); // reuse the file's builder; author + first reply author both "anon:abc123"
  expect(isValidNewThread(entry, "anon:abc123")).toBe(true);
});
it("rejects a new thread whose author is a different anon id", () => {
  const entry = makeThread({ author: "anon:abc123" });
  expect(isValidNewThread(entry, "anon:zzz999")).toBe(false);
});
```
> If the file has no `makeThread` builder, construct the entry inline matching `isValidNewThread`'s requirements (author + `replies[0].author` equal to the actor, `resolved: false`, one reply, plausible `from`/`to`).

`tests/src/reviewer-integrity.test.ts` — add:
```ts
it("accepts a new suggestion authored by an anon: id actor", () => {
  const e = { kind: "insert", author: "anon:abc123", createdAt: 1, from: relpos(), to: relpos() };
  expect(isValidNewSuggestionEntry(e as any, "anon:abc123")).toBe(true);
  expect(isValidNewSuggestionEntry(e as any, "anon:other0")).toBe(false);
});
```
> Use the file's existing rel-pos fixture for `from`/`to`.

`tests/src/workspace-room.test.ts` — add to a `describe("WorkspaceRoom anon authorship")` (these drive a real room + a fake anon session; model them on the existing reviewer-integrity tests in that file, but set the session with `{ username: null, anonId: "anon:abc123", anonName: "Bold Wren", role: "reviewer", viewingDocId: null }`):

```ts
it("keeps an anon reviewer's suggestion authored with their anonId", async () => {
  const room = new WorkspaceRoom(fakeState(), fakeEnv);
  const ws = { send: () => {} } as unknown as WebSocket;
  (room as any).sessions.set(ws, { username: null, anonId: "anon:abc123", anonName: "Bold Wren", role: "reviewer", viewingDocId: null });
  const docRoom = await room.loadDocRoom("doc1");
  docRoom.doc.getText("content").insert(0, "hello world");
  // client-authored entry: author = the anonId
  await applyFrom(room, ws, docRoom, (c) => recordInsertSuggestion(c, 0, 5, "anon:abc123", 1));
  const list = listResolvedSuggestions(docRoom.doc);
  expect(list).toHaveLength(1);
  expect(list[0]!.author).toBe("anon:abc123");
});

it("lets an anon reviewer withdraw (reject) their own pending insert", async () => {
  const room = new WorkspaceRoom(fakeState(), fakeEnv);
  const ws = { send: () => {} } as unknown as WebSocket;
  (room as any).sessions.set(ws, { username: null, anonId: "anon:abc123", anonName: "Bold Wren", role: "reviewer", viewingDocId: null });
  const docRoom = await room.loadDocRoom("doc1");
  docRoom.doc.getText("content").insert(0, "hello world");
  await applyFrom(room, ws, docRoom, (c) => { c.getText("content").insert(5, " dear"); recordInsertSuggestion(c, 5, 10, "anon:abc123", 1); });
  // now the anon rejects it — deletes the inserted text + the entry
  await applyFrom(room, ws, docRoom, (c) => {
    const sid = listResolvedSuggestions(c)[0]!.id;
    const s = getSuggestionsMap(c).get(sid)!;
    // resolveSuggestion(reject) semantics for an insert: delete text + entry
    c.getText("content").delete(5, 5);
    getSuggestionsMap(c).delete(sid);
  });
  expect(docRoom.doc.getText("content").toString()).toBe("hello world");
  expect(listResolvedSuggestions(docRoom.doc)).toHaveLength(0);
});

it("does not let a different anon withdraw the first anon's suggestion", async () => {
  const room = new WorkspaceRoom(fakeState(), fakeEnv);
  const wsA = { send: () => {} } as unknown as WebSocket;
  const wsB = { send: () => {} } as unknown as WebSocket;
  (room as any).sessions.set(wsA, { username: null, anonId: "anon:aaa", anonName: "A", role: "reviewer", viewingDocId: null });
  (room as any).sessions.set(wsB, { username: null, anonId: "anon:bbb", anonName: "B", role: "reviewer", viewingDocId: null });
  const docRoom = await room.loadDocRoom("doc1");
  docRoom.doc.getText("content").insert(0, "the quick brown fox");
  await applyFrom(room, wsA, docRoom, (c) => { c.getText("content").insert(9, "X"); recordInsertSuggestion(c, 9, 10, "anon:aaa", 1); });
  // B tries to delete A's inserted char — reviewer raw-delete of non-own text → reverted (MDE-05)
  await applyFrom(room, wsB, docRoom, (c) => c.getText("content").delete(9, 1));
  expect(docRoom.doc.getText("content").includes("X")).toBe(true);
});
```

> `applyFrom` is the existing helper in the comments describe block — if it's scoped, hoist it or copy its 5 lines. Adjust the exact "reject" mutation to match `resolveSuggestion`'s real behaviour once you read it.

- [ ] **Step 2: Run — verify they fail**

Run: `npx vitest run tests/src/comment-integrity.test.ts tests/src/reviewer-integrity.test.ts tests/src/workspace-room.test.ts -t "anon"`
Expected: FAIL — `isValidNewThread` rejects a null-username-shaped `actor` path only if actor is falsy (it's not here — `"anon:abc123"` is truthy — so the integrity unit tests may actually PASS already); the **workspace-room** tests FAIL because the observers use `session.username ?? "Anonymous"` = `"Anonymous"` ≠ `"anon:abc123"` → the anon suggestion is reverted.

- [ ] **Step 3: Swap the 4 call sites to `identityOf`**

In `src/workspace-room.ts`:
- ~line 257: `reconcileReviewerDelta(doc, event.changes.delta, identityOf(session) ?? "Anonymous");`
- ~line 296: `const actor = identityOf(session);` then immediately `if (!actor) return;` (defensive — a live non-viewer session always has one).
- ~line 400: `const actor = identityOf(session);` then `if (!actor) return;`
- ~line 962: `const reviewerPre = session?.role === "reviewer" ? this.captureReviewerPreState(docRoom.doc, identityOf(session) ?? "Anonymous") : null;`

- [ ] **Step 4: `comment-integrity.ts` — rename param, drop `!username`**

```ts
export function isValidNewThread(entry: CommentThreadEntry | undefined, actor: string): boolean {
  if (!entry) return false;
  const first = entry.replies?.[0];
  return (
    entry.author === actor &&
    // …rest unchanged, `username` → `actor` throughout…
  );
}
```
Also rename `username` → `actor` in `isAllowedThreadTransition`'s signature and body (the `!!username && …` reply-append guard becomes `!!actor && …`).

- [ ] **Step 5: Run — verify pass**

Run: `npx vitest run tests/src/comment-integrity.test.ts tests/src/reviewer-integrity.test.ts tests/src/workspace-room.test.ts` → all pass.

- [ ] **Step 6: Typecheck + commit**

```bash
git add src/workspace-room.ts src/comment-integrity.ts tests/src/
git commit -m "feat: integrity observers key ownership on identityOf (anon ids)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 5: Server + shared types — `authorName` field and stamping

**Files:**
- Modify: `src/suggestions.ts` AND `client/src/suggestions.ts` (identical)
- Modify: `src/comments-doc.ts` AND `client/src/comments-doc.ts` (byte-identical)
- Modify: `src/workspace-room.ts` (both observers — stamp `authorName`)
- Test: `tests/src/workspace-room.test.ts`, `tests/src/comments-doc-parity.test.ts` (must still pass)

**Interfaces:**
- Produces:
  - `SuggestionEntry.authorName?: string`, `ResolvedSuggestion.authorName?: string`
  - `Reply.authorName?: string`, `CommentThreadEntry.authorName?: string`, `ResolvedCommentThread.authorName?: string`
  - Both observers: on a *valid* add/update whose `author` starts with `"anon:"`, rewrite `authorName` to `session.anonName` in the observer's own reconcile-origin transaction.

- [ ] **Step 1: Write the failing tests**

`tests/src/workspace-room.test.ts` — extend the Task 4 "keeps an anon reviewer's suggestion" test (or add a sibling):
```ts
it("stamps authorName onto an anon-authored suggestion from the session", async () => {
  const room = new WorkspaceRoom(fakeState(), fakeEnv);
  const ws = { send: () => {} } as unknown as WebSocket;
  (room as any).sessions.set(ws, { username: null, anonId: "anon:abc123", anonName: "Bold Wren", role: "reviewer", viewingDocId: null });
  const docRoom = await room.loadDocRoom("doc1");
  docRoom.doc.getText("content").insert(0, "hello world");
  await applyFrom(room, ws, docRoom, (c) => recordInsertSuggestion(c, 0, 5, "anon:abc123", 1));
  const sid = listResolvedSuggestions(docRoom.doc)[0]!.id;
  expect(getSuggestionsMap(docRoom.doc).get(sid)!.authorName).toBe("Bold Wren");
});

it("stamps authorName onto an anon-authored comment thread", async () => {
  const room = new WorkspaceRoom(fakeState(), fakeEnv);
  const ws = { send: () => {} } as unknown as WebSocket;
  (room as any).sessions.set(ws, { username: null, anonId: "anon:abc123", anonName: "Bold Wren", role: "editor", viewingDocId: null });
  const docRoom = await room.loadDocRoom("doc1");
  docRoom.doc.getText("content").insert(0, "hello world");
  await applyFrom(room, ws, docRoom, (c) => createCommentThread(c, 0, 5, "hello", "anon:abc123", "hi", 1));
  const tid = listResolvedCommentThreads(docRoom.doc)[0]!.id;
  expect(getCommentsMap(docRoom.doc).get(tid)!.authorName).toBe("Bold Wren");
});

it("does not stamp authorName onto a signed-in user's entry", async () => {
  const room = new WorkspaceRoom(fakeState(), fakeEnv);
  const ws = { send: () => {} } as unknown as WebSocket;
  (room as any).sessions.set(ws, { username: "alice", role: "editor", viewingDocId: null });
  const docRoom = await room.loadDocRoom("doc1");
  docRoom.doc.getText("content").insert(0, "hello world");
  await applyFrom(room, ws, docRoom, (c) => createCommentThread(c, 0, 5, "hello", "alice", "hi", 1));
  const tid = listResolvedCommentThreads(docRoom.doc)[0]!.id;
  expect(getCommentsMap(docRoom.doc).get(tid)!.authorName).toBeUndefined();
});
```

- [ ] **Step 2: Run — verify they fail**

Run: `npx vitest run tests/src/workspace-room.test.ts -t "authorName"` → FAIL (`authorName` is `undefined`).

- [ ] **Step 3: Add `authorName?` to the type files**

`src/suggestions.ts` AND `client/src/suggestions.ts` — in `interface SuggestionEntry`, after `replies?`:
```ts
  // Display label for an anon:<id> author, stamped authoritatively by the
  // server's suggestions observer from the session's assigned guest name.
  // Absent for a signed-in author (their `author` is already their name).
  authorName?: string;
```
In `interface ResolvedSuggestion` — it's `extends Omit<SuggestionEntry, "from" | "to">`, so `authorName` is inherited. Nothing to add. In `listResolvedSuggestions`, the pushed object — `authorName` is not spread; add it:
```ts
result.push({ id, kind: entry.kind, author: entry.author, authorName: entry.authorName, createdAt: entry.createdAt, from, to, replies: entry.replies });
```
In `recordInsertSuggestion`, preserve it on a contiguous-extend (like `replies`):
```ts
const authorName = existing?.authorName;
// …
map.set(id, { kind: "insert", author, createdAt, from: fromJson, to: toRelative(ytext, to, -1), ...(replies ? { replies } : {}), ...(authorName ? { authorName } : {}) });
```

`src/comments-doc.ts` AND `client/src/comments-doc.ts` (keep byte-identical) — add `authorName?: string` to `Reply`, `CommentThreadEntry`, and `ResolvedCommentThread`. In `listResolvedCommentThreads`, add `authorName: entry.authorName` to the pushed object.

**Run `diff client/src/comments-doc.ts src/comments-doc.ts` — must be empty.** Same for `suggestions.ts`.

- [ ] **Step 4: Stamp in the two observers**

`src/workspace-room.ts` suggestions observer — after the `replyReverts` handling for a valid `add`/`update`, add a stamping pass. Inside the `if (session && session.role !== "viewer")` block, after the existing `event.changes.keys.forEach(...)` and its `if (replyReverts.length) …`:
```ts
if (actor.startsWith("anon:") && session.anonName) {
  const stamps: Array<() => void> = [];
  event.changes.keys.forEach((change, key) => {
    if (change.action === "delete") return;
    const cur = suggestionsMap.get(key);
    if (cur && cur.author === actor && cur.authorName !== session!.anonName) {
      stamps.push(() => suggestionsMap.set(key, { ...suggestionsMap.get(key)!, authorName: session!.anonName }));
    }
  });
  if (stamps.length) doc.transact(() => stamps.forEach((s) => s()), "suggestion");
}
```
Comments observer — analogous, after the `reverts` handling, `origin` `"comment-reconcile"`:
```ts
if (actor.startsWith("anon:") && session.anonName) {
  const stamps: Array<() => void> = [];
  event.changes.keys.forEach((change, key) => {
    if (change.action === "delete") return;
    const cur = commentsMap.get(key);
    if (cur && cur.author === actor && cur.authorName !== session!.anonName) {
      stamps.push(() => commentsMap.set(key, { ...commentsMap.get(key)!, authorName: session!.anonName }));
    }
  });
  if (stamps.length) doc.transact(() => stamps.forEach((s) => s()), "comment-reconcile");
}
```
> Note: `coreEqual` / `isAllowedThreadTransition` ignore `authorName`, so a later resolve-toggle where the client dropped `authorName` still passes and gets re-stamped here. The `structuralChanged` check in the suggestions observer likewise ignores it.

- [ ] **Step 5: Run — verify pass**

Run: `npx vitest run tests/src/workspace-room.test.ts tests/src/comments-doc-parity.test.ts` → all pass.

- [ ] **Step 6: Typecheck + commit**

```bash
git add src/suggestions.ts client/src/suggestions.ts src/comments-doc.ts client/src/comments-doc.ts src/workspace-room.ts tests/src/
git commit -m "feat: server stamps authorName onto anon-authored suggestions/comments

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 6: Server — version-history records anon editors

**Files:**
- Modify: `src/workspace-room.ts` (`handleDocUpdate` ~1191 and ~1205)
- Test: `tests/src/workspace-room.test.ts`

**Interfaces:** none new. `docRoom.pendingAuthors` (a `Set<string>`) now receives `session.username ?? session.anonName` instead of only `session.username`.

- [ ] **Step 1: Write the failing test**

```ts
it("records an anon editor's guest name in a version snapshot", async () => {
  const room = new WorkspaceRoom(fakeState(), fakeEnv);
  const ws = { send: () => {} } as unknown as WebSocket;
  (room as any).sessions.set(ws, { username: null, anonId: "anon:abc123", anonName: "Bold Wren", role: "editor", viewingDocId: null });
  const docRoom = await room.loadDocRoom("doc1");
  await applyFrom(room, ws, docRoom, (c) => c.getText("content").insert(0, "hello from a guest"));
  const snap = (await room.forceSnapshot("doc1", docRoom, "hello from a guest", Date.now()))!;
  expect(snap.authors).toContain("Bold Wren");
});
```
> `forceSnapshot` flushes `pendingAuthors`; check the existing tests for the exact call shape.

- [ ] **Step 2: Run — verify it fails**

Run: `npx vitest run tests/src/workspace-room.test.ts -t "guest name in a version snapshot"` → FAIL (anon edit not recorded — `if (editor?.username)` is false).

- [ ] **Step 3: Change both `pendingAuthors.add` sites**

`src/workspace-room.ts` ~1191 and ~1205 — replace:
```ts
if (editor?.username) docRoom.pendingAuthors.add(editor.username);
```
with:
```ts
const editorName = editor?.username ?? editor?.anonName;
if (editorName) docRoom.pendingAuthors.add(editorName);
```

- [ ] **Step 4: Run — verify pass**

Run: `npx vitest run tests/src/workspace-room.test.ts` → all pass.

- [ ] **Step 5: Typecheck + commit**

```bash
git add src/workspace-room.ts tests/src/workspace-room.test.ts
git commit -m "feat: version history records anonymous editors by guest name

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 7: Client — `collabIdentity` store + `collab.ts` wiring

**Files:**
- Create: `client/src/stores/collabIdentity.ts`
- Modify: `client/src/collab.ts` (message consts ~86; `connectWorkspace` URL ~1274; `handleServerMessage` ~1330; `applyEditorMode` ~1021/1134; `getGuestIdentity` + word lists ~1478-1497; wherever `githubUsername` is resolved)
- Test: `tests/client/src/stores/collabIdentity.test.ts` (new, small)

**Interfaces:**
- Produces:
  - `collabIdentity: Writable<{ id: string; name: string }>` — `{ id: "", name: "" }` until known; seeded synchronously on import from `localStorage["mde_anon_identity"]` when it parses.
  - `client/src/collab.ts` handles `MESSAGE_ANON_IDENTITY` (const `8`): `localStorage["mde_anon_token"] = token`, `localStorage["mde_anon_identity"] = JSON.stringify({ id, name })`, `collabIdentity.set({ id, name })`.

- [ ] **Step 1: Write the store + its test**

Create `client/src/stores/collabIdentity.ts`:
```ts
import { writable } from "svelte/store";

// The current user's collaboration identity: a GitHub username, or a
// server-assigned "anon:<id>". `name` is the display label (the username,
// or the assigned "Adjective Animal"). Empty until resolved:
// - signed in -> set from window.MDE.githubUsername in collab.ts
// - anonymous -> set from the MESSAGE_ANON_IDENTITY frame
// A returning anonymous visitor is seeded synchronously below so their
// cards/cursor don't flash an empty identity before the frame lands.
export const collabIdentity = writable<{ id: string; name: string }>(readSeed());

function readSeed(): { id: string; name: string } {
  try {
    const raw = localStorage.getItem("mde_anon_identity");
    if (raw) {
      const p = JSON.parse(raw) as { id?: unknown; name?: unknown };
      if (typeof p.id === "string" && typeof p.name === "string" && p.id.startsWith("anon:")) return { id: p.id, name: p.name };
    }
  } catch {
    /* private mode / blocked / malformed */
  }
  return { id: "", name: "" };
}
```

Create `tests/client/src/stores/collabIdentity.test.ts`:
```ts
import { test, expect } from "vitest";
import { get } from "svelte/store";

test("collabIdentity defaults to empty when no seed", async () => {
  localStorage.removeItem("mde_anon_identity");
  const { collabIdentity } = await import("../../../../client/src/stores/collabIdentity");
  expect(get(collabIdentity)).toEqual({ id: "", name: "" });
});
```
> `unit` project — this file needs `// @vitest-environment jsdom` at the top for `localStorage`.

- [ ] **Step 2: Run — verify the store test passes** (`npx vitest run tests/client/src/stores/collabIdentity.test.ts`), then wire `collab.ts`.

- [ ] **Step 3: `collab.ts` — message const + handler**

Near the other `MESSAGE_*` (~line 91):
```ts
const MESSAGE_ANON_IDENTITY = 8;
```
In `handleServerMessage`, alongside the other `if (messageType === …)` blocks:
```ts
if (messageType === MESSAGE_ANON_IDENTITY) {
  const id = decoding.readVarString(decoder);
  const name = decoding.readVarString(decoder);
  const token = decoding.readVarString(decoder);
  try {
    localStorage.setItem("mde_anon_token", token);
    localStorage.setItem("mde_anon_identity", JSON.stringify({ id, name }));
  } catch {
    /* blocked — fine, we just re-mint next connect */
  }
  collabIdentity.set({ id, name });
  return;
}
```
Import: `import { collabIdentity } from "./stores/collabIdentity";`

- [ ] **Step 4: `collab.ts` — `?anon=` on the WS URL**

In `connectWorkspace` (~1274), replace the `url` line:
```ts
const params = new URLSearchParams();
if (workspaceRoom.joinTicket) params.set("ticket", workspaceRoom.joinTicket);
let anonToken = "";
try { anonToken = localStorage.getItem("mde_anon_token") ?? ""; } catch { /* blocked */ }
if (!window.MDE.githubUsername && anonToken) params.set("anon", anonToken);
const qs = params.toString();
const url = qs ? `${base}?${qs}` : base;
```

- [ ] **Step 5: `collab.ts` — identity for authoring + presence**

Delete `GUEST_ADJECTIVES`, `GUEST_ANIMALS`, `guestIdentity`, `getGuestIdentity` (~1478-1497) and the leading comment.

At both sites that compute `identity` (~1026, ~1134):
```ts
const me = get(collabIdentity);
const identity = window.MDE.githubUsername
  ? { name: window.MDE.githubUsername, color: colorForUsername(window.MDE.githubUsername) }
  : { name: me.name || "Guest", color: colorForUsername(me.id || "guest") };
```
And pass `identity.id`-equivalent as the suggestion author — the `suggestionExtensions` call becomes:
```ts
const authorId = window.MDE.githubUsername ?? me.id;
extensions.push(...suggestionExtensions(binding.ydoc, authorId, { viewerRole, viewerName: identity.name }));
```

- [ ] **Step 6: `collab.ts` — set `collabIdentity` for a signed-in user + rebuild on change**

Wherever `window.MDE.githubUsername` becomes known (search for where it's assigned — likely a `checkSession` result handler or `gist.ts`; if it's set in `gist.ts`, add the store write there instead, importing `collabIdentity`):
```ts
if (window.MDE.githubUsername) collabIdentity.set({ id: window.MDE.githubUsername, name: window.MDE.githubUsername });
```
In `connectWorkspace` / wherever the per-binding editor extensions are (re)configured, subscribe so a late `MESSAGE_ANON_IDENTITY` (first-ever visit) reconfigures the editing compartment:
```ts
let lastIdentityId = get(collabIdentity).id;
const unsubIdentity = collabIdentity.subscribe((v) => {
  if (v.id !== lastIdentityId) {
    lastIdentityId = v.id;
    for (const binding of workspaceRoom.docs.values()) applyEditorMode(binding, currentMode(binding));
  }
});
```
> Find the existing teardown path (`ws.onclose` / a `disconnect` fn) and call `unsubIdentity()` there. `currentMode`/`applyEditorMode` — match the names already in the file (the mode is tracked per binding or in a store; use whatever `applyEditorMode` is already called with elsewhere).

- [ ] **Step 7: Run the client suite**

Run: `npm test` — the `unit` project. Then `npx vitest run --project=components`.
Expected: green. `collab.ts` has limited direct unit coverage (its `init()` never runs under jsdom); rely on `tests/client/src/collab.test.ts` still passing and the component tests in Task 8.

- [ ] **Step 8: Typecheck + commit**

Run: `npm run typecheck` (svelte-check will catch a bad store import / type).

```bash
git add client/src/stores/collabIdentity.ts client/src/collab.ts tests/client/src/stores/collabIdentity.test.ts
git commit -m "feat: client collabIdentity store; anon identity from the server frame

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 8: Client — rail & card use the identity; the withdraw bug is fixed

**Files:**
- Modify: `client/src/components/AnnotationRail.svelte` (`viewer` ~338; `viewerName()` ~173; authoring calls ~180-182, ~226)
- Modify: `client/src/annotations.ts` (`RailAnnotation`; `suggestionCards`; `commentCard`; new `displayName`)
- Modify: `client/src/components/AnnotationCard.svelte` (header display; avatar)
- Test: `tests/client/src/components/AnnotationCard.test.ts`, `tests/client/src/annotations.test.ts`

**Interfaces:**
- Consumes: `collabIdentity` (Task 7); `SuggestionEntry.authorName` / `ResolvedCommentThread.authorName` (Task 5).
- Produces:
  - `RailAnnotation.authorName?: string`
  - `displayName(author: string, authorName?: string): string` exported from `annotations.ts` → `authorName || author`
  - `viewer` prop unchanged shape `{ role; name }` — `name` now holds the identity id (`$collabIdentity.id`).

- [ ] **Step 1: Write the failing tests**

`tests/client/src/annotations.test.ts` (add, or create mirroring existing style):
```ts
import { displayName, railAnnotationsForShared } from "../../../client/src/annotations";

test("displayName prefers authorName", () => {
  expect(displayName("anon:abc", "Swift Otter")).toBe("Swift Otter");
  expect(displayName("alice", undefined)).toBe("alice");
});

test("railAnnotationsForShared carries authorName from a suggestion", () => {
  const sug = [{ id: "s1", kind: "insert", author: "anon:abc", authorName: "Swift Otter", createdAt: 1, from: 0, to: 3, replies: undefined }] as any;
  const [card] = railAnnotationsForShared(sug, [], "abcdef");
  expect(card!.authorName).toBe("Swift Otter");
});
```

`tests/client/src/components/AnnotationCard.test.ts` — add (this is the **original bug** regression):
```ts
test("an anon reviewer sees Withdraw on their own suggestion", async () => {
  const own: RailAnnotation = { id: "s9", kind: "suggestion", author: "anon:abc123", authorName: "Swift Otter", createdAt: 0, anchorFrom: 0, anchorTo: 3, changeKind: "insert", changeText: "cat" };
  const screen = await render(AnnotationCard, { annotation: own, viewer: { role: "reviewer", name: "anon:abc123" } });
  await expect.element(screen.getByRole("button", { name: /withdraw/i })).toBeInTheDocument();
});

test("a suggestion by an anon: author shows its guest name, not the raw id", async () => {
  const a: RailAnnotation = { id: "s10", kind: "suggestion", author: "anon:abc123", authorName: "Swift Otter", createdAt: 0, anchorFrom: 0, anchorTo: 3, changeKind: "insert", changeText: "cat" };
  const screen = await render(AnnotationCard, { annotation: a, viewer: { role: "editor", name: "carol" } });
  await expect.element(screen.getByText(/Swift Otter/)).toBeInTheDocument();
  expect(screen.container.querySelector("img.annotation-card-avatar")).toBeNull(); // generic icon, no github img
});
```

- [ ] **Step 2: Run — verify they fail**

Run: `npx vitest run --project=components tests/client/src/components/AnnotationCard.test.ts` and `npx vitest run tests/client/src/annotations.test.ts`
Expected: FAIL — `displayName` not exported; card compares `author` to `viewer.name` (`"anon:abc123" === "anon:abc123"` actually PASSES for withdraw once we pass `name: "anon:abc123"`… so the withdraw test may pass already — the real fix is in the RAIL wiring, Step 4/5, not the card). The **guest-name display** test fails (card renders `annotation.author` = `"anon:abc123"`), and the **avatar** test fails (an `<img>` is rendered).

> If the withdraw card-test passes at this step, keep it — it locks the card contract. The rail wiring (Steps 4-5) is what actually feeds the right `viewer.name` in the running app.

- [ ] **Step 3: `annotations.ts` — `authorName` + `displayName`**

- Add `authorName?: string;` to `interface RailAnnotation` (in the `// suggestion` / `// comment` shared area — it applies to both).
- Export:
```ts
export function displayName(author: string, authorName?: string): string {
  return authorName || author;
}
```
- In `suggestionCards`, the non-grouped `out.push({...})` — add `authorName: s.authorName`. For the grouped replace-pair push — add `authorName: (s.kind === "delete" ? s : next!).authorName ?? s.authorName` (both halves share an author; take whichever has the label).
- In `commentCard` — add `authorName: thread.authorName`.

- [ ] **Step 4: `AnnotationCard.svelte` — display + avatar**

- Import `displayName` and add: `const isAnon = $derived(annotation.author.startsWith("anon:"));`
- `isOwn` unchanged (`annotation.author === viewer.name`).
- Header author span: replace `{annotation.author || "Someone"}` with `{displayName(annotation.author, annotation.authorName) || "Someone"}`.
- Avatar block: wrap the existing `<img class="annotation-card-avatar">` in `{#if avatarUrl && !isAnon}` … `{:else if isAnon}<span class="annotation-card-avatar annotation-card-avatar-anon"><svg class="icon"><use href="#icon-user"></use></svg></span>{/if}`.
- `avatarUrl` derived: guard it — `annotation.author && !annotation.author.startsWith("anon:") ? \`https://github.com/…\` : ""`.

- [ ] **Step 5: `AnnotationRail.svelte` — feed the identity**

- Import `collabIdentity`.
- Line ~338: `const viewer = $derived({ role: $collabRole, name: $collabIdentity.id });`
- Line ~173: delete `viewerName`; replace its 3 call sites (`addSuggestionReply`, `addCommentReply`, `createCommentThread`) with `$collabIdentity.id`. (For a local-doc note path that also used `viewerName()`, keep `""` there — local notes carry no author; check the exact call.)

- [ ] **Step 6: Run — verify pass**

Run: `npx vitest run tests/client/src/annotations.test.ts` and `npx vitest run --project=components tests/client/src/components/AnnotationCard.test.ts tests/client/src/components/AnnotationRail.test.ts`
Expected: PASS. Fix any existing `AnnotationRail.test.ts` breakage from the `viewer`/`viewerName` change (it may stub `window.MDE.githubUsername`; it now needs `collabIdentity` seeded — `import { collabIdentity } from "..."; collabIdentity.set({ id: "alice", name: "alice" })` in the test setup).

- [ ] **Step 7: Full client verification + commit**

Run: `npm test`, `npx vitest run --project=components`, `npm run typecheck` → all green.

```bash
git add client/src/annotations.ts client/src/components/AnnotationCard.svelte client/src/components/AnnotationRail.svelte tests/client/src/
git commit -m "fix: anon reviewer can withdraw their own suggestion; guest names in the rail

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 9: Docs, screenshot, version bump, PR

**Files:**
- Modify: `CHANGELOG.md`, `ROADMAP.md`, `docs/TEST-COVERAGE.md`, `client/src/whats-new-entries.ts`
- Create: `client/public/whats-new/anon-identity.png`
- Modify (last): `package.json`, `package-lock.json`

- [ ] **Step 1: Full verification on the finished branch**

```bash
npm test
npx vitest run --project=components
npm run typecheck
npm run build
npm run format:check
npm run check:no-dev-login
```
All green before proceeding. Fix formatting with `npm run format` if needed.

- [ ] **Step 2: Capture the What's New screenshot**

The `whats-new` asset is not deferrable (broken-image icon for every real user otherwise). Capture a real one:
1. `npm run build`
2. Start the client dev server or a static serve of `client/dist`.
3. A short Playwright script (put it in `tests/scripts/manual-testing/` or run ad hoc, do not commit it): open the app, create a doc, mock two annotation cards with `authorName` "Swift Otter" and "Bold Wren" in the rail (or drive a real two-session collab flow), screenshot the rail region, save as `client/public/whats-new/anon-identity.png`.
4. Verify the file exists and is a real PNG (`file client/public/whats-new/anon-identity.png`).

- [ ] **Step 3: What's New entry**

Append to `WHATS_NEW_ENTRIES` in `client/src/whats-new-entries.ts` (oldest-first — this goes last), matching the shape of the existing final entry, `version` = the new version from Step 6:
```ts
{
  version: "1.63.0",
  date: "2026-09-11",
  category: "Collaboration",
  title: "Guests have names now",
  body: "Anonymous collaborators on a shared link each get their own name (like “Swift Otter”) instead of all showing as “Anonymous”. Their suggestions and comments are attributed to them, and a guest can withdraw their own suggestion.",
  screenshot: "/whats-new/anon-identity.png",
},
```
> Match the exact key names / union types the file already uses (`category` values, etc.).

- [ ] **Step 4: CHANGELOG**

Top of `CHANGELOG.md`:
```markdown
## [1.63.0] - 2026-09-11

### Added

- Anonymous collaborators on a shared link each get a stable, distinct identity and a guest name (e.g. “Swift Otter”). Their suggestions, comments, edits in version history, and presence cursor are all attributed to that one guest instead of a shared “Anonymous”.

### Fixed

- An anonymous reviewer can now withdraw their own pending suggestion — the Withdraw button was never appearing for them.
```

- [ ] **Step 5: ROADMAP + TEST-COVERAGE**

`ROADMAP.md` — under *Google Docs parity → "Friendly identities for anonymous link viewers"*, change `- [ ]` to `- [x]` with a "shipped v1.63.0" note and the spec path. Add a line to the Group D "Security follow-ups" paragraph noting the anon-withdraw bug fixed.

`docs/TEST-COVERAGE.md` — add SEC rows for: anon token sign/verify; anon session minting + `MESSAGE_ANON_IDENTITY`; anon-authored suggestion/comment kept + `authorName`-stamped; anon withdraw-own applies; second anon can't; and a COLLAB row for version-history anon authors. Bump the §10 and Total counts to match (hand-maintained tallies — follow the surrounding convention, +1 per new scenario).

- [ ] **Step 6: Version bump (last)**

`1.62.12` → `1.63.0` in `package.json` and both `package-lock.json` `"version"` fields.
Verify: `grep -n '"version": "1.6' package.json package-lock.json` shows `1.63.0` ×3.

```bash
git add CHANGELOG.md ROADMAP.md docs/TEST-COVERAGE.md client/src/whats-new-entries.ts client/public/whats-new/anon-identity.png package.json package-lock.json
git commit -m "chore: release 1.63.0 — anonymous collaborator identity

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

- [ ] **Step 7: Push + PR**

```bash
git push -u origin feat/anon-collaborator-identity
```
`gh pr create --repo Jerit3787/markdown-editor --base master` — title `feat: stable identity for anonymous collaborators (fixes the anon withdraw bug)`. Body: the bug (three identity strings, all anons collapse to "Anonymous" server-side, Withdraw never renders), the design (server-minted `anon:<id>` + signed 30-day token + `MESSAGE_ANON_IDENTITY` frame + `identityOf()`), scope (suggestions/comments/presence/version-history; signed-in users unchanged), zero migration, spec + plan paths, verification results, minor bump to 1.63.0. End with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

- [ ] **Step 8: CI + merge**

Wait for all checks green. Merge with a real merge commit once the user authorizes:
```bash
gh pr merge <N> --repo Jerit3787/markdown-editor --merge
```

---

## Self-Review

**1. Spec coverage**

| Spec section | Task |
|---|---|
| §1 `Author` convention | Global Constraints + Task 2 (`randomAnonId`) |
| §2 mint / token / `MESSAGE_ANON_IDENTITY` / `identityOf` / `SessionInfo` | Tasks 1, 2, 3 |
| §3 `authorName` schema, integrity `identityOf`, name stamping, `isValidNewThread` drop `!username` | Tasks 4, 5 |
| §4 `collabIdentity` store, `?anon=`, frame handler, delete `getGuestIdentity`, compartment rebuild, signed-in set | Task 7 |
| §4 identity timing (seed / rebuild / sub-second gap) | Task 7 Steps 1, 6 |
| §4 rail `viewer`/authoring, card `displayName`/avatar, `RailAnnotation.authorName` | Task 8 |
| §4 `listResolved*` passthrough | Task 5 Step 3 |
| §4 version history | Task 6 (per the planning deviation: display-name, no schema change) |
| Compatibility (zero migration, legacy `"Anonymous"`, old client) | inherent — no task writes a migration; Task 4/5 tests cover the id path, legacy strings untouched |
| Non-goals | nothing implements them |
| Edge cases table | Task 7 (localStorage blocked, rotated secret, sign in/out, two tabs), Task 3 (preview socket) |
| Testing list | Tasks 1-8 each end with its slice; Task 9 Step 1 runs the full suite |
| Versioning (minor, changelog, whats-new + screenshot) | Task 9 |

No gaps.

**2. Placeholder scan:** No "TODO"/"TBD". Every code step has literal code. The two soft spots are flagged explicitly as implementer judgement against existing helpers: Task 3's `captureAnonUpgrade` ("find the existing upgrade helper first") and Task 7 Step 6 ("match the names already in the file for `applyEditorMode`/`currentMode`"). Both give the fixed assertions / behaviour and only defer the local wiring name. Acceptable — not a "figure out what to do" placeholder.

**3. Type consistency**
- `identityOf(session): string | null` — defined Task 3, used Task 4 (4 sites) + Task 6 (`editor?.anonName` directly, consistent). ✓
- `MESSAGE_ANON_IDENTITY = 8` — server Task 3, client Task 7, test helper Task 3. ✓
- `{ anonId, anonName, token }` frame shape — written in `handleSession` (Task 3), decoded in test (Task 3) and client (Task 7), all three varStrings in the same order. ✓
- `authorName?: string` — added to `SuggestionEntry`/`ResolvedSuggestion`/`Reply`/`CommentThreadEntry`/`ResolvedCommentThread` (Task 5), `RailAnnotation` (Task 8), consumed by `displayName` (Task 8). ✓
- `collabIdentity: Writable<{ id: string; name: string }>` — Task 7 create, Task 8 consume (`$collabIdentity.id`). ✓
- `signAnonToken` / `verifyAnonToken` signatures — Task 1 define, Task 3 consume (`verifyAnonToken(this.env, presented)`, `signAnonToken(this.env, { anonId, anonName })`). ✓
- `randomAnonId()` / `randomGuestName()` — Task 2 define, Task 3 consume. ✓
- `viewer` prop stays `{ role; name }` (deviation 1) — Task 8 keeps existing test call sites valid; new tests pass `name: "anon:abc123"`. ✓

**4. Byte-identical pairs:** Task 5 Step 3 explicitly runs `diff` on both `suggestions.ts` and `comments-doc.ts` pairs; `tests/src/comments-doc-parity.test.ts` is in Task 5's test run. ✓
