# Cloudflare Turnstile on anonymous workspace joins — design

**Status:** approved (brainstorm 2026-09-09)
**Roadmap:** `ROADMAP.md` → "Analytics & legal" → **Next**.
**Ships as:** one user-facing minor release (`1.58.0`).

## Goal

Gate the **anonymous** WebSocket join to an `generalAccess: "anyone"`
shared workspace behind a Cloudflare Turnstile challenge, verified
server-side. A not-signed-in visitor who opens a public share link
solves Turnstile once (in the Join modal); the client exchanges that for
a short-lived signed **join ticket** which the WebSocket upgrade carries.
Signed-in users (session cookie) are never challenged. When the Turnstile
keys aren't configured, the whole mechanism is inert — anonymous joins
work exactly as they do today.

## Why

The only unauthenticated write path into the app is an anonymous
editor-role `"anyone with the link"` workspace: a script can open many
WebSocket connections to a public room, or drive edits into the shared
`Y.Doc`. Turnstile makes that expensive without adding friction for
signed-in collaborators or for the common read-only "preview" case.

## Non-goals / deferred

- **Gating the pre-join HTTP fetches** (`GET /access`, `GET /docs` +
  doc snapshot). Those are read-only and are hit before the user has
  decided to join; challenging there would break "preview without
  saving". Turnstile sits only at the live-sync boundary (the WS
  upgrade).
- **Challenging signed-in users.** A valid session cookie → skip
  entirely, regardless of role.
- **Rate-limiting / IP bans / a WAF rule.** Separate hardening.
- **Turnstile on the legacy `CollabRoom`** (single-doc `/api/collab/*`).
  That path is migration-only; new shares always land on `WorkspaceRoom`.
- **A visible interactive challenge design.** The widget is configured
  non-interactive; the "Just checking you're human…" modal is a thin
  wrapper that auto-closes on success. Styling a full interactive
  challenge flow is out of scope for v1.
- **Persisting the ticket across tabs / reloads beyond the tab session.**
  `sessionStorage`, per workspace. A new tab or a closed-and-reopened
  browser re-challenges.

## Global constraints

- Two `tsconfig.json`s, checked separately. Server code (`src/**`,
  `tests/src/**`) is full strict.
- Turnstile is active **only** when **both** are set:
  - `VITE_TURNSTILE_SITE_KEY` — build-time (Vite `import.meta.env`,
    like `VITE_GA_MEASUREMENT_ID`). Public.
  - `TURNSTILE_SECRET_KEY` — a Worker secret (`.dev.vars` locally,
    `wrangler secret put` in production). Read as
    `this.env.TURNSTILE_SECRET_KEY` in `WorkspaceRoom`.
  Either missing → the client renders no widget and the server skips the
  ticket check. Dev, the `collab` e2e suite, and self-host are untouched
  (they set neither).
- The join-ticket HMAC key is the existing `SESSION_SECRET` (the app's
  signing secret), domain-separated with a `"join-ticket:"` prefix — no
  new secret.
- `npm run format` (Prettier) + `npm run typecheck` must pass.
- User-facing → **minor** bump to `1.58.0`: `package.json` + both
  `package-lock.json` `"version"` fields; `## [1.58.0] - <date>`
  CHANGELOG (`### Added`); one `whats-new-entries.ts` entry with a real
  committed screenshot at `client/public/whats-new/turnstile.png`;
  `docs/TEST-COVERAGE.md` updated.

---

## Part 1 — `src/turnstile.ts` (new, pure)

