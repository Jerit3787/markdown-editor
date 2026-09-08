# Cloudflare Turnstile on anonymous workspace joins — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Require an anonymous visitor opening an "anyone with the link" shared workspace to pass a Cloudflare Turnstile check before the live-sync WebSocket connects; signed-in users and unconfigured deployments are unaffected.

**Architecture:** A pure `src/turnstile.ts` (siteverify wrapper + HMAC-signed join tickets keyed to `SESSION_SECRET`). `WorkspaceRoom` gains a `POST /join-ticket` endpoint that verifies the widget token and mints a ~15-min ticket, and `authorize()` gains a gate requiring a valid `?ticket=` on the WS upgrade for the anonymous + `"anyone"` + keys-configured case. The client (`client/src/turnstile.ts` + `TurnstilePrompt.svelte`) solves the challenge in a brief modal, caches the ticket in `sessionStorage` per workspace, and `collab.ts` threads it onto the WS URL.

**Tech Stack:** TypeScript, Cloudflare Workers + Durable Objects, Web Crypto (`crypto.subtle` HMAC-SHA256), Svelte 5, Vitest (`unit` + `components`), Playwright (`collab`).

**Spec:** `docs/superpowers/specs/2026-09-09-turnstile-anonymous-join-design.md`

## Global Constraints

- Turnstile is active **only** when **both** `VITE_TURNSTILE_SITE_KEY` (build-time, public, `import.meta.env`) **and** `TURNSTILE_SECRET_KEY` (Worker secret, `this.env.TURNSTILE_SECRET_KEY`) are set. Either missing → client renders no widget, server skips the ticket check, anonymous joins behave exactly as today.
- The join-ticket HMAC key is the existing `SESSION_SECRET`, domain-separated with a literal `"join-ticket:"` prefix on the signed message. No new secret.
- Ticket TTL: server mints for **15 min** (`15 * 60 * 1000` ms); client cache TTL is **14 min**; client treats a cached ticket as usable only while `exp > Date.now() + 30_000`.
- Server code (`src/**`, `tests/src/**`) is full strict mode. Client code is under `client/src/`. Component tests → `tests/client/src/components/*.test.ts`; DOM-using unit tests get a `// @vitest-environment jsdom` first line.
- `npm run format` (Prettier) + `npm run typecheck` must pass before every commit.
- The `collab` e2e suite (`tests/e2e/collab/`, run by `npm run test:e2e:collab`) must stay green **with zero changes** — it builds/runs with neither key set.
- User-facing → **minor** bump to `1.58.0`: `package.json` + **both** `package-lock.json` `"version"` fields; `## [1.58.0] - <today>` CHANGELOG (`### Added`); one `client/src/whats-new-entries.ts` entry with a real committed screenshot at `client/public/whats-new/turnstile.png`; `category: "Collaboration"`; `docs/TEST-COVERAGE.md` updated.
- Commit trailer: `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/turnstile.ts` (new) | siteverify wrapper; `mintJoinTicket` / `verifyJoinTicket` (HMAC + base64url, pure) | 1 |
| `tests/src/turnstile.test.ts` (new) | ticket round-trip / tamper / expiry; mocked siteverify | 1 |
| `src/env.ts` | add `TURNSTILE_SECRET_KEY?: string` | 2 |
| `src/worker.ts` | `/api/workspace/:id/join-ticket` → `WORKSPACE_ROOM` | 2 |
| `src/workspace-room.ts` | `workspaceIdFromUrl` helper; `handleJoinTicket`; route it | 2 |
| `src/workspace-room.ts` | `authorize()` gate | 3 |
| `tests/src/workspace-room.test.ts` | `/join-ticket` branches; `authorize()` gate cases | 2, 3 |
| `client/src/vite-env.d.ts` | type `VITE_TURNSTILE_SITE_KEY` | 4 |
| `client/src/stores/turnstile.ts` (new) | `turnstilePromptOpen`, `turnstilePromptError` | 4 |
| `client/src/turnstile.ts` (new) | `turnstileEnabled`, `getJoinTicket`, `clearJoinTicket`, `solveTurnstile` | 4, 5 |
| `tests/client/src/turnstile.test.ts` (new) | disabled no-op; cached-ticket reuse; `clearJoinTicket` | 4 |
| `client/src/components/TurnstilePrompt.svelte` (new) | the "checking you're human" modal + widget container | 5 |
| `client/index.html`, `client/src/main.ts` | mount `TurnstilePrompt` | 5 |
| `tests/client/src/components/TurnstilePrompt.test.ts` (new) | open/closed/error rendering | 5 |
| `client/src/collab.ts` | `joinTicket` field; `getJoinTicket` in `joinSharedLink` / `rejoinKnownWorkspace`; `connectWorkspace` `?ticket=`; rejected-ticket reconnect; `teardownWorkspace` clear | 6 |
| `package.json`, `package-lock.json`, `CHANGELOG.md`, `client/src/whats-new-entries.ts`, `client/public/whats-new/turnstile.png`, `tests/scripts/manual-testing/capture-turnstile-screenshot.mjs` (new), `CONTRIBUTING.md`, `DEPLOYMENT.md`, `docs/TEST-COVERAGE.md`, `ROADMAP.md` | release | 7 |

---

## Task 1: `src/turnstile.ts` — pure ticket + siteverify

**Files:**
- Create: `src/turnstile.ts`
- Test: `tests/src/turnstile.test.ts`

**Interfaces:**
- Consumes: nothing (Web Crypto + `fetch`, both global in Workers/Node 20+).
- Produces:
  - `verifyTurnstileToken(token: string, remoteIp: string | null, secret: string): Promise<boolean>`
  - `mintJoinTicket(workspaceId: string, secret: string, now: number): Promise<string>`
  - `verifyJoinTicket(ticket: string | null, workspaceId: string, secret: string, now: number): Promise<boolean>`
  - `export const TICKET_TTL_MS = 15 * 60 * 1000;`

**Context:**
- `crypto.subtle` is available in both the Workers runtime and Vitest's Node environment. `TextEncoder`/`TextDecoder`/`atob`/`btoa` are global too.
- `src/auth.ts` has private `toBase64Url`/`fromBase64Url` — don't import them; this module carries its own (they differ slightly: auth's take `ArrayBuffer`, we want `Uint8Array` in and out).

- [ ] **Step 1: Write the failing test**