```ts
const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const TICKET_TTL_MS = 15 * 60 * 1000;

// --- base64url (self-contained; auth.ts's copies are private) ---
function b64urlEncode(bytes: ArrayBuffer): string { … }        // no '=' padding, -/_ alphabet
function b64urlDecode(s: string): Uint8Array { … }

async function hmac(secret: string, message: string): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  return crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/** POST the widget token to Cloudflare. Any failure (network, non-2xx,
 *  success:false) → false. */
export async function verifyTurnstileToken(token: string, remoteIp: string | null, secret: string): Promise<boolean> {
  try {
    const body = new FormData();
    body.set("secret", secret);
    body.set("response", token);
    if (remoteIp) body.set("remoteip", remoteIp);
    const res = await fetch(SITEVERIFY_URL, { method: "POST", body });
    if (!res.ok) return false;
    const data = (await res.json()) as { success?: boolean };
    return data.success === true;
  } catch {
    return false;
  }
}

/** ticket = b64url(JSON payload) + "." + b64url(HMAC of "join-ticket:"+payload) */
export async function mintJoinTicket(workspaceId: string, secret: string, now: number): Promise<string> {
  const payload = JSON.stringify({ w: workspaceId, exp: now + TICKET_TTL_MS });
  const sig = await hmac(secret, `join-ticket:${payload}`);
  return `${b64urlEncode(new TextEncoder().encode(payload).buffer)}.${b64urlEncode(sig)}`;
}

/** Valid iff: well-formed, HMAC matches (timing-safe), w === workspaceId, exp > now. */
export async function verifyJoinTicket(ticket: string | null, workspaceId: string, secret: string, now: number): Promise<boolean> {
  if (!ticket) return false;
  const [payloadPart, sigPart] = ticket.split(".");
  if (!payloadPart || !sigPart) return false;
  let payload: string;
  try {
    payload = new TextDecoder().decode(b64urlDecode(payloadPart));
  } catch {
    return false;
  }
  const expectedSig = new Uint8Array(await hmac(secret, `join-ticket:${payload}`));
  let gotSig: Uint8Array;
  try {
    gotSig = b64urlDecode(sigPart);
  } catch {
    return false;
  }
  if (!timingSafeEqual(expectedSig, gotSig)) return false;
  let parsed: { w?: unknown; exp?: unknown };
  try {
    parsed = JSON.parse(payload);
  } catch {
    return false;
  }
  return parsed.w === workspaceId && typeof parsed.exp === "number" && parsed.exp > now;
}
```

### Tests — `tests/src/turnstile.test.ts`
- `mint` → `verify` round-trips for the same `workspaceId` within TTL.
- Wrong `workspaceId` → false.
- `now` past `exp` → false.
- Flipped one char of the signature / the payload → false.
- Garbage / no-dot / one-part ticket / `null` → false.
- `verifyTurnstileToken`: mock `fetch` → `{success:true}` → true;
  `{success:false}` → false; non-2xx → false; `fetch` throws → false;
  asserts the POST body carries `secret` / `response` / `remoteip`.

---

## Part 2 — `WorkspaceRoom` + `worker.ts`

### `src/env.ts`
Add `TURNSTILE_SECRET_KEY?: string;` to `Env`.

### `src/worker.ts`
A new anchored route mirroring `WORKSPACE_ACCESS_REQUEST_PATH`:

```ts
const WORKSPACE_JOIN_TICKET_PATH = /^\/api\/workspace\/([A-Za-z0-9_-]{1,128})\/join-ticket$/;
// …in fetch(), next to the other workspace sub-path forwards:
const joinTicketMatch = url.pathname.match(WORKSPACE_JOIN_TICKET_PATH);
if (joinTicketMatch) {
  const id = env.WORKSPACE_ROOM.idFromName(joinTicketMatch[1]!);
  return env.WORKSPACE_ROOM.get(id).fetch(request);
}
```

`WorkspaceRoom` needs its own workspace id for ticket scoping — it isn't
stored today (only `this.name`). Parse it from the request URL in both
handlers below. The pattern must match the bare WS-upgrade URL
(`/api/workspace/<id>` — no trailing slash, optional `?ticket=`) **and**
the sub-path URLs (`/api/workspace/<id>/join-ticket`):
```ts
private workspaceIdFromUrl(url: URL): string {
  return url.pathname.match(/^\/api\/workspace\/([A-Za-z0-9_-]{1,128})(?:\/|$)/)?.[1] ?? "";
}
```

### `WorkspaceRoom.fetch` routing
Before the `endsWith("/access")` check:
```ts
if (url.pathname.endsWith("/join-ticket")) return this.handleJoinTicket(request);
```