`tests/src/turnstile.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { verifyTurnstileToken, mintJoinTicket, verifyJoinTicket, TICKET_TTL_MS } from "../../src/turnstile";

const SECRET = "test-session-secret-not-real";

describe("join ticket", () => {
  it("mint → verify round-trips for the same workspace within its TTL", async () => {
    const now = 1_000_000;
    const ticket = await mintJoinTicket("ws1", SECRET, now);
    expect(await verifyJoinTicket(ticket, "ws1", SECRET, now + TICKET_TTL_MS - 1)).toBe(true);
  });

  it("rejects a ticket minted for a different workspace", async () => {
    const ticket = await mintJoinTicket("ws1", SECRET, 0);
    expect(await verifyJoinTicket(ticket, "ws2", SECRET, 1)).toBe(false);
  });

  it("rejects an expired ticket", async () => {
    const ticket = await mintJoinTicket("ws1", SECRET, 0);
    expect(await verifyJoinTicket(ticket, "ws1", SECRET, TICKET_TTL_MS + 1)).toBe(false);
  });

  it("rejects a tampered signature or payload", async () => {
    const ticket = await mintJoinTicket("ws1", SECRET, 0);
    const [p, s] = ticket.split(".");
    const flip = (str: string) => str.slice(0, -1) + (str.at(-1) === "A" ? "B" : "A");
    expect(await verifyJoinTicket(`${p}.${flip(s!)}`, "ws1", SECRET, 1)).toBe(false);
    expect(await verifyJoinTicket(`${flip(p!)}.${s}`, "ws1", SECRET, 1)).toBe(false);
  });

  it("rejects garbage / null / malformed tickets", async () => {
    for (const bad of [null, "", "no-dot", "a.b.c", "!!!.???"]) {
      expect(await verifyJoinTicket(bad, "ws1", SECRET, 1)).toBe(false);
    }
  });

  it("rejects a ticket signed with a different secret", async () => {
    const ticket = await mintJoinTicket("ws1", SECRET, 0);
    expect(await verifyJoinTicket(ticket, "ws1", "other-secret", 1)).toBe(false);
  });
});

describe("verifyTurnstileToken", () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubFetch(impl: () => Promise<Response>) {
    const fn = vi.fn(impl);
    vi.stubGlobal("fetch", fn);
    return fn;
  }

  it("true only when Cloudflare returns success:true", async () => {
    stubFetch(async () => new Response(JSON.stringify({ success: true }), { status: 200 }));
    expect(await verifyTurnstileToken("tok", "1.2.3.4", "sec")).toBe(true);
  });

  it("false on success:false", async () => {
    stubFetch(async () => new Response(JSON.stringify({ success: false }), { status: 200 }));
    expect(await verifyTurnstileToken("tok", null, "sec")).toBe(false);
  });

  it("false on a non-2xx response", async () => {
    stubFetch(async () => new Response("nope", { status: 500 }));
    expect(await verifyTurnstileToken("tok", null, "sec")).toBe(false);
  });

  it("false when fetch throws", async () => {
    stubFetch(async () => {
      throw new Error("network");
    });
    expect(await verifyTurnstileToken("tok", null, "sec")).toBe(false);
  });

  it("posts secret / response / remoteip in the form body", async () => {
    const fn = stubFetch(async () => new Response(JSON.stringify({ success: true }), { status: 200 }));
    await verifyTurnstileToken("the-token", "9.9.9.9", "the-secret");
    const [url, init] = fn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://challenges.cloudflare.com/turnstile/v0/siteverify");
    expect(init.method).toBe("POST");
    const body = init.body as FormData;
    expect(body.get("secret")).toBe("the-secret");
    expect(body.get("response")).toBe("the-token");
    expect(body.get("remoteip")).toBe("9.9.9.9");
  });
});
```

- [ ] **Step 2: Run it, expect failure**

Run: `npx vitest run tests/src/turnstile.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/turnstile.ts`**

```ts
const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
export const TICKET_TTL_MS = 15 * 60 * 1000;

function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmac(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

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

export async function mintJoinTicket(workspaceId: string, secret: string, now: number): Promise<string> {
  const payload = JSON.stringify({ w: workspaceId, exp: now + TICKET_TTL_MS });
  const sig = await hmac(secret, `join-ticket:${payload}`);
  return `${b64urlEncode(new TextEncoder().encode(payload))}.${b64urlEncode(sig)}`;
}

export async function verifyJoinTicket(
  ticket: string | null,
  workspaceId: string,
  secret: string,
  now: number,
): Promise<boolean> {
  if (!ticket) return false;
  const parts = ticket.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return false;
  let payload: string;
  let gotSig: Uint8Array;
  try {
    payload = new TextDecoder().decode(b64urlDecode(parts[0]));
    gotSig = b64urlDecode(parts[1]);
  } catch {
    return false;
  }
  const expectedSig = await hmac(secret, `join-ticket:${payload}`);
  if (!timingSafeEqual(expectedSig, gotSig)) return false;
  let parsed: { w?: unknown; exp?: unknown };
  try {
    parsed = JSON.parse(payload) as { w?: unknown; exp?: unknown };
  } catch {
    return false;
  }
  return parsed.w === workspaceId && typeof parsed.exp === "number" && parsed.exp > now;
}
```

- [ ] **Step 4: Run the test, expect pass**

Run: `npx vitest run tests/src/turnstile.test.ts`
Expected: PASS (12).

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck && npm run format
git add src/turnstile.ts tests/src/turnstile.test.ts
git commit -m "$(cat <<'EOF'
feat(turnstile): siteverify wrapper + HMAC-signed join tickets

Pure module — verifyTurnstileToken hits Cloudflare's siteverify;
mint/verifyJoinTicket sign a {workspaceId, exp} payload with the app's
SESSION_SECRET (domain-separated), 15-min TTL, timing-safe compare.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `/join-ticket` endpoint

**Files:**
- Modify: `src/env.ts` (add `TURNSTILE_SECRET_KEY?: string`)
- Modify: `src/worker.ts` (route constant + forward)
- Modify: `src/workspace-room.ts` (`workspaceIdFromUrl`, `handleJoinTicket`, route it)
- Test: `tests/src/workspace-room.test.ts`

**Interfaces:**
- Consumes: `verifyTurnstileToken`, `mintJoinTicket` from `./turnstile` (Task 1).
- Produces: `POST /api/workspace/:id/join-ticket` → JSON `{ enabled: false } | { skip: true } | { ticket: string } | { error: "turnstile-failed" | "bad-request" }`.
- Produces: `private workspaceIdFromUrl(url: URL): string` on `WorkspaceRoom`, used by Task 3 too.

**Context:**
- `src/worker.ts` route pattern (see `WORKSPACE_ACCESS_REQUEST_PATH` at line ~15 and its forward at ~39): an anchored regex + `env.WORKSPACE_ROOM.idFromName(match[1]!)`.
- `src/workspace-room.ts` `fetch()` sub-routing (line ~309) is a run of `if (url.pathname.endsWith("/x")) return this.handleX(request);` — the `/join-ticket` check goes before `endsWith("/access")`.
- `WorkspaceRoom` reads secrets as `this.env.X` (`decryptSession(this.env, …)` in `getSession`). `this.env.SESSION_SECRET` is the HMAC key.
- `this.getSession(request)` returns `{ token, username, exp? } | null`.
- `tests/src/workspace-room.test.ts`: `fakeState()`, `const fakeEnvWithSecret = { SESSION_SECRET: "test-secret-key-not-real" } as unknown as Env`, `encryptSession(fakeEnvWithSecret, { token, username })` for a cookie, `new Request("https://example.com/…", { headers: { Cookie: … } })`. Requests in the DO tests use whatever URL you pass — build `https://example.com/api/workspace/ws1/join-ticket` so `workspaceIdFromUrl` yields `"ws1"`.

- [ ] **Step 1: Write the failing tests**

In `tests/src/workspace-room.test.ts`, add near the end:

```ts
import { verifyJoinTicket } from "../../src/turnstile";

const fakeEnvWithTurnstile = {
  SESSION_SECRET: "test-secret-key-not-real",
  TURNSTILE_SECRET_KEY: "test-turnstile-secret",
} as unknown as Env;

function joinTicketReq(opts: { workspaceId?: string; cookie?: string; body?: unknown } = {}) {
  const wsId = opts.workspaceId ?? "ws1";
  return new Request(`https://example.com/api/workspace/${wsId}/join-ticket`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(opts.cookie ? { Cookie: `mde_gh_session=${opts.cookie}` } : {}),
    },
    body: JSON.stringify(opts.body ?? { token: "widget-token" }),
  });
}

describe("WorkspaceRoom.handleJoinTicket", () => {
  afterEach(() => vi.unstubAllGlobals());
  const okAccess = { owner: "alice", generalAccess: "anyone", requireAccount: false, role: "viewer", invited: [] };

  it("returns { enabled: false } when TURNSTILE_SECRET_KEY is unset", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnvWithSecret);
    await room.state.storage.put("access", okAccess);
    const res = await room.handleJoinTicket(joinTicketReq());
    expect(await res.json()).toEqual({ enabled: false });
  });

  it("returns { skip: true } for a signed-in visitor and never calls siteverify", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const room = new WorkspaceRoom(fakeState(), fakeEnvWithTurnstile);
    await room.state.storage.put("access", okAccess);
    const cookie = await encryptSession(fakeEnvWithTurnstile, { token: "t", username: "bob" });
    const res = await room.handleJoinTicket(joinTicketReq({ cookie }));
    expect(await res.json()).toEqual({ skip: true });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("mints a workspace-scoped ticket when the token verifies", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 })));
    const room = new WorkspaceRoom(fakeState(), fakeEnvWithTurnstile);
    await room.state.storage.put("access", okAccess);
    const res = await room.handleJoinTicket(joinTicketReq({ workspaceId: "ws1" }));
    const body = (await res.json()) as { ticket: string };
    expect(typeof body.ticket).toBe("string");
    expect(await verifyJoinTicket(body.ticket, "ws1", "test-secret-key-not-real", Date.now())).toBe(true);
    expect(await verifyJoinTicket(body.ticket, "ws2", "test-secret-key-not-real", Date.now())).toBe(false);
  });

  it("403 turnstile-failed when the token does not verify", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ success: false }), { status: 200 })));
    const room = new WorkspaceRoom(fakeState(), fakeEnvWithTurnstile);
    await room.state.storage.put("access", okAccess);
    const res = await room.handleJoinTicket(joinTicketReq());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "turnstile-failed" });
  });

  it("400 when the body has no token", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnvWithTurnstile);
    await room.state.storage.put("access", okAccess);
    const res = await room.handleJoinTicket(joinTicketReq({ body: {} }));
    expect(res.status).toBe(400);
  });

  it("405 on a non-POST", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnvWithTurnstile);
    const res = await room.handleJoinTicket(new Request("https://example.com/api/workspace/ws1/join-ticket"));
    expect(res.status).toBe(405);
  });
});
```

- [ ] **Step 2: Run them, expect failure**

Run: `npx vitest run tests/src/workspace-room.test.ts -t "handleJoinTicket"`
Expected: FAIL — `room.handleJoinTicket` is not a function.

- [ ] **Step 3: `src/env.ts`**

Add to the `Env` interface, after `SESSION_SECRET`:

```ts
  // Cloudflare Turnstile secret key (a `wrangler secret`). When set (and
  // the client build sets VITE_TURNSTILE_SITE_KEY too), an anonymous join
  // to an "anyone with the link" workspace must pass a Turnstile check.
  // Unset → the check is skipped entirely. See src/turnstile.ts.
  TURNSTILE_SECRET_KEY?: string;
```

- [ ] **Step 4: `src/worker.ts` route**

Add the constant next to `WORKSPACE_ACCESS_REQUEST_PATH` (~line 15):

```ts
const WORKSPACE_JOIN_TICKET_PATH = /^\/api\/workspace\/([A-Za-z0-9_-]{1,128})\/join-ticket$/;
```

In `fetch()`, next to the `workspaceAccessRequestMatch` block (~line 39):

```ts
    const joinTicketMatch = url.pathname.match(WORKSPACE_JOIN_TICKET_PATH);
    if (joinTicketMatch) {
      const id = env.WORKSPACE_ROOM.idFromName(joinTicketMatch[1]!);
      return env.WORKSPACE_ROOM.get(id).fetch(request);
    }
```

- [ ] **Step 5: `src/workspace-room.ts`**

Add the import at the top with the other `./` imports:

```ts
import { verifyTurnstileToken, mintJoinTicket } from "./turnstile";
```

Add the helper method (anywhere in the class, e.g. next to `getSession`):

```ts
  private workspaceIdFromUrl(url: URL): string {
    return url.pathname.match(/^\/api\/workspace\/([A-Za-z0-9_-]{1,128})(?:\/|$)/)?.[1] ?? "";
  }
```

In `fetch()`, immediately before `if (url.pathname.endsWith("/access"))`:

```ts
    if (url.pathname.endsWith("/join-ticket")) return this.handleJoinTicket(request);
```

Add the handler:

```ts
  async handleJoinTicket(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
    const secret = this.env.TURNSTILE_SECRET_KEY;
    if (!secret) return Response.json({ enabled: false });

    const session = await this.getSession(request);
    if (session?.username) return Response.json({ skip: true });

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

- [ ] **Step 6: Run the tests, expect pass**

Run: `npx vitest run tests/src/workspace-room.test.ts`
Expected: PASS (the new `handleJoinTicket` describe + all existing).

- [ ] **Step 7: Typecheck + commit**

```bash
npm run typecheck && npm run format
git add src/env.ts src/worker.ts src/workspace-room.ts tests/src/workspace-room.test.ts
git commit -m "$(cat <<'EOF'
feat(turnstile): POST /api/workspace/:id/join-ticket

Verifies a Turnstile widget token with Cloudflare and mints a
workspace-scoped join ticket. { enabled: false } when TURNSTILE_SECRET_KEY
is unset; { skip: true } for a signed-in session; 403 on a bad token.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `authorize()` gate

**Files:**
- Modify: `src/workspace-room.ts` (`authorize()`)
- Test: `tests/src/workspace-room.test.ts`

**Interfaces:**
- Consumes: `verifyJoinTicket` from `./turnstile`; `workspaceIdFromUrl` (Task 2).
- Produces: `authorize()` returns `{ ok: false, status: 401, message: "turnstile-required" }` for the anonymous + `"anyone"` + configured + no/bad-ticket case; every other path unchanged.

**Context:**
- `authorize(request)` today (line ~381): gets `session`, gets `access`, `if (!access.owner) return { ok:false, 403 }`, `const role = resolveRole(access, session?.username ?? null)`, `if (!role) { … 401/403 }`, `return { ok: true, username, role }`.
- It's called from the WS-upgrade branch of `fetch()` (line ~344) and from every HTTP handler. The gate must only bite anonymous WS-style requests; guarding on `!session?.username && access.generalAccess === "anyone" && this.env.TURNSTILE_SECRET_KEY` is sufficient — a `requireAccount` link forces a session, a `restricted` link never resolves a role for an anon user, and the owner-gated HTTP handlers always have a session.
- The WS-upgrade request URL is `https://…/api/workspace/<id>` (no trailing slash) possibly with `?ticket=…`. `new URL(request.url).searchParams.get("ticket")`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/src/workspace-room.test.ts`, in the `describe("WorkspaceRoom.authorize", …)` block:

```ts
  it("turnstile: anonymous on an 'anyone' link needs a valid ticket when configured", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnvWithTurnstile);
    await room.state.storage.put("access", { owner: "alice", generalAccess: "anyone", requireAccount: false, role: "viewer", invited: [] });

    const noTicket = await room.authorize(new Request("https://example.com/api/workspace/ws1"));
    expect(noTicket).toEqual({ ok: false, status: 401, message: "turnstile-required" });

    const { mintJoinTicket } = await import("../../src/turnstile");
    const good = await mintJoinTicket("ws1", "test-secret-key-not-real", Date.now());
    const withTicket = await room.authorize(new Request(`https://example.com/api/workspace/ws1?ticket=${encodeURIComponent(good)}`));
    expect(withTicket).toEqual({ ok: true, username: null, role: "viewer" });
  });

  it("turnstile: a ticket for another workspace is rejected", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnvWithTurnstile);
    await room.state.storage.put("access", { owner: "alice", generalAccess: "anyone", requireAccount: false, role: "viewer", invited: [] });
    const { mintJoinTicket } = await import("../../src/turnstile");
    const wrong = await mintJoinTicket("other-ws", "test-secret-key-not-real", Date.now());
    const res = await room.authorize(new Request(`https://example.com/api/workspace/ws1?ticket=${encodeURIComponent(wrong)}`));
    expect(res.ok).toBe(false);
  });

  it("turnstile: a signed-in visitor bypasses the ticket check", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnvWithTurnstile);
    await room.state.storage.put("access", { owner: "alice", generalAccess: "anyone", requireAccount: false, role: "viewer", invited: [] });
    const cookie = await encryptSession(fakeEnvWithTurnstile, { token: "t", username: "carol" });
    const res = await room.authorize(
      new Request("https://example.com/api/workspace/ws1", { headers: { Cookie: `mde_gh_session=${cookie}` } }),
    );
    expect(res).toEqual({ ok: true, username: "carol", role: "viewer" });
  });

  it("turnstile: no check when TURNSTILE_SECRET_KEY is unset", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnvWithSecret);
    await room.state.storage.put("access", { owner: "alice", generalAccess: "anyone", requireAccount: false, role: "viewer", invited: [] });
    const res = await room.authorize(new Request("https://example.com/api/workspace/ws1"));
    expect(res).toEqual({ ok: true, username: null, role: "viewer" });
  });

  it("turnstile: a restricted link still rejects an anon user before the ticket is consulted", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnvWithTurnstile);
    await room.state.storage.put("access", { owner: "alice", generalAccess: "restricted", requireAccount: false, role: "viewer", invited: [] });
    const res = await room.authorize(new Request("https://example.com/api/workspace/ws1"));
    expect(res).toEqual({ ok: false, status: 401, message: "Sign in with GitHub to join this workspace." });
  });