### `handleJoinTicket(request)`
```ts
async handleJoinTicket(request: Request): Promise<Response> {
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
  const secret = this.env.TURNSTILE_SECRET_KEY;
  if (!secret) return Response.json({ enabled: false });

  const session = await this.getSession(request);
  if (session?.username) return Response.json({ skip: true }); // signed in — no challenge

  let body: { token?: unknown };
  try {
    body = (await request.json()) as { token?: unknown };
  } catch {
    return Response.json({ error: "bad-request" }, { status: 400 });
  }
  if (typeof body.token !== "string" || !body.token) {
    return Response.json({ error: "bad-request" }, { status: 400 });
  }

  const ok = await verifyTurnstileToken(body.token, request.headers.get("CF-Connecting-IP"), secret);
  if (!ok) return Response.json({ error: "turnstile-failed" }, { status: 403 });

  const wsId = this.workspaceIdFromUrl(new URL(request.url));
  const ticket = await mintJoinTicket(wsId, this.env.SESSION_SECRET, Date.now());
  return Response.json({ ticket });
}
```

### `authorize(request)` — the enforcement point
Today it returns `{ ok: true, username, role } | { ok: false, status, message }`.
After `role` is resolved and non-null, add:

```ts
// Anonymous connection to an "anyone with the link" room, and Turnstile
// is configured → require a valid join ticket on the WS upgrade URL.
if (!session?.username && this.env.TURNSTILE_SECRET_KEY && access.generalAccess === "anyone") {
  const url = new URL(request.url);
  const wsId = this.workspaceIdFromUrl(url);
  const ok = await verifyJoinTicket(url.searchParams.get("ticket"), wsId, this.env.SESSION_SECRET, Date.now());
  if (!ok) return { ok: false, status: 401, message: "turnstile-required" };
}
return { ok: true, username: session?.username ?? null, role };
```

`authorize()` is called from the WS-upgrade branch of `fetch()` (and only
there for this purpose — the HTTP endpoints call it too, but they're
either owner-gated or already public; a `requireAccount` link forces a
session so this branch never trips for them, and a `restricted` link
never resolves a role for an anonymous user in the first place).

### Tests — extend `tests/src/workspace-room.test.ts`
Uses the existing `fakeState()` / `fakeEnvWithSecret` / `encryptSession`
helpers; add `TURNSTILE_SECRET_KEY` to the fake env where needed, and
stub `globalThis.fetch` for `verifyTurnstileToken`.

- `POST /join-ticket`, `TURNSTILE_SECRET_KEY` unset → `{ enabled: false }`.
- `POST /join-ticket` with a valid session → `{ skip: true }` (fetch not called).
- `POST /join-ticket` anonymous, `fetch` → `success:true` → `{ ticket }`,
  and that ticket passes `verifyJoinTicket` for this workspace id.
- `POST /join-ticket` anonymous, `fetch` → `success:false` → 403
  `turnstile-failed`.
- `POST /join-ticket` anonymous, no/blank `token` → 400.
- WS upgrade, anonymous, `generalAccess:"anyone"`, `TURNSTILE_SECRET_KEY`
  set, **no** `?ticket` → 401 `turnstile-required`, no session accepted.
- Same, **with** a freshly-minted valid ticket in the query → 101 (upgrade
  succeeds).
- WS upgrade, anonymous, `TURNSTILE_SECRET_KEY` **unset** → 101 without a
  ticket (disabled path).
- WS upgrade, **signed-in**, no ticket → 101 (session bypasses the check).
- WS upgrade, anonymous, `generalAccess:"restricted"` → still 401/403 from
  the existing role check, ticket never consulted.

---

## Part 3 — Client

### `client/src/turnstile.ts` (new)

```ts
const SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined;
export const turnstileEnabled = !!SITE_KEY;

const CACHE_TTL_MS = 14 * 60 * 1000; // < the server's 15 min
const key = (remoteId: string) => `mde:joinTicket:${remoteId}`;

function readCachedTicket(remoteId: string): string | null {
  try {
    const raw = sessionStorage.getItem(key(remoteId));
    if (!raw) return null;
    const { ticket, exp } = JSON.parse(raw) as { ticket: string; exp: number };
    return typeof ticket === "string" && exp > Date.now() + 30_000 ? ticket : null;
  } catch {
    return null;
  }
}

export function clearJoinTicket(remoteId: string): void {
  try {
    sessionStorage.removeItem(key(remoteId));
  } catch {
    /* private mode */
  }
}

// Returns a ticket to append to the WS URL, or null when Turnstile is
// disabled or the server says a signed-in session skips it. Opens the
// "checking you're human" prompt only when a fresh challenge is needed.
export async function getJoinTicket(remoteId: string): Promise<string | null> {
  if (!turnstileEnabled) return null;
  const cached = readCachedTicket(remoteId);
  if (cached) return cached;

  const token = await solveTurnstile(); // renders the widget in TurnstilePrompt, resolves with the token
  const res = await fetch(`/api/workspace/${encodeURIComponent(remoteId)}/join-ticket`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  if (!res.ok) return null; // turnstile-failed / server error — the prompt shows a retry
  const data = (await res.json()) as { ticket?: string; skip?: boolean; enabled?: boolean };
  if (data.enabled === false || data.skip) return null;
  if (typeof data.ticket === "string") {
    try {
      sessionStorage.setItem(key(remoteId), JSON.stringify({ ticket: data.ticket, exp: Date.now() + CACHE_TTL_MS }));
    } catch {
      /* private mode — in-memory return still works for this connection */
    }
    return data.ticket;
  }
  return null;
}
```