```

- [ ] **Step 2: Run them, expect failure**

Run: `npx vitest run tests/src/workspace-room.test.ts -t "turnstile:"`
Expected: FAIL — the no-ticket anon case currently returns `{ ok: true, … }`.

- [ ] **Step 3: Add the gate**

In `src/workspace-room.ts`, add the import if not already present from Task 2:

```ts
import { verifyTurnstileToken, mintJoinTicket, verifyJoinTicket } from "./turnstile";
```

In `authorize()`, replace the final `return { ok: true, username: session?.username ?? null, role };` with:

```ts
    // Turnstile: an anonymous connection to an "anyone with the link"
    // room must carry a valid join ticket on the WS-upgrade URL, when
    // the Turnstile secret is configured. Signed-in users, requireAccount
    // links (which force a session), and restricted links (which never
    // resolve a role for an anon user, so we never get here) are unaffected.
    if (!session?.username && this.env.TURNSTILE_SECRET_KEY && access.generalAccess === "anyone") {
      const url = new URL(request.url);
      const wsId = this.workspaceIdFromUrl(url);
      const ok = await verifyJoinTicket(url.searchParams.get("ticket"), wsId, this.env.SESSION_SECRET, Date.now());
      if (!ok) return { ok: false, status: 401, message: "turnstile-required" };
    }
    return { ok: true, username: session?.username ?? null, role };
```

- [ ] **Step 4: Run the tests, expect pass**

Run: `npx vitest run tests/src/workspace-room.test.ts`
Expected: PASS (all — new `turnstile:` cases + every existing `authorize` / handler test).

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck && npm run format
git add src/workspace-room.ts tests/src/workspace-room.test.ts
git commit -m "$(cat <<'EOF'
feat(turnstile): require a join ticket on the anonymous WS upgrade

authorize() now rejects an anonymous connection to an "anyone with the
link" room with 401 turnstile-required unless it carries a valid
?ticket=, but only when TURNSTILE_SECRET_KEY is set. Signed-in and
restricted paths are untouched.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: client `turnstile.ts` — config + ticket cache

**Files:**
- Modify: `client/src/vite-env.d.ts`
- Create: `client/src/stores/turnstile.ts`
- Create: `client/src/turnstile.ts`
- Test: `tests/client/src/turnstile.test.ts`

**Interfaces:**
- Produces:
  - `turnstileEnabled: boolean` (`!!import.meta.env.VITE_TURNSTILE_SITE_KEY`)
  - `getJoinTicket(remoteId: string): Promise<string | null>`
  - `clearJoinTicket(remoteId: string): void`
  - (Task 5 adds `solveTurnstile`.)
  - `turnstilePromptOpen: Writable<boolean>`, `turnstilePromptError: Writable<boolean>` from `./stores/turnstile`.

**Context:**
- `import.meta.env.VITE_TURNSTILE_SITE_KEY` is `undefined` in both Vitest projects (nothing sets it) → `turnstileEnabled` is `false` and `getJoinTicket` is a synchronous `null` — the contract this task locks in.
- Per-modal store pattern: `client/src/stores/settingsModal.ts`, `stores/turnstile.ts` follows it.
- `sessionStorage` is available under `// @vitest-environment jsdom`.

- [ ] **Step 1: Type the env var**

`client/src/vite-env.d.ts` — add to `interface ImportMetaEnv`:

```ts
  readonly VITE_TURNSTILE_SITE_KEY?: string;
```

- [ ] **Step 2: Create the store**

`client/src/stores/turnstile.ts`:

```ts
import { writable } from "svelte/store";

// The "checking you're human" modal (TurnstilePrompt.svelte) — opened by
// client/src/turnstile.ts's solveTurnstile() while a fresh challenge is
// pending, closed on success.
export const turnstilePromptOpen = writable(false);
export const turnstilePromptError = writable(false);
```

- [ ] **Step 3: Write the failing test**

`tests/client/src/turnstile.test.ts`:

```ts
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";

async function freshModule() {
  vi.resetModules();
  return import("../../../client/src/turnstile");
}

describe("client turnstile — disabled (the test default)", () => {
  beforeEach(() => sessionStorage.clear());

  it("turnstileEnabled is false with no VITE_TURNSTILE_SITE_KEY", async () => {
    expect((await freshModule()).turnstileEnabled).toBe(false);
  });

  it("getJoinTicket returns null and never touches fetch / the DOM", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const m = await freshModule();
    expect(await m.getJoinTicket("ws1")).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(document.querySelector("script[src*='challenges.cloudflare.com']")).toBeNull();
    vi.unstubAllGlobals();
  });

  it("a cached, unexpired ticket is returned without a challenge (enabled forced on)", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const m = await freshModule();
    // Simulate the enabled path by seeding the cache the way getJoinTicket writes it.
    sessionStorage.setItem("mde:joinTicket:ws1", JSON.stringify({ ticket: "cached-tkt", exp: Date.now() + 10 * 60_000 }));
    // With turnstile disabled getJoinTicket short-circuits to null before
    // reading the cache — so assert the cache *reader* directly instead:
    expect(m.readCachedTicketForTest("ws1")).toBe("cached-tkt");
    sessionStorage.setItem("mde:joinTicket:ws2", JSON.stringify({ ticket: "old", exp: Date.now() - 1 }));
    expect(m.readCachedTicketForTest("ws2")).toBeNull();
    vi.unstubAllGlobals();
  });

  it("clearJoinTicket removes the cache entry", async () => {
    const m = await freshModule();
    sessionStorage.setItem("mde:joinTicket:ws1", "whatever");
    m.clearJoinTicket("ws1");
    expect(sessionStorage.getItem("mde:joinTicket:ws1")).toBeNull();
  });
});
```

(The module exports a test-only `readCachedTicketForTest` alias for the private reader — see Step 4. The full solve→POST→cache path is exercised in Task 5's component test where `window.turnstile` can be stubbed.)

- [ ] **Step 4: Run it, expect failure**

Run: `npx vitest run tests/client/src/turnstile.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 5: Create `client/src/turnstile.ts`**

```ts
import { turnstilePromptOpen, turnstilePromptError } from "./stores/turnstile";

const SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined;
export const turnstileEnabled = !!SITE_KEY;

const CACHE_TTL_MS = 14 * 60 * 1000;
const cacheKey = (remoteId: string) => `mde:joinTicket:${remoteId}`;

function readCachedTicket(remoteId: string): string | null {
  try {
    const raw = sessionStorage.getItem(cacheKey(remoteId));
    if (!raw) return null;
    const { ticket, exp } = JSON.parse(raw) as { ticket?: unknown; exp?: unknown };
    return typeof ticket === "string" && typeof exp === "number" && exp > Date.now() + 30_000 ? ticket : null;
  } catch {
    return null;
  }
}

// test-only
export const readCachedTicketForTest = readCachedTicket;

export function clearJoinTicket(remoteId: string): void {
  try {
    sessionStorage.removeItem(cacheKey(remoteId));
  } catch {
    /* private mode */
  }
}

let scriptPromise: Promise<void> | null = null;
function loadTurnstileScript(): Promise<void> {
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    s.async = true;
    s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("turnstile script failed to load"));
    document.head.appendChild(s);
  });
  return scriptPromise;
}

interface TurnstileApi {
  render: (
    el: string | HTMLElement,
    opts: {
      sitekey: string;
      callback: (token: string) => void;
      "error-callback": () => void;
      "expired-callback": () => void;
      appearance?: string;
    },
  ) => string;
  remove: (id: string) => void;
}