`solveTurnstile()` — loads `https://challenges.cloudflare.com/turnstile/v0/api.js`
once (a `<script async defer>` appended to `<head>`), waits for
`window.turnstile`, renders a widget into `TurnstilePrompt`'s container
(`turnstile.render(el, { sitekey: SITE_KEY, callback, "error-callback",
"expired-callback", appearance: "interaction-only" })`), and returns a
promise that resolves with the token or rejects on error/expiry. It also
opens the prompt modal and closes it on resolve; on reject it leaves the
modal open with a "Couldn't verify — Retry" state.

### `client/src/components/TurnstilePrompt.svelte` (new)

- Always mounted (`main.ts`, on a new `<div id="turnstile-prompt-mount">`).
- A `turnstilePromptOpen` store (`stores/turnstile.ts`, `writable(false)`)
  + a `turnstilePromptError` store.
- Renders a small `Modal` ("Just checking you're human…", a
  `<div id="turnstile-widget">` container, and when
  `$turnstilePromptError` a line + a Retry button that re-invokes the
  render). `appearance: "interaction-only"` means the widget is invisible
  unless Cloudflare decides to challenge — so the modal usually flashes
  for <1s.
- No Escape/close affordance while a challenge is pending (the join is
  blocked on it); a "Cancel" that rejects `solveTurnstile` and abandons
  the join is acceptable.

### `client/src/collab.ts` wiring

Two anonymous entry points call `getJoinTicket` before connecting:

1. **`joinSharedLink`** — after `computeMyRole` resolves a role and
   `username` is falsy, `await getJoinTicket(workspaceId)` and stash the
   result on `workspaceRoom` (a new `joinTicket?: string` field) before
   `joinWorkspace(...)`. If `getJoinTicket` throws (user cancelled) →
   `workspaceAccessDenied.set("no-session")` and bail (same as a
   role-less anonymous user today).
2. **`rejoinKnownWorkspace`** — same: anonymous + `turnstileEnabled` →
   `await getJoinTicket(remoteId)` before `joinWorkspace`.

**`connectWorkspace()`** — append the ticket for anonymous connections:
```ts
const base = `${proto}//${location.host}/api/workspace/${encodeURIComponent(workspaceRoom.workspaceId!)}`;
const ws = new WebSocket(workspaceRoom.joinTicket ? `${base}?ticket=${encodeURIComponent(workspaceRoom.joinTicket)}` : base);
```

**Reconnect after a rejected ticket** — `connectWorkspace` tracks an
`everOpened` boolean per connection. In `ws.onclose`, if `!everOpened` &&
`!window.MDE.githubUsername` && `turnstileEnabled` && `workspaceRoom.joinTicket`:
`clearJoinTicket(workspaceRoom.workspaceId!)`, `workspaceRoom.joinTicket
= await getJoinTicket(workspaceRoom.workspaceId!)`, then `scheduleReconnect()`
as normal. (A genuine network drop also lands here occasionally → one
extra invisible Turnstile check; acceptable, non-blocking.)

`teardownWorkspace()` clears `workspaceRoom.joinTicket`.

### Tests — `tests/client/src/turnstile.test.ts` (`@vitest-environment jsdom`)
- `turnstileEnabled` is `false` with no `VITE_TURNSTILE_SITE_KEY` (the
  test default) → `getJoinTicket` returns `null` synchronously, never
  touches `fetch`, never loads the widget script.
- With a cached, unexpired ticket in `sessionStorage` (and
  `turnstileEnabled` forced true via a mock) → `getJoinTicket` returns it
  without calling `fetch` or `solveTurnstile`.
- `clearJoinTicket` removes the entry.
- (The full solve→POST→cache path needs `window.turnstile` +
  `import.meta.env` stubbing; assert the disabled + cached contracts and
  cover the wired flow in the `TurnstilePrompt` component test.)

### Component test — `tests/client/src/components/TurnstilePrompt.test.ts`
- `turnstilePromptOpen` false → renders nothing.
- `.set(true)` → the modal with the `#turnstile-widget` container renders.
- `turnstilePromptError` set → the retry affordance shows.