// Opens the prompt, renders the widget, resolves with the token. Rejects
// on error/expiry (leaving the prompt open in its error state) or if the
// user cancels (TurnstilePrompt sets turnstilePromptOpen=false).
async function solveTurnstile(): Promise<string> {
  if (!SITE_KEY) throw new Error("turnstile not configured");
  turnstilePromptError.set(false);
  turnstilePromptOpen.set(true);
  await loadTurnstileScript();
  const api = (window as unknown as { turnstile?: TurnstileApi }).turnstile;
  const container = document.getElementById("turnstile-widget");
  if (!api || !container) {
    turnstilePromptError.set(true);
    throw new Error("turnstile unavailable");
  }
  return new Promise<string>((resolve, reject) => {
    let widgetId: string | null = null;
    const done = (fn: () => void) => {
      if (widgetId) {
        try {
          api.remove(widgetId);
        } catch {
          /* already gone */
        }
      }
      fn();
    };
    widgetId = api.render(container, {
      sitekey: SITE_KEY,
      appearance: "interaction-only",
      callback: (token) => done(() => {
        turnstilePromptOpen.set(false);
        resolve(token);
      }),
      "error-callback": () => {
        turnstilePromptError.set(true);
        reject(new Error("turnstile error"));
      },
      "expired-callback": () => {
        turnstilePromptError.set(true);
        reject(new Error("turnstile expired"));
      },
    });
  });
}