---

## Part 4 — Config, docs, release

### Config
- `VITE_TURNSTILE_SITE_KEY` — build var. Add to `client/src/vite-env.d.ts`'s
  `ImportMetaEnv`.
- `TURNSTILE_SECRET_KEY` — Worker secret.
- **CONTRIBUTING.md** — extend the "Build-time variables" section: both
  keys, disabled-by-default, `1x…AA` are Cloudflare's always-pass test
  keys for local experimentation.
- **DEPLOYMENT.md** — add `npx wrangler secret put TURNSTILE_SECRET_KEY`
  next to the others, and note `VITE_TURNSTILE_SITE_KEY` goes in the
  Cloudflare build environment.

### `collab` e2e suite
**Unchanged.** `tests/scripts/e2e-collab.sh` builds the client with no
`VITE_TURNSTILE_SITE_KEY` and runs `wrangler dev` with no
`TURNSTILE_SECRET_KEY` in `.dev.vars` → `turnstileEnabled` false,
`authorize()` skips the ticket check, every anonymous
`joinSharedWorkspace` works as before. The spec's implementation plan
must **verify** this by running `npm run test:e2e:collab` green with no
changes to that suite.

### Release
- `package.json` + `package-lock.json` → `1.58.0`.
- `CHANGELOG.md` `## [1.58.0]`, `### Added` — "Shared 'anyone with the
  link' workspaces are now protected from automated abuse with a
  Cloudflare Turnstile check; you'll see a brief 'checking you're human'
  step the first time you open a public link while signed out.
  Signed-in collaborators are never challenged."
- `client/src/whats-new-entries.ts` — a `1.58.0` entry
  (`category: "Collaboration"`), screenshot `/whats-new/turnstile.png`
  (capture the prompt — the capture script builds with
  `VITE_TURNSTILE_SITE_KEY=1x00000000000000000000AA`, the always-pass
  visible test key, so the widget renders for the shot).
- `docs/TEST-COVERAGE.md` — rows for `turnstile.ts` (ticket + siteverify),
  `WorkspaceRoom` `/join-ticket` + `authorize()` gate, the client
  disabled/cached contract, `TurnstilePrompt`.
- `ROADMAP.md` — mark shipped under "Analytics & legal → Next"; copy this
  spec's Non-goals into the deferred list.

## Implementation order (one commit each, TDD)

1. **`src/turnstile.ts`** + `tests/src/turnstile.test.ts` (pure —
   ticket mint/verify, siteverify wrapper with mocked fetch).
2. **`Env` + `worker.ts` route + `WorkspaceRoom.handleJoinTicket`** +
   integration tests for the endpoint.
3. **`WorkspaceRoom.authorize()` gate** + WS-upgrade integration tests
   (with/without ticket, signed-in bypass, disabled bypass, restricted
   untouched).
4. **`client/src/turnstile.ts`** + `stores/turnstile.ts` + unit tests
   (disabled no-op, cached-ticket reuse, `clearJoinTicket`) + the
   `vite-env.d.ts` type.
5. **`TurnstilePrompt.svelte`** + mount + `solveTurnstile` wiring +
   component test.
6. **`collab.ts` wiring** — `getJoinTicket` in `joinSharedLink` /
   `rejoinKnownWorkspace`, `connectWorkspace` ticket param, the
   rejected-ticket reconnect path, `teardownWorkspace` clear. Run
   `npm run test:e2e:collab` — must stay green with no suite changes.
7. **Release** — version, CHANGELOG, What's New + screenshot + capture
   script, CONTRIBUTING, DEPLOYMENT, TEST-COVERAGE, ROADMAP.