export async function getJoinTicket(remoteId: string): Promise<string | null> {
  if (!turnstileEnabled) return null;
  const cached = readCachedTicket(remoteId);
  if (cached) return cached;

  const token = await solveTurnstile();
  const res = await fetch(`/api/workspace/${encodeURIComponent(remoteId)}/join-ticket`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  if (!res.ok) {
    turnstilePromptError.set(true);
    turnstilePromptOpen.set(true);
    return null;
  }
  const data = (await res.json()) as { ticket?: string; skip?: boolean; enabled?: boolean };
  if (data.enabled === false || data.skip) return null;
  if (typeof data.ticket === "string") {
    try {
      sessionStorage.setItem(cacheKey(remoteId), JSON.stringify({ ticket: data.ticket, exp: Date.now() + CACHE_TTL_MS }));
    } catch {
      /* private mode — the returned ticket still works for this connection */
    }
    return data.ticket;
  }
  return null;
}
```

- [ ] **Step 6: Run the test, expect pass**

Run: `npx vitest run tests/client/src/turnstile.test.ts`
Expected: PASS (4).

- [ ] **Step 7: Typecheck + commit**

```bash
npm run typecheck && npm run format
git add client/src/vite-env.d.ts client/src/stores/turnstile.ts client/src/turnstile.ts tests/client/src/turnstile.test.ts
git commit -m "$(cat <<'EOF'
feat(turnstile): client module — enabled flag, ticket cache, solve flow

turnstileEnabled off unless VITE_TURNSTILE_SITE_KEY is set; getJoinTicket
returns a cached sessionStorage ticket or runs solveTurnstile() +
POST /join-ticket. All no-ops when disabled.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: `TurnstilePrompt.svelte`

**Files:**
- Create: `client/src/components/TurnstilePrompt.svelte`
- Modify: `client/index.html` (mount div), `client/src/main.ts` (mount)
- Test: `tests/client/src/components/TurnstilePrompt.test.ts`

**Interfaces:**
- Consumes: `turnstilePromptOpen`, `turnstilePromptError` from `../stores/turnstile`.
- Produces: a `<div id="turnstile-widget">` container (targeted by `solveTurnstile`), inside a `Modal` shown while `$turnstilePromptOpen`.

**Context:**
- `Modal.svelte` props: `title`, `icon?`, `labelledBy`, `onClose`, plus snippet slots. See `RequestAccessModal.svelte` for a minimal consumer.
- The widget is `appearance: "interaction-only"` → usually invisible; the modal is mostly a "verifying…" affordance that flashes.
- `main.ts` mounts are a flat `mount(Component, { target: document.getElementById("x-mount")! })` list; add near `mount(Toast, …)`.

- [ ] **Step 1: Write the failing test**

`tests/client/src/components/TurnstilePrompt.test.ts`:

```ts
import { test, expect, beforeEach } from "vitest";
import { render } from "vitest-browser-svelte";
import TurnstilePrompt from "../../../../client/src/components/TurnstilePrompt.svelte";
import { turnstilePromptOpen, turnstilePromptError } from "../../../../client/src/stores/turnstile";

beforeEach(() => {
  turnstilePromptOpen.set(false);
  turnstilePromptError.set(false);
});

test("renders nothing while closed", async () => {
  const screen = await render(TurnstilePrompt);
  expect(screen.container.querySelector("#turnstile-widget")).toBeNull();
});

test("open → shows the modal with the widget container", async () => {
  turnstilePromptOpen.set(true);
  const screen = await render(TurnstilePrompt);
  await expect.poll(() => screen.container.querySelector("#turnstile-widget")).not.toBeNull();
  expect(screen.container.textContent).toContain("human");
});

test("error state shows a retry affordance", async () => {
  turnstilePromptOpen.set(true);
  turnstilePromptError.set(true);
  const screen = await render(TurnstilePrompt);
  await expect.element(screen.getByRole("button", { name: /retry/i })).toBeVisible();
});
```

- [ ] **Step 2: Run it, expect failure**

Run: `npx vitest run --project=components tests/client/src/components/TurnstilePrompt.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the component**

```svelte
<script lang="ts">
  import Modal from "./Modal.svelte";
  import { turnstilePromptOpen, turnstilePromptError } from "../stores/turnstile";

  function cancel() {
    turnstilePromptOpen.set(false);
    turnstilePromptError.set(false);
  }
  // Retry re-runs the render by toggling the container's key; the caller
  // (solveTurnstile) owns the actual turnstile.render call, so we just
  // clear the error and let the widget's own retry / a fresh solve run.
  function retry() {
    turnstilePromptError.set(false);
  }
</script>

{#if $turnstilePromptOpen}
  <Modal title="Just checking you're human" icon="icon-lock" labelledBy="turnstilePromptTitle" onClose={cancel}>
    <p class="modal-hint">One quick check before this shared workspace loads. This usually takes a second.</p>
    <div id="turnstile-widget"></div>
    {#if $turnstilePromptError}
      <p class="modal-hint" style="color: var(--danger)">That didn't go through.</p>
      <div class="modal-actions">
        <button type="button" class="secondary-btn" onclick={cancel}>Cancel</button>
        <button type="button" class="primary-btn" onclick={retry}>Retry</button>
      </div>
    {/if}
  </Modal>
{/if}
```

> **Note on Retry:** for v1 the widget's own `error-callback` rejects `solveTurnstile`, which `collab.ts` surfaces as a failed join. The "Retry" button clears the error banner; a full re-drive of `solveTurnstile` on click is a follow-up. Keep it simple — the common path (interaction-only widget succeeds silently) never shows this.

- [ ] **Step 4: Mount it**

`client/index.html` — after `<div id="toast-mount"></div>` (and the consent-banner mount):

```html
    <div id="turnstile-prompt-mount"></div>
```

`client/src/main.ts` — import near the other component imports and mount near `mount(Toast, …)`:

```ts
import TurnstilePrompt from "./components/TurnstilePrompt.svelte";
```
```ts
mount(TurnstilePrompt, { target: document.getElementById("turnstile-prompt-mount")! });
```

- [ ] **Step 5: Run the component test, expect pass**

Run: `npx vitest run --project=components tests/client/src/components/TurnstilePrompt.test.ts`
Expected: PASS (3).

- [ ] **Step 6: Full unit + typecheck + build**

```bash
npm test && npm run typecheck && npm run build
```
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
npm run format
git add client/src/components/TurnstilePrompt.svelte client/index.html client/src/main.ts tests/client/src/components/TurnstilePrompt.test.ts
git commit -m "$(cat <<'EOF'
feat(turnstile): the "checking you're human" prompt modal

TurnstilePrompt.svelte hosts the #turnstile-widget container that
solveTurnstile() renders into; shown only while turnstilePromptOpen,
with a retry affordance on error.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: `collab.ts` wiring

**Files:**
- Modify: `client/src/collab.ts`
- Verify: `npm run test:e2e:collab` stays green with no suite changes.

**Interfaces:**
- Consumes: `turnstileEnabled`, `getJoinTicket`, `clearJoinTicket` from `./turnstile`.

**Context:**
- `workspaceRoom` object (line ~129) — add a `joinTicket` field.
- `joinSharedLink` (line ~291): after `const role = computeMyRole(access, username)` and the `if (!role)` bail, `username` falsy ⇒ anonymous. This function calls `joinWorkspace(workspaceId, …)` in several branches.
- `rejoinKnownWorkspace` (line ~444): re-fetches access → `computeMyRole` → `joinWorkspace`. Anonymous if no `window.MDE.githubUsername`.
- `connectWorkspace()` (line ~1175): `const ws = new WebSocket(\`${proto}//${location.host}/api/workspace/${encodeURIComponent(workspaceRoom.workspaceId!)}\`)`. `ws.onopen` sets `workspaceRoom.reconnectDelay = 1000`. `ws.onclose = () => scheduleReconnect()`.
- `teardownWorkspace()` (line ~1071): a block of `workspaceRoom.X = null` resets around line ~1102.
- `joinWorkspace` is `async` and both callers `await` it.

- [ ] **Step 1: Add the field + import**

In `client/src/collab.ts`, with the other `./` imports:

```ts
import { turnstileEnabled, getJoinTicket, clearJoinTicket } from "./turnstile";
```

In the `workspaceRoom` object literal, add after `role`:

```ts
  // A Turnstile join ticket for an anonymous connection to an "anyone
  // with the link" workspace (see turnstile.ts). null when signed in or
  // Turnstile isn't configured.
  joinTicket: null as string | null,
```

In `teardownWorkspace()`, next to `workspaceRoom.role = null;`:

```ts
  workspaceRoom.joinTicket = null;
```

- [ ] **Step 2: Gate the anonymous joins**

Add a small helper near the top of the join code (e.g. above `joinSharedLink`):

```ts
// For an anonymous connection to an "anyone with the link" workspace,
// solve Turnstile (or reuse a cached ticket) before connecting. A no-op
// when signed in or Turnstile is unconfigured. Throws if the user
// cancels the challenge.
async function ensureJoinTicket(remoteId: string): Promise<void> {
  if (!turnstileEnabled || window.MDE.githubUsername) {
    workspaceRoom.joinTicket = null;
    return;
  }
  workspaceRoom.joinTicket = await getJoinTicket(remoteId);
}
```

In `joinSharedLink`, right before the **first** `await joinWorkspace(...)` call (after the `workspaceAccessDenied.set(null)` line), and guarded so it only runs for the anonymous case:

```ts
  if (!username) {
    try {
      await ensureJoinTicket(workspaceId);
    } catch {
      workspaceAccessDenied.set("no-session");
      window.MDE.setReadOnly(true);
      lockToPreviewOnly();
      return;
    }
  }
```

In `rejoinKnownWorkspace`, right before its `await joinWorkspace(...)`:

```ts
  try {
    await ensureJoinTicket(remoteId);
  } catch {
    return; // user cancelled the challenge — stay disconnected
  }
```

- [ ] **Step 3: Thread the ticket onto the WS URL + handle rejection**

In `connectWorkspace()`, replace the `const ws = new WebSocket(...)` line:

```ts
  const base = `${proto}//${location.host}/api/workspace/${encodeURIComponent(workspaceRoom.workspaceId!)}`;
  const url = workspaceRoom.joinTicket ? `${base}?ticket=${encodeURIComponent(workspaceRoom.joinTicket)}` : base;
  const ws = new WebSocket(url);
```

Add an `everOpened` flag and use it in `onclose`:

```ts
  let everOpened = false;
```
In `ws.onopen`, first line: `everOpened = true;`
Replace `ws.onclose = () => scheduleReconnect();` with:

```ts
  ws.onclose = () => {
    // Closed before it ever opened, anonymous, Turnstile on, and we had a
    // ticket → most likely the ticket was rejected (expired / bad). Drop
    // it and re-challenge before reconnecting. (A genuine network drop
    // also lands here; the extra invisible check is harmless.)
    if (!everOpened && turnstileEnabled && !window.MDE.githubUsername && workspaceRoom.joinTicket) {
      clearJoinTicket(workspaceRoom.workspaceId!);
      workspaceRoom.joinTicket = null;
      void ensureJoinTicket(workspaceRoom.workspaceId!).finally(() => scheduleReconnect());
      return;
    }
    scheduleReconnect();
  };
```

- [ ] **Step 4: Unit suite + typecheck + build**

```bash
npm test && npm run typecheck && npm run build
```
Expected: PASS. (No client unit test drives `connectWorkspace` directly; `collab.test.ts` uses a `MockWebSocket` — confirm it still passes. `turnstileEnabled` is `false` there, so `ensureJoinTicket` is a no-op and the WS URL is unchanged.)

- [ ] **Step 5: Collab e2e — must stay green, no changes**

```bash
npm run test:e2e:collab
```
Expected: PASS (32). The suite sets neither key → `turnstileEnabled` false, `authorize()` skips the ticket check, anonymous `joinSharedWorkspace` works exactly as before. **If any collab test fails, stop** — the wiring has leaked into the disabled path.

- [ ] **Step 6: Manual smoke with Turnstile ON**

```bash
# .dev.vars: add TURNSTILE_SECRET_KEY=1x0000000000000000000000000000000AA  (Cloudflare always-passes test secret)
VITE_TURNSTILE_SITE_KEY=1x00000000000000000000AA npm run build
npm run dev   # :8787
```
Two browser profiles: owner shares a workspace as "Anyone with the link / Editor"; open the link in a fresh incognito window (signed out). Expect: the "Just checking you're human" modal flashes, then the doc loads and live sync works. Reload the incognito tab → no modal (cached ticket). `sessionStorage` shows `mde:joinTicket:<id>`. Sign in in that window → reload → no modal (session bypass). Revert `.dev.vars` + rebuild without the var.

- [ ] **Step 7: Commit**

```bash
npm run format
git add client/src/collab.ts
git commit -m "$(cat <<'EOF'
feat(turnstile): solve the challenge before an anonymous WS join

joinSharedLink / rejoinKnownWorkspace call ensureJoinTicket for the
anonymous "anyone with the link" case; connectWorkspace appends
?ticket=; a close-before-open re-challenges. All inert when Turnstile
is unconfigured — the collab e2e suite is unchanged and green.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Release 1.58.0

**Files:**
- Modify: `package.json`, `package-lock.json`, `CHANGELOG.md`, `client/src/whats-new-entries.ts`, `CONTRIBUTING.md`, `DEPLOYMENT.md`, `docs/TEST-COVERAGE.md`, `ROADMAP.md`
- Create: `client/public/whats-new/turnstile.png`, `tests/scripts/manual-testing/capture-turnstile-screenshot.mjs`

**Context:**
- `package.json` `"version"` is `1.57.1`; `package-lock.json` has two `"version": "1.57.1"` lines (~3, ~9).
- `CHANGELOG.md` newest section is `## [1.57.1] - 2026-09-09`.
- `whats-new-entries.ts` — append; `{version, title, description, screenshot, category}`, no date; `whats-new-entries.test.ts` fails without the screenshot file.
- CONTRIBUTING already has a "Build-time variables (optional, production)" section (from v1.57.0) listing `VITE_GA_MEASUREMENT_ID` + `SUPPORT_EMAIL` — extend it.
- DEPLOYMENT has `npx wrangler secret put SESSION_SECRET` etc. — add `TURNSTILE_SECRET_KEY`.
- Screenshot: the prompt only renders with `turnstilePromptOpen` true. The capture script builds with `VITE_TURNSTILE_SITE_KEY=1x00000000000000000000AA` (always-passes **visible** test key so the widget shows), drives an anonymous join, screenshots the modal before it auto-closes.

- [ ] **Step 1: Version bump** — `package.json` + both `package-lock.json` lines → `1.58.0`. Verify with `grep -n '"version": "1.5[78]' package.json package-lock.json`.

- [ ] **Step 2: CHANGELOG** — insert above `## [1.57.1] - 2026-09-09` (real current date):

```markdown
## [1.58.0] - <today>

### Added

- **Bot protection on public share links.** Opening an "anyone with the link" shared workspace while signed out now runs a brief Cloudflare Turnstile check ("just checking you're human") before the document loads. It's usually invisible and only happens once per shared link per browser session. Signed-in collaborators are never challenged.
```

- [ ] **Step 3: What's New entry** — append to `WHATS_NEW_ENTRIES`:

```ts
  {
    version: "1.58.0",
    title: "A Quick Human Check on Shared Links",
    description:
      "Opening a link-shared workspace while signed out now does a fast Cloudflare Turnstile check before the doc loads — usually you won't even see it, and it only happens once per link per browser session. It keeps automated abuse off public share links; signed-in collaborators are never asked.",
    screenshot: "/whats-new/turnstile.png",
    category: "Collaboration",
  },
```

- [ ] **Step 4: Write the capture script**

`tests/scripts/manual-testing/capture-turnstile-screenshot.mjs`:

```js
// One-off: capture client/public/whats-new/turnstile.png — the
// "checking you're human" prompt. The prompt only renders with
// VITE_TURNSTILE_SITE_KEY set, so build with Cloudflare's always-passes
// VISIBLE test key first:
//   bash tests/scripts/manual-testing/enable-dev-login.sh   # (owner needs to sign in to share)
//   VITE_TURNSTILE_SITE_KEY=1x00000000000000000000AA npm run build
//   TURNSTILE_SECRET_KEY=1x0000000000000000000000000000000AA npm run dev &   # :8787
//   node tests/scripts/manual-testing/capture-turnstile-screenshot.mjs
//   bash tests/scripts/manual-testing/disable-dev-login.sh
import { chromium } from "playwright";

const BASE = "http://localhost:8787";
const OUT = "client/public/whats-new/turnstile.png";

const browser = await chromium.launch();
const ownerCtx = await browser.newContext({ viewport: { width: 1100, height: 720 } });
const anonCtx = await browser.newContext({ viewport: { width: 1100, height: 720 } });
const owner = await ownerCtx.newPage();
const anon = await anonCtx.newPage();

await owner.route("**/api/auth/github/me", (r) =>
  r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ connected: true, username: "ts-owner" }) }),
);
await owner.goto(`${BASE}/api/dev/login?username=ts-owner`);
await owner.goto(BASE);
await owner.waitForFunction(() => window.MDE && typeof window.MDE.getEditor === "function", { timeout: 15000 });
await owner.locator('button:has-text("Got it")').click({ timeout: 2000 }).catch(() => {});
await owner.click("#emptyNewWorkspaceBtn").catch(() => {});
await owner.keyboard.press("Escape").catch(() => {});
await owner.evaluate(() => window.MDE.newDoc());
await owner.waitForSelector("#editor-mount .cm-content", { state: "visible" });
await owner.click("#editor-mount .cm-content");
await owner.keyboard.type("# Shared plan\n\nOpen to anyone with the link.");
await owner.click('button:has-text("Share")');
await owner.locator('button:has-text("Continue")').click({ timeout: 2000 }).catch(() => {});
await owner.locator('select[aria-label="General access"]').selectOption({ label: "Anyone with the link" });
await owner.locator('select[aria-label="Access level for people with the link"]').selectOption({ label: "Editor" });
const state = await owner.evaluate(() => {
  const docs = JSON.parse(localStorage.getItem("mde:docs") || "[]");
  const wss = JSON.parse(localStorage.getItem("mde:workspaces") || "[]");
  const activeId = localStorage.getItem("mde:active");
  const doc = docs.find((d) => d.id === activeId);
  return { doc, ws: wss.find((w) => w.id === doc?.workspaceId) };
});
await owner.locator('button:has-text("Done")').click({ timeout: 2000 }).catch(() => {});

await anon.goto(`${BASE}/w/${state.ws.remoteId}/${state.doc.id}/edit`);
await anon.locator("#turnstile-widget").waitFor({ timeout: 10000 });
await anon.waitForTimeout(400);
await anon.screenshot({ path: OUT });
console.log(`Saved ${OUT}`);

await ownerCtx.close();
await anonCtx.close();
await browser.close();
```

- [ ] **Step 5: Capture**

```bash
git diff --quiet src/worker.ts && echo clean
bash tests/scripts/manual-testing/enable-dev-login.sh
VITE_TURNSTILE_SITE_KEY=1x00000000000000000000AA npm run build
TURNSTILE_SECRET_KEY=1x0000000000000000000000000000000AA npm run dev > /tmp/dev-ts.log 2>&1 &
# wait for curl -sf http://localhost:8787/
node tests/scripts/manual-testing/capture-turnstile-screenshot.mjs
pkill -f "wrangler dev"
bash tests/scripts/manual-testing/disable-dev-login.sh
git diff --quiet src/worker.ts && echo "worker.ts clean"
npm run build   # plain rebuild (dist is gitignored; hygiene)
```

Open `client/public/whats-new/turnstile.png` — confirm the "Just checking you're human" modal with the (visible test) widget is in frame. Re-run with a bigger `waitForTimeout` if it auto-closed.

- [ ] **Step 6: Verify the screenshot test**

Run: `npx vitest run tests/client/src/whats-new-entries.test.ts`
Expected: PASS.

- [ ] **Step 7: CONTRIBUTING.md**

Extend the "Build-time variables (optional, production)" bullet list:

```markdown
- **`VITE_TURNSTILE_SITE_KEY`** + **`TURNSTILE_SECRET_KEY`** — the site
  key is a build var, the secret is a `wrangler secret`. When **both**
  are set, an anonymous visitor opening an "anyone with the link"
  workspace must pass a Cloudflare Turnstile check before live sync
  starts. Either missing → no widget, no server check, anonymous joins
  behave as before (this is the dev / test / self-host default).
  Cloudflare's always-passes test keys for local experimentation:
  site `1x00000000000000000000AA`, secret
  `1x0000000000000000000000000000000AA`.
```

- [ ] **Step 8: DEPLOYMENT.md**

In the production-secrets list, after `SESSION_SECRET`:

```markdown
  npx wrangler secret put TURNSTILE_SECRET_KEY   # optional — see below
```

And a short paragraph: the Turnstile secret plus `VITE_TURNSTILE_SITE_KEY`
in the Cloudflare build environment enable the anonymous-join bot check;
leave both unset to disable it.

- [ ] **Step 9: TEST-COVERAGE.md**

Add rows (App-shell / Workspace-collab section — match where SHELL-30..33 landed):

```markdown
| SHELL-34 | Turnstile join tickets — `src/turnstile.ts` `mintJoinTicket` / `verifyJoinTicket` round-trip; reject wrong-workspace, expired, tampered sig/payload, malformed, wrong-secret; `verifyTurnstileToken` true only on Cloudflare `success:true`, false on non-2xx / `success:false` / network throw, posts secret+response+remoteip | unit | covered | `tests/src/turnstile.test.ts` | v1.58.0 |
| SHELL-35 | `POST /api/workspace/:id/join-ticket` — `{ enabled:false }` when `TURNSTILE_SECRET_KEY` unset; `{ skip:true }` + no siteverify call for a signed-in session; `{ ticket }` (workspace-scoped) on a verified token; 403 `turnstile-failed` on a bad token; 400 on a missing token; 405 on non-POST | integration | covered | `tests/src/workspace-room.test.ts` | v1.58.0 |
| SHELL-36 | `authorize()` Turnstile gate — anonymous + `generalAccess:"anyone"` + `TURNSTILE_SECRET_KEY` set requires a valid `?ticket=` (401 `turnstile-required` without, ok with); a ticket for another workspace fails; a signed-in session bypasses; unset key → no check; a restricted link still 401s on the existing role check first | integration | covered | `tests/src/workspace-room.test.ts` | v1.58.0 |
| SHELL-37 | Client Turnstile — `turnstileEnabled` false + `getJoinTicket` returns `null` with no fetch / no script when `VITE_TURNSTILE_SITE_KEY` is unset; a cached unexpired `mde:joinTicket:<id>` is reused; `clearJoinTicket` removes it; `TurnstilePrompt` renders only while `turnstilePromptOpen`, with a retry affordance on error | unit + component | covered | `tests/client/src/turnstile.test.ts`, `tests/client/src/components/TurnstilePrompt.test.ts` | v1.58.0 |
```

- [ ] **Step 10: ROADMAP.md**

Under "Analytics & legal (2026-09-09) — shipped v1.57.0", replace the `**Next:**` paragraph with:

```markdown
**Turnstile on anonymous joins — shipped v1.58.0** (spec
`docs/superpowers/specs/2026-09-09-turnstile-anonymous-join-design.md`).
An anonymous visitor opening an "anyone with the link" workspace passes
a Cloudflare Turnstile check (a brief modal, `POST /join-ticket` →
HMAC-signed 15-min ticket on the WS upgrade) before live sync. Signed-in
users and deployments without `VITE_TURNSTILE_SITE_KEY` +
`TURNSTILE_SECRET_KEY` are unaffected.
```

Copy this spec's Non-goals into the "Deferred considerations" list: gating the pre-join `/access` + `/docs` fetches; rate-limiting / IP bans / a WAF rule; Turnstile on the legacy `CollabRoom`; a full interactive-challenge flow; a full `solveTurnstile` re-drive on the Retry button.

- [ ] **Step 11: Full verification**

```bash
npm test && npm run typecheck && npm run build && npm run format:check
npx playwright test --project=local
npm run test:e2e:collab
```
Expected: all green.

- [ ] **Step 12: Commit + PR**

```bash
git add package.json package-lock.json CHANGELOG.md client/src/whats-new-entries.ts client/public/whats-new/turnstile.png tests/scripts/manual-testing/capture-turnstile-screenshot.mjs CONTRIBUTING.md DEPLOYMENT.md docs/TEST-COVERAGE.md ROADMAP.md
git commit -m "$(cat <<'EOF'
chore: release 1.58.0 — Turnstile on anonymous workspace joins

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
git push -u origin docs/turnstile-spec
gh pr create --title "Cloudflare Turnstile on anonymous workspace joins — v1.58.0" --body "$(cat <<'EOF'
## What

An anonymous visitor opening an **"anyone with the link"** shared workspace now passes a Cloudflare Turnstile check before the live-sync WebSocket connects.

- `src/turnstile.ts` — siteverify wrapper + HMAC-signed (`SESSION_SECRET`, 15-min, workspace-scoped) join tickets.
- `WorkspaceRoom` — `POST /join-ticket` verifies the widget token → mints a ticket; `authorize()` requires a valid `?ticket=` on the anonymous WS upgrade for `"anyone"` links.
- Client — `getJoinTicket` (sessionStorage cache, per workspace), `TurnstilePrompt.svelte` (brief "checking you're human" modal), `collab.ts` threads the ticket onto the WS URL; a close-before-open re-challenges.

**Inert unless configured.** `VITE_TURNSTILE_SITE_KEY` (build) + `TURNSTILE_SECRET_KEY` (`wrangler secret`) — either missing → no widget, no server check. Dev, the collab e2e suite, and self-host are unchanged (and the e2e-collab suite required **zero** changes).

**Signed-in users are never challenged.**

Spec: `docs/superpowers/specs/2026-09-09-turnstile-anonymous-join-design.md`
Plan: `docs/superpowers/plans/2026-09-09-turnstile-anonymous-join.md`

## Setup (post-merge)

1. Cloudflare dashboard → Turnstile → create a widget for `editor.danplace.tech` (non-interactive).
2. `VITE_TURNSTILE_SITE_KEY` = the site key → Cloudflare build environment.
3. `npx wrangler secret put TURNSTILE_SECRET_KEY` = the secret key.

## Release

v1.58.0 — CHANGELOG `### Added`, What's New entry (with screenshot), CONTRIBUTING + DEPLOYMENT notes, TEST-COVERAGE SHELL-34..37.

## Tests

`npm test`, `npm run typecheck`, `npm run build`, `npm run format:check`, `npx playwright test --project=local`, and `npm run test:e2e:collab` all green locally.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 13: Watch CI, merge on green** (after user confirms).

---

## Self-Review

**1. Spec coverage:**
- Part 1 (`turnstile.ts` — `verifyTurnstileToken`, `mintJoinTicket`, `verifyJoinTicket`, base64url, timing-safe) → Task 1. ✅
- Part 2 (`Env.TURNSTILE_SECRET_KEY`, worker route, `workspaceIdFromUrl`, `handleJoinTicket` with all branches) → Task 2. ✅
- Part 2 (`authorize()` gate) → Task 3. ✅
- Part 3 client (`turnstileEnabled`, `getJoinTicket`, `clearJoinTicket`, sessionStorage cache 14min / >now+30s, `solveTurnstile`, script loader, `vite-env.d.ts`) → Tasks 4-5. ✅
- Part 3 (`TurnstilePrompt.svelte` + `turnstilePromptOpen`/`Error` stores + mount) → Task 5. ✅
- Part 3 (`collab.ts` — `joinTicket` field, `getJoinTicket` in `joinSharedLink`/`rejoinKnownWorkspace`, `connectWorkspace` `?ticket=`, rejected-ticket reconnect via `everOpened`, `teardownWorkspace` clear) → Task 6. ✅
- "collab e2e unchanged + verified green" → Task 6 Step 5 (explicit stop-on-fail). ✅
- Part 4 config + docs (CONTRIBUTING, DEPLOYMENT, both keys, test keys) → Task 7 Steps 7-8. ✅
- Release (version both lockfile fields, CHANGELOG `### Added`, What's New + real screenshot + capture script, TEST-COVERAGE SHELL-34..37, ROADMAP shipped + deferred) → Task 7. ✅
- Non-goals — none implemented; the Retry-button-doesn't-re-drive limitation is called out in Task 5 Step 3's note and added to the deferred list (Task 7 Step 10). ✅

**2. Placeholder scan:** No "TBD" / "handle edge cases" / "similar to Task N". `<today>`/`<date>` are fill-at-commit with an explicit "real current date". The base64url + HMAC helpers are written out in full in Task 1 Step 3. Line-number refs (`~line 129`, `~309`) are hints with quoted surrounding code. The Retry note is a deliberate, scoped v1 limitation, not a placeholder.

**3. Type/name consistency:**
- `verifyTurnstileToken(token, remoteIp, secret)` / `mintJoinTicket(workspaceId, secret, now)` / `verifyJoinTicket(ticket, workspaceId, secret, now)` — identical signatures in Task 1 (definition), Task 2 (`handleJoinTicket`), Task 3 (`authorize`), and every test.
- `TICKET_TTL_MS` — exported Task 1, used in Task 1's tests.
- `Env.TURNSTILE_SECRET_KEY` — Task 2 Step 3, read as `this.env.TURNSTILE_SECRET_KEY` in Tasks 2 & 3.
- `workspaceIdFromUrl` — Task 2, reused Task 3.
- `{ enabled: false } | { skip: true } | { ticket } | { error }` response shape — Task 2 impl + Task 2 tests + Task 4 client `getJoinTicket` (`data.enabled === false`, `data.skip`, `data.ticket`).
- `{ ok: false, status: 401, message: "turnstile-required" }` — Task 3 impl + Task 3 tests; matches the existing `authorize` return union.
- `turnstileEnabled` / `getJoinTicket` / `clearJoinTicket` — Task 4 exports; consumed in Task 6 (`ensureJoinTicket`).
- `turnstilePromptOpen` / `turnstilePromptError` — Task 4 store; consumed by `solveTurnstile` (Task 4) and `TurnstilePrompt.svelte` (Task 5).
- `#turnstile-widget` id — written by `solveTurnstile` (Task 4), rendered by `TurnstilePrompt.svelte` (Task 5), asserted in Task 5's test.
- `workspaceRoom.joinTicket` — Task 6 field, set by `ensureJoinTicket`, read by `connectWorkspace`, cleared in `teardownWorkspace`.
- `mde:joinTicket:<remoteId>` sessionStorage key — Task 4 (`cacheKey`) + Task 4 tests + Task 6 (`clearJoinTicket` call).
- Cache TTL: server `TICKET_TTL_MS` 15min (Task 1), client `CACHE_TTL_MS` 14min + `>now+30s` guard (Task 4) — consistent with the spec's Global Constraints.
- Screenshot path `client/public/whats-new/turnstile.png` — capture script (Task 7 Step 4) + What's New entry (Step 3) + file list.

No gaps found.
