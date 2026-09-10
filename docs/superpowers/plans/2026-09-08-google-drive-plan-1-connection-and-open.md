# Google Drive — Plan 1: Connection + Open markdown from Drive

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Connect Google Drive" connection (separate from GitHub sign-in) and the first capability it enables — **Open markdown from Drive**: pick `.md` files via the Google Picker and import them as documents in the current workspace.

**Architecture:** A new encrypted cookie `mde_google_session` holds `{ refreshToken, accessToken, accessTokenExp }`, minted by a server-side OAuth code flow in `src/google-auth.ts` (mirrors `src/github-auth.ts`, popup-based). `getGoogleAccessToken()` refreshes transparently. `src/google-drive.ts` proxies Drive downloads behind that cookie. Client `client/src/drive-files.ts` runs the OAuth popup, loads the Google Picker (client-side, needs a short-lived token from a dedicated endpoint), and posts the picked file ids back to the server for download → `createDoc`.

**Tech Stack:** Cloudflare Worker (TypeScript, raw `fetch` — no Google client libs server-side), Google OAuth 2.0 web-server flow, Google Drive API v3, the Google Picker JS API (`https://apis.google.com/js/api.js`), Svelte 5.

**Spec:** `docs/superpowers/specs/2026-09-08-google-drive-sync-design.md` — this plan implements the "Open markdown from Drive" capability + the connection foundation. "Save markdown to Drive" is plan 2; folder sync is plan 3.

> **Re-validated & revised 2026-09-11** against master at v1.64.1 (this
> plan and the branch `feat/google-drive-sync` / PR #172 it came from
> were written at ~v1.45 — close #172, do not merge). Changes from the
> original: (a) provisional version `1.49.0` → **`1.65.0`**; (b) **the
> app now has a CSP** — a per-request nonce policy in `src/csp.ts`
> `appCsp()` plus a dev-only `<meta>` in `client/index.html`; the
> original plan's "no CSP, nothing to do" was true then and is false now
> — **new Task 7b** adds `apis.google.com` / `docs.google.com` /
> `www.googleapis.com`; (c) `tests/src/auth.test.ts` already exists
> (session + `signAnonToken`/`verifyAnonToken` cases) — Task 2 **appends**
> to it and must not disturb the anon-token functions; (d) **new Task 7c**
> regenerates `tests/scripts/manual-testing/dev-login.patch` after Task
> 7's `src/worker.ts` import additions (known fragility — the e2e-collab /
> e2e-github CI jobs apply it); (e) `Settings.svelte` opens from the
> topbar account menu (`settingsModalOpen`, v1.56.0) not its own button;
> (f) `popupHtml`'s message type is already `"mde-github-auth"` on master.

## Global Constraints

- **`drive.file` scope only** — `https://www.googleapis.com/auth/drive.file`. Never request `drive` or any restricted scope.
- **No production-code regression to the GitHub path.** `src/auth.ts`'s `encryptSession`/`decryptSession` keep their exact current signatures and behaviour (they become thin wrappers). `mde_gh_session` is never read or written by any new code.
- **The Google access token reaches client JS only via `/api/auth/google/picker-token`, and only for the Picker.** All Drive file reads route back through the server. Document this in the code where the token is vended.
- **Graceful degradation when unconfigured:** with `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_API_KEY` absent, every `/api/auth/google/*` and `/api/drive/*` route returns `503`, and the client hides the Google menu items — exactly how the GitHub OAuth path already behaves without `GITHUB_CLIENT_SECRET`.
- **Commit trailer:** every commit ends with `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>` and nothing else (no `Claude-Session:` line).
- **No version bump / CHANGELOG / whats-new in this plan.** The feature isn't user-visible-complete until plan 3+ (the spec ships it all as one `1.65.0` release). `CHANGELOG.md` may gain a provisional `## [1.65.0]` `### Added` bullet that later plans extend.
- **Two `tsconfig`s, checked separately** (`npm run typecheck` runs both). New `src/**` + `tests/src/**` code is full strict; `client/src/**` + `tests/client/src/**` is looser (see `client/tsconfig.json`).
- **Tests:** `npm test` runs the `unit` + `components` vitest projects. Server tests → `tests/src/*.test.ts`; client logic → `tests/client/src/*.test.ts`; Svelte component tests → `tests/client/src/components/*.test.ts` only.

## Setup note (do once, before Task 3)

Google OAuth needs a real Google Cloud project even for local dev (the redirect URI must be registered). If you don't have one:

1. Google Cloud Console → new project → APIs & Services → **enable the Google Drive API** and the **Google Picker API**.
2. OAuth consent screen → External → app name / support email / developer email; add the `.../auth/drive.file` scope; add yourself as a **test user** (keeps the app in "testing" mode — no verification needed, the consent screen just warns "unverified").
3. Credentials → **OAuth client ID** → Web application → Authorized redirect URIs: `http://localhost:8787/api/auth/google/callback` (dev) and `https://editor.danplace.tech/api/auth/google/callback` (prod). Note the client id + secret.
4. Credentials → **API key** → restrict it to the Picker API + (optionally) HTTP referrers for your domains. Note the key.
5. Put the three values in a **git-ignored `.dev.vars`** (Task 12 documents this in `CONTRIBUTING.md`):
   ```
   GOOGLE_CLIENT_ID=...
   GOOGLE_CLIENT_SECRET=...
   GOOGLE_API_KEY=...
   ```

If you can't get creds, the server tests (Tasks 3–6) still run fully (they stub `fetch`); only the manual verification in Task 13 needs them.

---

## File Structure

- **Create `src/google-auth.ts`** — Google OAuth: `handleGoogleConnect`, `handleGoogleCallback`, `handleGoogleStatus`, `handleGoogleDisconnect`, `getGoogleAccessToken`. Owns the `mde_google_session` cookie. One responsibility: the Google credential lifecycle.
- **Create `src/google-drive.ts`** — Drive API proxy. This plan: `handleDrivePickerToken`, `handleDriveImport`. Later plans add folder/tree/push/export/revisions. One responsibility: authenticated Drive HTTP behind our session.
- **Modify `src/auth.ts`** — extract generic `encryptJSON<T>` / `decryptJSON<T>`; add `GOOGLE_SESSION_COOKIE` / `GOOGLE_STATE_COOKIE` constants + a `popupHtml` shared helper (moved from `github-auth.ts`).
- **Modify `src/github-auth.ts`** — `import { popupHtml }` instead of its local copy (pure refactor, no behaviour change).
- **Modify `src/env.ts`** — `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_API_KEY` (all optional); `GoogleSessionData`.
- **Modify `src/worker.ts`** — route `/api/auth/google/*` and `/api/drive/{picker-token,import}`.
- **Modify `wrangler.jsonc`** — `GOOGLE_CLIENT_ID` + `GOOGLE_API_KEY` in `vars`.
- **Modify `src/csp.ts`** (Task 7b) — `appCsp()`: `apis.google.com` → `script-src`, `docs.google.com` → `frame-src`, `www.googleapis.com` → `connect-src`.
- **Modify `client/index.html`** (Task 7b) — the dev-only `<meta http-equiv="Content-Security-Policy">`, same three additions, kept byte-consistent with `appCsp`.
- **Modify `tests/scripts/manual-testing/dev-login.patch`** (Task 7c) — regenerate after Task 7's `src/worker.ts` import block grows.
- **Create `client/src/stores/driveSync.ts`** — `driveConnected`, `driveImportBusyLabel`.
- **Create `client/src/drive-files.ts`** — session check, connect/disconnect, Picker load, `importMarkdownFromDrive`. Bridge: `window.MDE.{connectGoogleDrive,disconnectGoogleDrive,importMarkdownFromDrive}` + `onGoogleAuthComplete`.
- **Modify `client/src/main.ts`** — `import "./drive-files"`.
- **Modify `client/src/types.ts`** — the four `window.MDE` additions + `onGoogleAuthComplete`.
- **`client/src/drive-files.ts` owns its own `window` `message` listener** for `{ type: "mde-google-auth" }` (the GitHub one lives in `GithubSignInModal.svelte`, not `app.ts` — do **not** touch `app.ts`).
- **Modify `client/src/components/MenuBar.svelte`** — `File > Open > Markdown from Google Drive…`.
- **Modify `client/src/components/Settings.svelte`** — a "Google Drive" connect/disconnect row.
- **Modify `CONTRIBUTING.md`** — the Google Cloud setup (from the Setup note above).
- **Tests:** `tests/src/google-auth.test.ts`, `tests/src/google-drive.test.ts`, `tests/client/src/drive-files.test.ts`, `tests/client/src/components/MenuBar.test.ts` (extend or add), `tests/client/src/components/Settings.test.ts` (extend).

---

## Task 1: `src/env.ts` — Google config + session type

**Files:** Modify `src/env.ts`

**Interfaces produced:** `Env.GOOGLE_CLIENT_ID?`, `Env.GOOGLE_CLIENT_SECRET?`, `Env.GOOGLE_API_KEY?` (all `string | undefined`); `GoogleSessionData { refreshToken: string; accessToken: string; accessTokenExp: number; exp?: number }`.

- [x] **Step 1: Add the fields**

In `src/env.ts`, inside `interface Env`, after the existing `TEST_GITHUB_*` block:

```ts
  // Google OAuth (Drive integration — see src/google-auth.ts). Optional:
  // absent → every /api/auth/google/* and /api/drive/* route returns 503
  // and the client hides the Google menu items, same as the GitHub path
  // without GITHUB_CLIENT_SECRET. GOOGLE_CLIENT_ID and GOOGLE_API_KEY are
  // non-secret (public in every OAuth / Picker request); GOOGLE_CLIENT_SECRET
  // is a Worker secret.
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_API_KEY?: string;
```

After the `SessionData` interface, add:

```ts
// The mde_google_session cookie payload — a Google OAuth grant. Kept
// entirely separate from SessionData (the GitHub session): a user can
// connect Drive without a GitHub account and vice versa.
export interface GoogleSessionData {
  refreshToken: string;
  accessToken: string;
  accessTokenExp: number; // epoch ms — when accessToken stops working
  exp?: number;           // cookie lifetime, stamped by encryptJSON like SessionData.exp
}
```

- [x] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS (nothing consumes the new fields yet).

- [x] **Step 3: Commit**

```bash
git add src/env.ts
git commit -m "$(cat <<'EOF'
feat(drive): Env fields + GoogleSessionData for the Google Drive integration

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `src/auth.ts` — generic crypto + shared popup + Google constants

**Files:** Modify `src/auth.ts`, `src/github-auth.ts`, `tests/src/auth.test.ts`
**Test:** existing `tests/src/github-auth.test.ts` AND `tests/src/auth.test.ts` (session round-trip / expiry + `signAnonToken`/`verifyAnonToken` cases) must stay green — this is a pure refactor. **Do not touch `signAnonToken` / `verifyAnonToken` / `anonHmacKey` or the `toBase64Url` signature (it already accepts `ArrayBuffer | Uint8Array`).**

**Interfaces produced:**
- `encryptJSON<T>(env: Env, data: T, ttlMs?: number): Promise<string>` — AES-GCM, stamps `exp` if `T` has that shape; default `ttlMs = SESSION_TTL_MS`.
- `decryptJSON<T extends { exp?: number }>(env: Env, value: string): Promise<T | null>` — returns `null` if malformed or `exp <= now`.
- `GOOGLE_SESSION_COOKIE = "mde_google_session"`, `GOOGLE_STATE_COOKIE = "mde_google_oauth_state"`.
- `popupHtml(kind: "github" | "google", ok: boolean, message: string | null): string` and `popupResponse(kind, ok, message): Response` — moved here from `github-auth.ts`, `kind` selects the `postMessage` `type` (`"mde-github-auth"` / `"mde-google-auth"`) and the `<title>`.

- [x] **Step 1: Write the failing test** — **append** to the existing `tests/src/auth.test.ts` (it already imports from `../../src/auth` and defines `fakeEnv`; reuse that name, don't redefine). Add `encryptJSON, decryptJSON` to the import line, then a new describe block:

```ts
describe("encryptJSON / decryptJSON", () => {
  it("round-trips an arbitrary object and stamps an exp", async () => {
    const token = await encryptJSON(fakeEnv, { refreshToken: "r", accessToken: "a", accessTokenExp: 123 });
    const back = await decryptJSON<{ refreshToken: string; accessToken: string; accessTokenExp: number }>(fakeEnv, token);
    expect(back).toMatchObject({ refreshToken: "r", accessToken: "a", accessTokenExp: 123 });
    expect(typeof back!.exp).toBe("number");
    expect(back!.exp).toBeGreaterThan(Date.now());
  });

  it("returns null for a tampered / malformed value", async () => {
    expect(await decryptJSON(fakeEnv, "not.a.token")).toBeNull();
    expect(await decryptJSON(fakeEnv, "")).toBeNull();
  });

  it("returns null once exp has passed", async () => {
    const token = await encryptJSON(fakeEnv, { x: 1 }, -1000); // already expired
    expect(await decryptJSON<{ x: number }>(fakeEnv, token)).toBeNull();
  });
});
```

Run: `npx vitest run tests/src/auth.test.ts`
Expected: FAIL (`encryptJSON` not exported).

- [x] **Step 2: Refactor `src/auth.ts`**

Replace the `encryptSession` / `decryptSession` bodies with generic helpers, keeping the old names as wrappers. New content of that section:

```ts
export const SESSION_COOKIE = "mde_gh_session";
export const STATE_COOKIE = "mde_oauth_state";
export const GOOGLE_SESSION_COOKIE = "mde_google_session";
export const GOOGLE_STATE_COOKIE = "mde_google_oauth_state";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// ... deriveKey / toBase64Url / fromBase64Url unchanged ...

// Generic AES-GCM-encrypted-JSON helper. `ttlMs` is stamped into the
// ciphertext as `exp` and enforced by decryptJSON, so the cookie has a
// real lifetime even if the browser is told to keep it forever (see the
// long comment above SESSION_TTL_MS's original definition).
export async function encryptJSON<T>(env: Env, data: T, ttlMs: number = SESSION_TTL_MS): Promise<string> {
  const key = await deriveKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const payload = { ...data, exp: Date.now() + ttlMs };
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(payload)));
  return `${toBase64Url(iv.buffer)}.${toBase64Url(ciphertext)}`;
}

export async function decryptJSON<T extends { exp?: number }>(env: Env, value: string): Promise<T | null> {
  try {
    const [ivPart, ctPart] = value.split(".");
    if (!ivPart || !ctPart) return null;
    const key = await deriveKey(env);
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64Url(ivPart) }, key, fromBase64Url(ctPart));
    const parsed = JSON.parse(new TextDecoder().decode(plaintext)) as T;
    if (typeof parsed.exp !== "number" || parsed.exp <= Date.now()) return null;
    return parsed;
  } catch (err) {
    return null;
  }
}

export async function encryptSession(env: Env, data: SessionData): Promise<string> {
  return encryptJSON(env, data);
}
export async function decryptSession(env: Env, value: string): Promise<SessionData | null> {
  return decryptJSON<SessionData>(env, value);
}
```

Add `import type { Env } from "./env";` already present — keep it. `SessionData` import already present.

- [x] **Step 3: Move `popupHtml` / `popupResponse` into `src/auth.ts`**

Cut them from `src/github-auth.ts` (lines ~118–151, plus the local `escapeHtml`) and paste into `src/auth.ts`, parameterised:

```ts
function escapeHtml(str: string): string {
  const map: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return String(str).replace(/[&<>"']/g, (c) => map[c] as string);
}

// The OAuth popup's final page: postMessages the result to window.opener
// and closes itself. `kind` selects which auth flow this is — the client
// listeners key off `type`.
export function popupHtml(kind: "github" | "google", ok: boolean, message: string | null): string {
  const type = kind === "github" ? "mde-github-auth" : "mde-google-auth";
  const payload = JSON.stringify({ type, ok, message: message || null })
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
  const label = kind === "github" ? "GitHub sign-in" : "Google Drive";
  const body = ok
    ? `${kind === "github" ? "Signed in" : "Connected"} — this window will close automatically.`
    : `${kind === "github" ? "Sign-in" : "Connection"} failed: ${escapeHtml(message || "unknown error")}`;
  const closeDelay = ok ? 0 : 2500;
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${label}</title></head><body style="font:14px system-ui;padding:24px;color:${ok ? "#333" : "#c0392b"}">${body}<script>
    if (window.opener) window.opener.postMessage(${payload}, window.location.origin);
    setTimeout(function () { window.close(); }, ${closeDelay});
  </script></body></html>`;
}

export function popupResponse(kind: "github" | "google", ok: boolean, message: string): Response {
  return new Response(popupHtml(kind, ok, message), { status: ok ? 200 : 400, headers: { "Content-Type": "text/html; charset=utf-8" } });
}
```

In `src/github-auth.ts`: `import { ..., popupHtml, popupResponse } from "./auth.js";` and update its three call sites — `popupHtml(true, null)` → `popupHtml("github", true, null)`, `popupResponse(false, "...")` → `popupResponse("github", false, "...")`. Delete the now-unused local `escapeHtml`.

- [x] **Step 4: Run tests**

Run: `npx vitest run tests/src/auth.test.ts tests/src/github-auth.test.ts && npm run typecheck`
Expected: PASS — the new `auth.test.ts` cases and the whole existing `github-auth.test.ts` suite (the popup-html assertion in `handleCallback happy path` still matches; check the test for the exact expected string and adjust the test if it asserted `type: "mde-github-auth"` positionally — it should still pass since the payload is unchanged for `kind: "github"`).

- [x] **Step 5: Commit**

```bash
git add src/auth.ts src/github-auth.ts tests/src/auth.test.ts
git commit -m "$(cat <<'EOF'
refactor(auth): generic encryptJSON/decryptJSON + shared OAuth popup html

Extracts the AES-GCM-encrypted-cookie helper and the OAuth popup page out
of the GitHub-specific code so the Google Drive connection can reuse them.
encryptSession/decryptSession keep their signatures as thin wrappers; the
popup html is parameterised by auth kind. No behaviour change to the
GitHub path.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `src/google-auth.ts` — `handleGoogleConnect`

**Files:** Create `src/google-auth.ts`; Test `tests/src/google-auth.test.ts`

**Interfaces produced:** `handleGoogleConnect(request: Request, env: Env): Promise<Response>` — 302 to Google's authorize URL with a state cookie; `503` if `GOOGLE_CLIENT_ID` unset.

- [x] **Step 1: Write the failing test**

`tests/src/google-auth.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { handleGoogleConnect } from "../../src/google-auth";
import type { Env } from "../../src/env";

const env = {
  SESSION_SECRET: "test-secret-at-least-32-bytes-long!!",
  GOOGLE_CLIENT_ID: "gcid.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "gcs",
  GOOGLE_API_KEY: "gak",
} as unknown as Env;

afterEach(() => vi.unstubAllGlobals());

describe("handleGoogleConnect", () => {
  it("redirects to Google's authorize URL requesting exactly drive.file, offline access, and consent", async () => {
    const res = await handleGoogleConnect(new Request("https://app.example/api/auth/google/connect"), env);
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("Location")!);
    expect(loc.origin + loc.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(loc.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/drive.file");
    expect(loc.searchParams.get("access_type")).toBe("offline");
    expect(loc.searchParams.get("prompt")).toBe("consent");
    expect(loc.searchParams.get("response_type")).toBe("code");
    expect(loc.searchParams.get("redirect_uri")).toBe("https://app.example/api/auth/google/callback");
    const state = loc.searchParams.get("state")!;
    expect(state.length).toBeGreaterThan(10);
    expect(res.headers.get("Set-Cookie")).toContain(`mde_google_oauth_state=${state}`);
  });

  it("returns 503 when GOOGLE_CLIENT_ID is not configured", async () => {
    const res = await handleGoogleConnect(new Request("https://app.example/api/auth/google/connect"), { SESSION_SECRET: "x" } as unknown as Env);
    expect(res.status).toBe(503);
  });
});
```

Run: `npx vitest run tests/src/google-auth.test.ts` → FAIL (module missing).

- [x] **Step 2: Create `src/google-auth.ts` with the connect handler + shared bits**

```ts
import {
  GOOGLE_SESSION_COOKIE,
  GOOGLE_STATE_COOKIE,
  encryptJSON,
  decryptJSON,
  getCookie,
  cookieHeader,
  popupResponse,
  popupHtml,
} from "./auth.js";
import type { Env, GoogleSessionData } from "./env";

const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const GOOGLE_SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000; // the refresh token lasts ~6mo idle; re-connect after 90d cookie life

function notConfigured(env: Env): boolean {
  return !env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET;
}

function redirectUri(request: Request): string {
  return `${new URL(request.url).origin}/api/auth/google/callback`;
}

async function safeJson<T>(res: Response): Promise<T | null> {
  try {
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export async function handleGoogleConnect(request: Request, env: Env): Promise<Response> {
  if (notConfigured(env)) return new Response("Google Drive is not configured.", { status: 503 });
  const state = crypto.randomUUID();
  const authorize = new URL(AUTHORIZE_URL);
  authorize.searchParams.set("client_id", env.GOOGLE_CLIENT_ID!);
  authorize.searchParams.set("redirect_uri", redirectUri(request));
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("scope", DRIVE_SCOPE);
  authorize.searchParams.set("access_type", "offline");
  authorize.searchParams.set("prompt", "consent"); // always re-issue a refresh token
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("include_granted_scopes", "true");
  const headers = new Headers({ Location: authorize.toString() });
  headers.append("Set-Cookie", cookieHeader(GOOGLE_STATE_COOKIE, state, { maxAge: 600 }));
  return new Response(null, { status: 302, headers });
}
```

- [x] **Step 3: Run the test** — `npx vitest run tests/src/google-auth.test.ts` → PASS.

- [x] **Step 4: Commit**

```bash
git add src/google-auth.ts tests/src/google-auth.test.ts
git commit -m "$(cat <<'EOF'
feat(drive): Google OAuth connect handler (drive.file, offline)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `src/google-auth.ts` — `handleGoogleCallback` + `getGoogleAccessToken`

**Files:** Modify `src/google-auth.ts`, `tests/src/google-auth.test.ts`

**Interfaces produced:**
- `handleGoogleCallback(request, env): Promise<Response>` — verifies state, exchanges the code, sets `mde_google_session`, renders `popupHtml("google", true, null)`.
- `getGoogleAccessToken(request, env): Promise<{ token: string; setCookie?: string } | null>` — a live token, refreshing if `accessTokenExp` is within 60s; `null` if no session or the refresh fails.

- [x] **Step 1: Write the failing tests** — append to `tests/src/google-auth.test.ts`:

```ts
import { handleGoogleCallback, getGoogleAccessToken } from "../../src/google-auth";
import { encryptJSON } from "../../src/auth";

function tokenRes(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("handleGoogleCallback", () => {
  it("exchanges the code and sets an encrypted session cookie", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => tokenRes({ access_token: "at1", refresh_token: "rt1", expires_in: 3600 })),
    );
    const req = new Request("https://app.example/api/auth/google/callback?code=c&state=s", {
      headers: { Cookie: "mde_google_oauth_state=s" },
    });
    const res = await handleGoogleCallback(req, env);
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("Set-Cookie")!;
    expect(setCookie).toContain("mde_google_session=");
    expect(setCookie).toContain("HttpOnly");
    expect(await res.text()).toContain("mde-google-auth");
  });

  it("fails the popup on a state mismatch, without calling Google", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const req = new Request("https://app.example/api/auth/google/callback?code=c&state=evil", {
      headers: { Cookie: "mde_google_oauth_state=s" },
    });
    const res = await handleGoogleCallback(req, env);
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails the popup when Google withholds a refresh token", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => tokenRes({ access_token: "at1", expires_in: 3600 })));
    const req = new Request("https://app.example/api/auth/google/callback?code=c&state=s", {
      headers: { Cookie: "mde_google_oauth_state=s" },
    });
    const res = await handleGoogleCallback(req, env);
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/disconnect/i);
  });
});

describe("getGoogleAccessToken", () => {
  async function reqWithSession(session: object) {
    const cookie = await encryptJSON(env, session);
    return new Request("https://app.example/api/drive/x", { headers: { Cookie: `mde_google_session=${cookie}` } });
  }

  it("returns the stored token unchanged while it is still fresh", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const req = await reqWithSession({ refreshToken: "rt", accessToken: "at", accessTokenExp: Date.now() + 5 * 60_000 });
    const out = await getGoogleAccessToken(req, env);
    expect(out).toEqual({ token: "at" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refreshes an expired token and returns a Set-Cookie for the caller to thread", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => tokenRes({ access_token: "at2", expires_in: 3600 })));
    const req = await reqWithSession({ refreshToken: "rt", accessToken: "old", accessTokenExp: Date.now() - 1000 });
    const out = await getGoogleAccessToken(req, env);
    expect(out!.token).toBe("at2");
    expect(out!.setCookie).toContain("mde_google_session=");
  });

  it("returns null when the refresh token is rejected (revoked / idle)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => tokenRes({ error: "invalid_grant" }, 400)));
    const req = await reqWithSession({ refreshToken: "rt", accessToken: "old", accessTokenExp: Date.now() - 1000 });
    expect(await getGoogleAccessToken(req, env)).toBeNull();
  });

  it("returns null when there is no session cookie", async () => {
    expect(await getGoogleAccessToken(new Request("https://app.example/api/drive/x"), env)).toBeNull();
  });
});
```

Run → FAIL (exports missing).

- [x] **Step 2: Implement** — append to `src/google-auth.ts`:

```ts
interface GoogleTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

async function exchange(env: Env, params: Record<string, string>): Promise<GoogleTokenResponse | null> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID!, client_secret: env.GOOGLE_CLIENT_SECRET!, ...params }),
  });
  const body = await safeJson<GoogleTokenResponse>(res);
  if (!res.ok || !body || body.error) return null;
  return body;
}

export async function handleGoogleCallback(request: Request, env: Env): Promise<Response> {
  if (notConfigured(env)) return new Response("Google Drive is not configured.", { status: 503 });
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const expected = getCookie(request, GOOGLE_STATE_COOKIE);
  if (!code || !state || state !== expected) return popupResponse("google", false, "Invalid state.");

  const tok = await exchange(env, { grant_type: "authorization_code", code, redirect_uri: redirectUri(request) });
  if (!tok || !tok.access_token) return popupResponse("google", false, "Google sign-in failed.");
  if (!tok.refresh_token) {
    // prompt=consent should always return one; if Google still withholds it
    // the session would be unrefreshable — better to fail loudly.
    return popupResponse("google", false, "Google didn't return a refresh token — disconnect any prior grant in your Google account and try again.");
  }

  const session: GoogleSessionData = {
    refreshToken: tok.refresh_token,
    accessToken: tok.access_token,
    accessTokenExp: Date.now() + (tok.expires_in ?? 3600) * 1000,
  };
  const cookie = await encryptJSON(env, session, GOOGLE_SESSION_TTL_MS);
  const headers = new Headers({ "Content-Type": "text/html; charset=utf-8" });
  headers.append("Set-Cookie", cookieHeader(GOOGLE_SESSION_COOKIE, cookie, { maxAge: GOOGLE_SESSION_TTL_MS / 1000 }));
  headers.append("Set-Cookie", cookieHeader(GOOGLE_STATE_COOKIE, "", { maxAge: 0 }));
  return new Response(popupHtml("google", true, null), { headers });
}

export async function getGoogleAccessToken(request: Request, env: Env): Promise<{ token: string; setCookie?: string } | null> {
  if (notConfigured(env)) return null;
  const raw = getCookie(request, GOOGLE_SESSION_COOKIE);
  if (!raw) return null;
  const session = await decryptJSON<GoogleSessionData>(env, raw);
  if (!session) return null;

  if (session.accessTokenExp - Date.now() > 60_000) return { token: session.accessToken };

  const tok = await exchange(env, { grant_type: "refresh_token", refresh_token: session.refreshToken });
  if (!tok || !tok.access_token) return null;
  const next: GoogleSessionData = {
    refreshToken: session.refreshToken,
    accessToken: tok.access_token,
    accessTokenExp: Date.now() + (tok.expires_in ?? 3600) * 1000,
  };
  const cookie = await encryptJSON(env, next, GOOGLE_SESSION_TTL_MS);
  return { token: tok.access_token, setCookie: cookieHeader(GOOGLE_SESSION_COOKIE, cookie, { maxAge: GOOGLE_SESSION_TTL_MS / 1000 }) };
}
```

- [x] **Step 3: Run** — `npx vitest run tests/src/google-auth.test.ts && npm run typecheck` → PASS.

- [x] **Step 4: Commit**

```bash
git add src/google-auth.ts tests/src/google-auth.test.ts
git commit -m "$(cat <<'EOF'
feat(drive): Google OAuth callback + refresh-token access-token helper

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: `src/google-auth.ts` — `handleGoogleStatus` + `handleGoogleDisconnect`

**Files:** Modify `src/google-auth.ts`, `tests/src/google-auth.test.ts`

**Interfaces produced:**
- `handleGoogleStatus(request, env): Promise<Response>` → `Response.json({ connected: boolean })`. Cheap — decrypts the cookie, never calls Google.
- `handleGoogleDisconnect(request, env): Promise<Response>` → best-effort `POST REVOKE_URL`, clears the cookie, always `204`.

- [x] **Step 1: Tests** — append:

```ts
import { handleGoogleStatus, handleGoogleDisconnect } from "../../src/google-auth";

describe("handleGoogleStatus", () => {
  it("connected:false with no cookie, connected:true with a valid one, without calling Google", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const none = await handleGoogleStatus(new Request("https://app.example/api/auth/google/status"), env);
    expect(await none.json()).toEqual({ connected: false });

    const cookie = await encryptJSON(env, { refreshToken: "r", accessToken: "a", accessTokenExp: Date.now() + 3600_000 });
    const some = await handleGoogleStatus(
      new Request("https://app.example/api/auth/google/status", { headers: { Cookie: `mde_google_session=${cookie}` } }),
      env,
    );
    expect(await some.json()).toEqual({ connected: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("handleGoogleDisconnect", () => {
  it("revokes best-effort and clears the cookie, 204 even if revoke fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network"); }));
    const cookie = await encryptJSON(env, { refreshToken: "r", accessToken: "a", accessTokenExp: Date.now() + 3600_000 });
    const res = await handleGoogleDisconnect(
      new Request("https://app.example/api/auth/google/disconnect", { method: "POST", headers: { Cookie: `mde_google_session=${cookie}` } }),
      env,
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("Set-Cookie")).toMatch(/mde_google_session=;.*Max-Age=0/);
  });
});
```

- [x] **Step 2: Implement** — append to `src/google-auth.ts`:

```ts
export async function handleGoogleStatus(request: Request, env: Env): Promise<Response> {
  const raw = getCookie(request, GOOGLE_SESSION_COOKIE);
  const session = raw ? await decryptJSON<GoogleSessionData>(env, raw) : null;
  return Response.json({ connected: !!session });
}

export async function handleGoogleDisconnect(request: Request, env: Env): Promise<Response> {
  const raw = getCookie(request, GOOGLE_SESSION_COOKIE);
  const session = raw ? await decryptJSON<GoogleSessionData>(env, raw) : null;
  if (session) {
    try {
      await fetch(`${REVOKE_URL}?token=${encodeURIComponent(session.refreshToken)}`, { method: "POST" });
    } catch {
      /* best effort — the cookie is cleared regardless */
    }
  }
  const headers = new Headers();
  headers.append("Set-Cookie", cookieHeader(GOOGLE_SESSION_COOKIE, "", { maxAge: 0 }));
  return new Response(null, { status: 204, headers });
}
```

- [x] **Step 3: Run + commit**

```bash
npx vitest run tests/src/google-auth.test.ts && npm run typecheck
git add src/google-auth.ts tests/src/google-auth.test.ts
git commit -m "$(cat <<'EOF'
feat(drive): Google connection status + disconnect endpoints

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: `src/google-drive.ts` — `handleDrivePickerToken` + `handleDriveImport`

**Files:** Create `src/google-drive.ts`; Test `tests/src/google-drive.test.ts`

**Interfaces produced:**
- `handleDrivePickerToken(request, env): Promise<Response>` → `{ token, apiKey }` (threads `setCookie`); `401` if not connected; `503` if `GOOGLE_API_KEY` unset.
- `handleDriveImport(request, env): Promise<Response>` — body `{ fileIds: string[] }` → `{ results: [{ fileId, name, contentBase64, ok, error? }] }`, HTTP `200` even with per-file failures; `401` if not connected.

- [x] **Step 1: Tests** — `tests/src/google-drive.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { handleDrivePickerToken, handleDriveImport } from "../../src/google-drive";
import { encryptJSON } from "../../src/auth";
import type { Env } from "../../src/env";

const env = {
  SESSION_SECRET: "test-secret-at-least-32-bytes-long!!",
  GOOGLE_CLIENT_ID: "gcid",
  GOOGLE_CLIENT_SECRET: "gcs",
  GOOGLE_API_KEY: "gak",
} as unknown as Env;

afterEach(() => vi.unstubAllGlobals());

async function connectedReq(url: string, init?: RequestInit) {
  const cookie = await encryptJSON(env, { refreshToken: "r", accessToken: "live-token", accessTokenExp: Date.now() + 3600_000 });
  return new Request(url, { ...init, headers: { ...(init?.headers ?? {}), Cookie: `mde_google_session=${cookie}` } });
}

describe("handleDrivePickerToken", () => {
  it("returns the live token + api key when connected", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const res = await handleDrivePickerToken(await connectedReq("https://app/api/auth/google/picker-token"), env);
    expect(await res.json()).toEqual({ token: "live-token", apiKey: "gak" });
  });
  it("401 when not connected", async () => {
    const res = await handleDrivePickerToken(new Request("https://app/api/auth/google/picker-token"), env);
    expect(res.status).toBe(401);
  });
});

describe("handleDriveImport", () => {
  it("downloads each picked file, best-effort, 200 with per-file status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const u = String(url);
        if (u.includes("/files/ok1?") && u.includes("alt=media")) return new Response("# Hello", { status: 200 });
        if (u.includes("/files/ok1?")) return Response.json({ name: "notes.md", mimeType: "text/markdown" });
        if (u.includes("/files/bad2?")) return new Response("Not Found", { status: 404 });
        return new Response("?", { status: 500 });
      }),
    );
    const req = await connectedReq("https://app/api/drive/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileIds: ["ok1", "bad2"] }),
    });
    const res = await handleDriveImport(req, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results).toHaveLength(2);
    expect(body.results[0]).toMatchObject({ fileId: "ok1", name: "notes.md", ok: true });
    expect(Buffer.from(body.results[0].contentBase64, "base64").toString()).toBe("# Hello");
    expect(body.results[1]).toMatchObject({ fileId: "bad2", ok: false });
  });
  it("401 when not connected", async () => {
    const res = await handleDriveImport(
      new Request("https://app/api/drive/import", { method: "POST", body: JSON.stringify({ fileIds: ["x"] }) }),
      env,
    );
    expect(res.status).toBe(401);
  });
});
```

- [x] **Step 2: Implement** — `src/google-drive.ts`:

```ts
import { getGoogleAccessToken } from "./google-auth.js";
import type { Env } from "./env";

const DRIVE_API = "https://www.googleapis.com/drive/v3";

// Attaches `setCookie` (from a transparent token refresh) to a Response.
function withCookie(res: Response, setCookie?: string): Response {
  if (!setCookie) return res;
  const headers = new Headers(res.headers);
  headers.append("Set-Cookie", setCookie);
  return new Response(res.body, { status: res.status, headers });
}

function toBase64(buf: ArrayBuffer): string {
  let s = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}

// The Google Picker is a Google-hosted iframe with no server-side
// equivalent — it needs an OAuth token *in the browser*. This is the only
// place the Drive access token leaves the Worker. Bounded: the scope is
// drive.file (the token can only touch app-created / already-picked
// files), it's fetched only at the moment the Picker opens, and the
// actual downloads go back through /api/drive/import so the token isn't
// needed once the Picker closes.
export async function handleDrivePickerToken(request: Request, env: Env): Promise<Response> {
  if (!env.GOOGLE_API_KEY) return new Response("Google Drive is not configured.", { status: 503 });
  const auth = await getGoogleAccessToken(request, env);
  if (!auth) return new Response("Reconnect Google Drive.", { status: 401 });
  return withCookie(Response.json({ token: auth.token, apiKey: env.GOOGLE_API_KEY }), auth.setCookie);
}

export async function handleDriveImport(request: Request, env: Env): Promise<Response> {
  const auth = await getGoogleAccessToken(request, env);
  if (!auth) return new Response("Reconnect Google Drive.", { status: 401 });
  let body: { fileIds?: unknown };
  try {
    body = await request.json();
  } catch {
    return new Response("Invalid JSON.", { status: 400 });
  }
  const fileIds = Array.isArray(body.fileIds) ? body.fileIds.filter((x): x is string => typeof x === "string") : [];
  const h = { Authorization: `Bearer ${auth.token}` };

  const results = await Promise.all(
    fileIds.map(async (fileId) => {
      try {
        const metaRes = await fetch(`${DRIVE_API}/files/${encodeURIComponent(fileId)}?fields=name,mimeType`, { headers: h });
        if (!metaRes.ok) return { fileId, ok: false as const, error: `meta ${metaRes.status}` };
        const meta = (await metaRes.json()) as { name?: string };
        const contentRes = await fetch(`${DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media`, { headers: h });
        if (!contentRes.ok) return { fileId, ok: false as const, error: `content ${contentRes.status}` };
        return { fileId, name: meta.name ?? "untitled.md", contentBase64: toBase64(await contentRes.arrayBuffer()), ok: true as const };
      } catch (err) {
        return { fileId, ok: false as const, error: (err as Error).message };
      }
    }),
  );
  return withCookie(Response.json({ results }), auth.setCookie);
}
```

- [x] **Step 3: Run + commit**

```bash
npx vitest run tests/src/google-drive.test.ts && npm run typecheck
git add src/google-drive.ts tests/src/google-drive.test.ts
git commit -m "$(cat <<'EOF'
feat(drive): picker-token + best-effort file import endpoints

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Wire the routes + wrangler vars

**Files:** Modify `src/worker.ts`, `wrangler.jsonc`

- [x] **Step 1: `wrangler.jsonc`** — in `"vars"`, after `GITHUB_CLIENT_ID`:

```jsonc
    "GITHUB_CLIENT_ID": "Ov23liV4lb0YiRtTwpm9",
    // Public halves of the Google OAuth client + Picker API key (Drive
    // integration — src/google-auth.ts). GOOGLE_CLIENT_SECRET is a Worker
    // secret (wrangler secret put). Set all three in a git-ignored
    // .dev.vars for local dev — see CONTRIBUTING.md.
    "GOOGLE_CLIENT_ID": "",
    "GOOGLE_API_KEY": "",
```

(Leave them empty strings in the committed config — the real prod values go in via `wrangler secret put` / the Cloudflare dashboard, or the maintainer fills them here. Empty → the `notConfigured` / `!GOOGLE_API_KEY` guards fire and the feature is hidden, which is the desired default.)

- [x] **Step 2: `src/worker.ts`** — add the import after the `github-repo.js` import:

```ts
import { handleGoogleConnect, handleGoogleCallback, handleGoogleStatus, handleGoogleDisconnect } from "./google-auth.js";
import { handleDrivePickerToken, handleDriveImport } from "./google-drive.js";
```

Add the routes right after the `/api/auth/github/*` block:

```ts
    if (url.pathname === "/api/auth/google/connect") return handleGoogleConnect(request, env);
    if (url.pathname === "/api/auth/google/callback") return handleGoogleCallback(request, env);
    if (url.pathname === "/api/auth/google/status") return handleGoogleStatus(request, env);
    if (url.pathname === "/api/auth/google/disconnect" && request.method === "POST") return handleGoogleDisconnect(request, env);
    if (url.pathname === "/api/auth/google/picker-token" && request.method === "GET") return handleDrivePickerToken(request, env);
    if (url.pathname === "/api/drive/import" && request.method === "POST") return handleDriveImport(request, env);
```

- [x] **Step 3: Typecheck + a routing smoke test**

Run: `npm run typecheck`
Expected: PASS.

Add to `tests/src/worker-routing.test.ts` if it exists, else skip — the handler tests already cover behaviour; this is just wiring. Manually confirm with:
`grep -n "google" src/worker.ts` shows the six new routes.

- [x] **Step 4: Commit**

```bash
git add src/worker.ts wrangler.jsonc
git commit -m "$(cat <<'EOF'
feat(drive): route /api/auth/google/* and /api/drive/import

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7b: Content-Security-Policy — allow the Picker + Drive API

**Files:** Modify `src/csp.ts`, `client/index.html`, `tests/src/csp.test.ts` (create if absent)

Since v1.60.3 the app sets a per-request nonce CSP header from `src/csp.ts` `appCsp(nonce)` (prod, via `src/worker.ts`), and keeps a dev-only `<meta http-equiv="Content-Security-Policy">` in `client/index.html`. The Google Picker loads `https://apis.google.com/js/api.js` and renders a `docs.google.com` iframe; without these additions the Picker is silently CSP-blocked.

- [x] **Step 1: `src/csp.ts` — `appCsp(nonce)`**

In the array returned by `appCsp`, change three lines:

```ts
    `script-src 'self' 'nonce-${nonce}' https://challenges.cloudflare.com https://www.googletagmanager.com https://apis.google.com`,
    // ...
    "connect-src 'self' https://challenges.cloudflare.com https://www.googletagmanager.com https://*.google-analytics.com https://*.analytics.google.com https://www.googleapis.com",
    "frame-src https://challenges.cloudflare.com https://docs.google.com",
```

Leave `legalCsp(nonce)` untouched (the `/privacy` `/terms` pages never touch Drive).

- [x] **Step 2: `client/index.html` — the dev `<meta>` CSP**

Apply the identical three edits to the `content="…"` of `<meta http-equiv="Content-Security-Policy">` (it uses `'sha256-…'` instead of `'nonce-…'` in `script-src` — that difference stays; only add `https://apis.google.com`, `https://www.googleapis.com`, `https://docs.google.com` in the same three directives).

- [x] **Step 3: Test**

If `tests/src/csp.test.ts` exists, add cases; else create it:

```ts
import { describe, it, expect } from "vitest";
import { appCsp } from "../../src/csp";

describe("appCsp — Google Drive origins", () => {
  const csp = appCsp("test-nonce");
  it("allows the Picker loader and Drive API", () => {
    expect(csp).toContain("script-src 'self' 'nonce-test-nonce'");
    expect(csp).toMatch(/script-src [^;]*https:\/\/apis\.google\.com/);
    expect(csp).toMatch(/connect-src [^;]*https:\/\/www\.googleapis\.com/);
    expect(csp).toMatch(/frame-src [^;]*https:\/\/docs\.google\.com/);
  });
});
```

Run: `npx vitest run tests/src/csp.test.ts && npm test` (the built-bundle CSP e2e — `tests/e2e/collab/csp-built.spec.ts` — is exercised by `e2e-collab` in CI; it should still pass since the inline-script hash is unchanged).

- [x] **Step 4: Commit**

```bash
git add src/csp.ts client/index.html tests/src/csp.test.ts
git commit -m "$(cat <<'EOF'
feat(drive): CSP allows apis.google.com / googleapis.com / docs.google.com

The per-request appCsp() header and the dev <meta> policy both gain the
three Google origins the Picker + Drive API need.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7c: Regenerate `dev-login.patch`

**Files:** Modify `tests/scripts/manual-testing/dev-login.patch`

Task 7 added two `import` lines to the top region of `src/worker.ts` — the exact region `dev-login.patch` anchors on (its hunk-1 context includes `import type { Env }` and the first route `const` declarations). `git apply --check` of the current patch now **fails**, which breaks the `e2e-collab` / `e2e-github` CI jobs. Regenerate it — the procedure from the project memory `project_dev_login_patch_fragility`:

- [x] **Step 1: Confirm it's broken**

```bash
git apply --check tests/scripts/manual-testing/dev-login.patch
```
Expected: FAIL (`patch does not apply` at `src/worker.ts`).

- [x] **Step 2: Regenerate**

The three dev-login insertions the patch makes into `src/worker.ts` (an import, a `DEV_LOGIN_PATH` const near the other route consts, and the route handler near the other `/api/auth/*` routes) — read the current patch to see the exact three insertions, then:

```bash
# worker.ts route additions from Task 7 are already committed. Now hand-apply
# the 3 dev-login insertions to src/worker.ts by editing the file directly
# (mirror what the current patch's "+"-lines do, placed against the new
# surrounding context), then:
git diff src/worker.ts > tests/scripts/manual-testing/dev-login.patch
git checkout src/worker.ts
```

- [x] **Step 3: Verify apply + reverse both clean**

```bash
git apply --check tests/scripts/manual-testing/dev-login.patch          # applies
git apply tests/scripts/manual-testing/dev-login.patch
node scripts/check-no-dev-login.mjs || echo "(expected: dev-login present while patch applied)"
git apply -R tests/scripts/manual-testing/dev-login.patch               # reverses
git diff --quiet src/worker.ts && echo "clean"
node scripts/check-no-dev-login.mjs                                     # clean again
```

- [x] **Step 4: Commit**

```bash
git add tests/scripts/manual-testing/dev-login.patch
git commit -m "$(cat <<'EOF'
test: regenerate dev-login.patch for the new google-auth worker imports

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Client stores + bridge types

**Files:** Create `client/src/stores/driveSync.ts`; Modify `client/src/types.ts`

- [x] **Step 1: `client/src/stores/driveSync.ts`**

```ts
import { writable } from "svelte/store";

// Whether an mde_google_session cookie is live — hydrated from
// GET /api/auth/google/status by drive-files.ts on load, and re-checked
// after the connect popup reports success. Drives whether the Google
// menu items show as "Connect…" or the real actions.
export const driveConnected = writable(false);

// Transient status text while a Picker import is in flight ("Importing…").
// null → the menu shows its static label.
export const driveImportBusyLabel = writable<string | null>(null);
```

- [x] **Step 2: `client/src/types.ts`** — inside the `MDEBridge` interface (near `publishGist` / `openGistPicker`):

```ts
  // Google Drive integration — see client/src/drive-files.ts.
  connectGoogleDrive?: () => void;
  disconnectGoogleDrive?: () => Promise<void>;
  importMarkdownFromDrive?: () => Promise<void>;
  // Fired by drive-files.ts's own `message` listener when the Google
  // connect popup reports success — gist.ts-style chaining if needed.
  onGoogleAuthComplete?: () => void;
```

- [x] **Step 3: Typecheck** — `npm run typecheck` → PASS (svelte-check; nothing implements these yet, optional members are fine).

- [x] **Step 4: Commit**

```bash
git add client/src/stores/driveSync.ts client/src/types.ts
git commit -m "$(cat <<'EOF'
feat(drive): client store + window.MDE bridge surface for Drive

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: `client/src/drive-files.ts` — connection lifecycle

**Files:** Create `client/src/drive-files.ts`; Modify `client/src/main.ts`, `client/src/app.ts`; Test `tests/client/src/drive-files.test.ts`

**Interfaces produced:** module registers `window.MDE.connectGoogleDrive`, `window.MDE.disconnectGoogleDrive`, and chains `window.MDE.onGoogleAuthComplete`; keeps `driveConnected` in sync.

- [x] **Step 1: Failing test** — `tests/client/src/drive-files.test.ts`:

```ts
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { get } from "svelte/store";
import { driveConnected } from "../../../client/src/stores/driveSync";

beforeEach(() => {
  vi.resetModules();
  (window as any).MDE = {};
  driveConnected.set(false);
});

describe("drive-files connection lifecycle", () => {
  it("hydrates driveConnected from /api/auth/google/status on import", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ connected: true }), { status: 200 })));
    await import("../../../client/src/drive-files");
    // the module kicks off the status check at top level
    await vi.waitFor(() => expect(get(driveConnected)).toBe(true));
    vi.unstubAllGlobals();
  });

  it("disconnectGoogleDrive posts to the endpoint and clears driveConnected", async () => {
    driveConnected.set(true);
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    await import("../../../client/src/drive-files");
    await (window as any).MDE.disconnectGoogleDrive();
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/google/disconnect", expect.objectContaining({ method: "POST" }));
    expect(get(driveConnected)).toBe(false);
    vi.unstubAllGlobals();
  });
});
```

Run → FAIL.

- [x] **Step 2: Create `client/src/drive-files.ts`** (connection part; the Picker/import part is Task 10):

```ts
// Google Drive integration, client side. Two flows in later plans (save,
// folder sync); this file owns "Connect Google Drive" + "Open markdown
// from Drive". The Google OAuth grant lives in an HttpOnly cookie
// server-side (src/google-auth.ts) — this script only calls our own
// /api/auth/google/* + /api/drive/* endpoints, except for the Picker,
// which needs a token in the browser (fetched from picker-token, used
// only for the Picker widget — see importMarkdownFromDrive).
import "./types";
import { driveConnected, driveImportBusyLabel } from "./stores/driveSync";

window.MDE.connectGoogleDrive = connect;
window.MDE.disconnectGoogleDrive = disconnect;

checkSession();

document.addEventListener("DOMContentLoaded", () => {
  const existing = window.MDE.onGoogleAuthComplete;
  window.MDE.onGoogleAuthComplete = () => {
    existing?.();
    checkSession();
  };
});

async function checkSession(): Promise<void> {
  try {
    const res = await fetch("/api/auth/google/status");
    const data = await res.json();
    driveConnected.set(!!data.connected);
  } catch {
    driveConnected.set(false);
  }
}

// A 500x650 popup, same shape as the GitHub sign-in popup (app.ts opens
// that one at /api/auth/github/login). This module's own `message`
// listener (below) handles the { type: "mde-google-auth" } postMessage and calls
// window.MDE.onGoogleAuthComplete on success.
function connect(): void {
  const w = 500,
    h = 650;
  const left = window.screenX + (window.outerWidth - w) / 2;
  const top = window.screenY + (window.outerHeight - h) / 2;
  window.open("/api/auth/google/connect", "google-oauth", `width=${w},height=${h},left=${left},top=${top}`);
}

async function disconnect(): Promise<void> {
  try {
    await fetch("/api/auth/google/disconnect", { method: "POST" });
  } finally {
    driveConnected.set(false);
  }
}

// re-exported for Task 10
export { checkSession, driveImportBusyLabel };
```

- [x] **Step 3: `client/src/main.ts`** — add after `import "./gist";`:

```ts
import "./drive-files";
```

- [x] **Step 4: `client/src/drive-files.ts` — own the popup `message` listener**

**Revised 2026-09-11:** the GitHub `mde-github-auth` `message` listener lives in `client/src/components/GithubSignInModal.svelte` (line ~23), **not** `app.ts` — `app.ts` only does `window.open(...)`. So `drive-files.ts` registers **its own** listener at module load (mirrors what `GithubSignInModal` does for GitHub), and does not touch `app.ts`:

```ts
window.addEventListener("message", (e) => {
  if (e.origin !== location.origin || !e.data || e.data.type !== "mde-google-auth") return;
  if (e.data.ok) {
    driveConnected.set(true);
    window.MDE.onGoogleAuthComplete?.();
  }
});
```

(`connectGoogleDrive` opens `window.open("/api/auth/google/connect", "google-oauth", …)` — same window-features string `app.ts` uses for the GitHub popup.)

- [x] **Step 5: Run** — `npx vitest run tests/client/src/drive-files.test.ts && npm run typecheck` → PASS.

- [x] **Step 6: Commit**

```bash
git add client/src/drive-files.ts client/src/main.ts client/src/app.ts tests/client/src/drive-files.test.ts
git commit -m "$(cat <<'EOF'
feat(drive): connect / disconnect Google Drive from the client

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: `client/src/drive-files.ts` — Picker load + `importMarkdownFromDrive`

**Files:** Modify `client/src/drive-files.ts`, `tests/client/src/drive-files.test.ts`

**Interfaces produced:** `window.MDE.importMarkdownFromDrive: () => Promise<void>` — opens the Picker (connecting first if needed), imports the picked `.md` files into the current workspace via `createDoc`, toasts a summary.

- [x] **Step 1: Failing test** — append to `tests/client/src/drive-files.test.ts`. Stub the Picker so the test drives its callback directly:

```ts
import { docsStore, activeIdStore } from "../../../client/src/stores/docs";
import { workspacesStore } from "../../../client/src/stores/workspaces";

it("importMarkdownFromDrive creates docs in the current workspace from the picked files", async () => {
  workspacesStore.set([{ id: "w1", name: "WS", createdAt: 0, updatedAt: 0 }]);
  docsStore.set([]);
  activeIdStore.set(null);
  driveConnected.set(true);

  // stub the Picker: importMarkdownFromDrive calls loadPicker() then
  // openPicker(token, apiKey, onPicked) — we make openPicker immediately
  // invoke onPicked with two files.
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).includes("/picker-token")) return new Response(JSON.stringify({ token: "t", apiKey: "k" }), { status: 200 });
    if (String(url).includes("/api/drive/import")) {
      return new Response(JSON.stringify({ results: [
        { fileId: "a", name: "Todo.md", contentBase64: btoa("# Todo\n- x"), ok: true },
        { fileId: "b", name: "Ideas.md", contentBase64: btoa("# Ideas"), ok: true },
      ] }), { status: 200 });
    }
    return new Response("?", { status: 404 });
  }));

  const mod = await import("../../../client/src/drive-files");
  (mod as any).__setPickerForTest?.((_t: string, _k: string, onPicked: (f: {id:string;name:string}[]) => void) =>
    onPicked([{ id: "a", name: "Todo.md" }, { id: "b", name: "Ideas.md" }]));

  await (window as any).MDE.importMarkdownFromDrive();

  const docs = get(docsStore);
  expect(docs.map((d) => d.name).sort()).toEqual(["Ideas", "Todo"]);
  expect(docs.find((d) => d.name === "Todo")!.content).toBe("# Todo\n- x");
  expect(docs.every((d) => d.workspaceId === "w1")).toBe(true);
  vi.unstubAllGlobals();
});
```

- [x] **Step 2: Implement** — append to `client/src/drive-files.ts`:

```ts
import { get } from "svelte/store";
import { workspacesStore } from "./stores/workspaces";
import { createDoc } from "./stores/docs";
import { showToast } from "./stores/toast";

window.MDE.importMarkdownFromDrive = importMarkdownFromDrive;

// ---- Picker loading (client-side Google widget) ----
// Injected so tests can bypass the real Google iframe. Signature:
// (oauthToken, apiKey, onPicked) => void, where onPicked gets [{id,name}].
type OpenPicker = (token: string, apiKey: string, onPicked: (files: { id: string; name: string }[]) => void) => void;
let openPickerImpl: OpenPicker | null = null;

/** @internal test seam */
export function __setPickerForTest(fn: OpenPicker | null): void {
  openPickerImpl = fn;
}

const GAPI_SRC = "https://apis.google.com/js/api.js";
let gapiLoad: Promise<void> | null = null;

function loadGapi(): Promise<void> {
  if (gapiLoad) return gapiLoad;
  gapiLoad = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = GAPI_SRC;
    s.onload = () => (window as any).gapi.load("picker", { callback: () => resolve() });
    s.onerror = () => reject(new Error("Couldn't load the Google Picker"));
    document.head.appendChild(s);
  });
  return gapiLoad;
}

async function openPicker(token: string, apiKey: string, onPicked: (files: { id: string; name: string }[]) => void): Promise<void> {
  if (openPickerImpl) return openPickerImpl(token, apiKey, onPicked);
  await loadGapi();
  const google = (window as any).google;
  const view = new google.picker.DocsView(google.picker.ViewId.DOCS)
    .setMode(google.picker.DocsViewMode.LIST)
    .setSelectFolderEnabled(false)
    // loose MIME hint — the import step re-checks each file's name and
    // skips anything that isn't markdown-ish.
    .setMimeTypes("text/markdown,text/plain,text/x-markdown");
  const picker = new google.picker.PickerBuilder()
    .setOAuthToken(token)
    .setDeveloperKey(apiKey)
    .addView(view)
    .enableFeature(google.picker.Feature.MULTISELECT_ENABLED)
    .setTitle("Choose markdown files to import")
    .setCallback((data: any) => {
      if (data.action !== google.picker.Action.PICKED) return;
      onPicked((data.docs || []).map((d: any) => ({ id: d.id, name: d.name })));
    })
    .build();
  picker.setVisible(true);
}

function isMarkdownName(name: string): boolean {
  return /\.(md|markdown|mdown|mkd|txt)$/i.test(name);
}
function stripExt(name: string): string {
  return name.replace(/\.[^.]+$/, "") || name;
}
function decodeB64(b64: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

async function importMarkdownFromDrive(): Promise<void> {
  if (get(workspacesStore).length === 0) {
    showToast("Create a workspace first", "error");
    return;
  }
  const tokRes = await fetch("/api/auth/google/picker-token");
  if (tokRes.status === 401) {
    window.MDE.connectGoogleDrive?.(); // connect, then the user re-runs
    return;
  }
  if (!tokRes.ok) {
    showToast("Google Drive isn't available right now", "error");
    return;
  }
  const { token, apiKey } = await tokRes.json();

  await openPicker(token, apiKey, async (files) => {
    const wanted = files.filter((f) => isMarkdownName(f.name));
    const skipped = files.filter((f) => !isMarkdownName(f.name));
    if (wanted.length === 0) {
      if (skipped.length) showToast(`Nothing imported — ${skipped.length} file(s) weren't markdown`, "error");
      return;
    }
    driveImportBusyLabel.set("Importing…");
    try {
      const res = await fetch("/api/drive/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileIds: wanted.map((f) => f.id) }),
      });
      if (!res.ok) throw new Error(`import ${res.status}`);
      const { results } = (await res.json()) as { results: { name: string; contentBase64: string; ok: boolean }[] };
      let imported = 0;
      let unresolvedImages = 0;
      for (const r of results) {
        if (!r.ok) continue;
        const content = decodeB64(r.contentBase64);
        // count image refs that won't resolve (no doc.images on an import)
        for (const m of content.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)) {
          if (!/^(https?:|data:)/.test(m[1]!)) unresolvedImages++;
        }
        createDoc({ name: stripExt(r.name), content });
        imported++;
      }
      const failed = results.length - results.filter((r) => r.ok).length;
      let msg = `Imported ${imported} file${imported === 1 ? "" : "s"} from Drive`;
      if (failed) msg += `, ${failed} failed`;
      if (skipped.length) msg += `; ${skipped.length} non-markdown skipped`;
      if (unresolvedImages) msg += `. ${unresolvedImages} image reference${unresolvedImages === 1 ? "" : "s"} won't resolve`;
      showToast(msg, failed || unresolvedImages ? "info" : "success");
    } catch (err) {
      showToast(`Import failed: ${(err as Error).message}`, "error");
    } finally {
      driveImportBusyLabel.set(null);
    }
  });
}
```

Verify `createDoc`'s signature accepts `{ name, content }` — it does (`createDoc(partial?: Partial<Doc> & { id?; name? })`, and it activates the new doc in the current workspace).

- [x] **Step 3: Run** — `npx vitest run tests/client/src/drive-files.test.ts && npm run typecheck` → PASS.

- [x] **Step 4: Commit**

```bash
git add client/src/drive-files.ts tests/client/src/drive-files.test.ts
git commit -m "$(cat <<'EOF'
feat(drive): Open markdown from Drive — Google Picker import

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: `MenuBar.svelte` — File > Open > Markdown from Google Drive

**Files:** Modify `client/src/components/MenuBar.svelte`; Test `tests/client/src/components/MenuBar.test.ts`

- [x] **Step 1: Add the menu item**

Find the `#menuOpenGist` button (the `From GitHub Gist...` row in the Open submenu). Add directly after it:

```svelte
          <button
            id="menuOpenDrive"
            type="button"
            hidden={!$driveConnected && !driveConfigured}
            onclick={() => act(() => window.MDE.importMarkdownFromDrive?.())}
          >
            <svg class="icon"><use href="#icon-drive"></use></svg> Markdown from Google Drive...
          </button>
```

At the top of the `<script>`: `import { driveConnected } from "../stores/driveSync";`. For `driveConfigured` — the simplest signal is "the status endpoint didn't 503"; add a `driveConfigured` writable to `stores/driveSync.ts` (default `true`, set `false` by `drive-files.ts` `checkSession` if `/api/auth/google/status` returns 503) and import it. If that's more than a one-liner, instead just gate on `$driveConnected` and always show the item when disconnected (clicking it runs `connectGoogleDrive` first via the picker-token 401 path) — pick whichever is cleaner when implementing; the item must not appear at all when the whole feature is unconfigured.

Add `#icon-drive` to the sprite sheet (`client/public/icons.svg` or wherever `#icon-github` lives) — a simple Drive-triangle or cloud-arrow path. Reuse `#icon-cloud`/`#icon-download` if one exists and a dedicated mark isn't worth it (open question 3 in the spec — decide here, note it in the commit).

- [x] **Step 2: Component test** — add to `tests/client/src/components/MenuBar.test.ts` (or create it):

```ts
it("shows 'Markdown from Google Drive' in the Open submenu when Drive is connected", async () => {
  driveConnected.set(true);
  const screen = await render(MenuBar, /* existing props pattern */);
  await screen.getByText("File").click();
  // open the Open submenu per the existing test's pattern
  await expect.element(screen.getByText(/Markdown from Google Drive/)).toBeVisible();
});
```

Match the file's existing render/props/interaction pattern (check how it tests `#menuOpenGist`).

- [x] **Step 3: Run** — `npx vitest run --project=components tests/client/src/components/MenuBar.test.ts && npm run typecheck` → PASS.

- [x] **Step 4: Commit**

```bash
git add client/src/components/MenuBar.svelte client/public/icons.svg tests/client/src/components/MenuBar.test.ts
git commit -m "$(cat <<'EOF'
feat(drive): File > Open > Markdown from Google Drive menu item

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: `Settings.svelte` Connections row + `CONTRIBUTING.md`

**Files:** Modify `client/src/components/Settings.svelte`, `CONTRIBUTING.md`; Test `tests/client/src/components/Settings.test.ts`

- [x] **Step 1: Settings row**

`Settings.svelte` is opened from the topbar account menu via the `settingsModalOpen` store (v1.56.0) — no code change needed for that; the modal is already mounted. Find where it renders the GitHub sign-in / sign-out control (it uses `githubUsername`) or the analytics-consent toggle, and add a sibling "Google Drive" row in the same section:

```svelte
  <div class="settings-row">
    <span>Google Drive</span>
    {#if $driveConnected}
      <button type="button" onclick={() => window.MDE.disconnectGoogleDrive?.()}>Disconnect</button>
    {:else}
      <button type="button" onclick={() => window.MDE.connectGoogleDrive?.()}>Connect</button>
    {/if}
  </div>
```

`import { driveConnected } from "../stores/driveSync";`. Match the existing row markup/classes.

- [x] **Step 2: `CONTRIBUTING.md`** — after the `## GitHub OAuth App (optional, for sign-in/Gist/Share)` section, add:

```markdown
## Google OAuth (optional, for Google Drive)

Drive integration (Open/Save markdown, folder sync) needs a Google Cloud
project. Without it, the Google menu items are hidden and everything else
works — same as GitHub OAuth above.

1. [Google Cloud Console](https://console.cloud.google.com/) → new project
   → **enable the Google Drive API and the Google Picker API**.
2. OAuth consent screen → External → fill the app name / emails → add the
   `.../auth/drive.file` scope → add your Google account as a **test
   user** (keeps the app in "testing" mode; the consent screen just warns
   "unverified" — fine for local dev).
3. Credentials → **OAuth client ID** → Web application → Authorized
   redirect URIs: `http://localhost:8787/api/auth/google/callback`.
4. Credentials → **API key** (for the Picker); optionally restrict it by
   HTTP referrer.
5. Add to your git-ignored `.dev.vars`:
   ```
   GOOGLE_CLIENT_ID=...apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=...
   GOOGLE_API_KEY=...
   ```
   (`GOOGLE_CLIENT_ID` / `GOOGLE_API_KEY` are non-secret; in production
   they're plain `wrangler.jsonc` vars and `GOOGLE_CLIENT_SECRET` is a
   `wrangler secret put`.)
```

- [x] **Step 3: Component test** — add to `tests/client/src/components/Settings.test.ts`:

```ts
it("shows a Google Drive Connect button, switching to Disconnect once connected", async () => {
  driveConnected.set(false);
  const screen = await render(Settings /* + props */);
  await expect.element(screen.getByRole("button", { name: "Connect" })).toBeVisible();
  driveConnected.set(true);
  await expect.element(screen.getByRole("button", { name: "Disconnect" })).toBeVisible();
});
```

- [x] **Step 4: Run** — `npx vitest run --project=components tests/client/src/components/Settings.test.ts && npm run typecheck` → PASS.

- [x] **Step 5: Commit**

```bash
git add client/src/components/Settings.svelte CONTRIBUTING.md tests/client/src/components/Settings.test.ts
git commit -m "$(cat <<'EOF'
feat(drive): Settings connect/disconnect row + CONTRIBUTING setup docs

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 13: Full suite + provisional CHANGELOG + manual check

**Files:** Modify `CHANGELOG.md`

- [x] **Step 1: Provisional CHANGELOG entry**

At the very top of `CHANGELOG.md` (above the current top section):

```markdown
## [1.65.0] - UNRELEASED

### Added

- **Google Drive — Open markdown from Drive.** Connect Google Drive from Settings or File > Open, then pick markdown files from anywhere in your Drive to import them as documents. (Save-to-Drive and full folder sync land in the same release — see the plans.)
```

(`- UNRELEASED` heading + no version bump: this is edited across the Drive plans, then the version/date/whats-new go in on the final plan, per the spec and CLAUDE.md's "don't bump while implementing".)

- [x] **Step 2: Whole suite**

```bash
npm test            # unit + components — all green
npm run typecheck   # both tsconfigs — clean
npm run format:check
```

Fix any formatting with `npm run format` and re-stage.

- [x] **Step 3: Manual verification (needs `.dev.vars` with real Google creds — see the Setup note)**

```bash
npm run build
npx wrangler dev --port 8787   # separate terminal
```

Then in a browser at `http://localhost:8787`:
1. Settings → Google Drive → **Connect** → the Google consent popup appears → approve → popup closes → the button flips to **Disconnect**.
2. Put a couple of `.md` files somewhere in your Drive (via drive.google.com).
3. File → Open → **Markdown from Google Drive…** → the Picker opens → select the files → they appear as new documents in the current workspace with their content.
4. Settings → **Disconnect** → File > Open no longer shows the Drive item (or it prompts to connect).

Note anything that didn't match in the task's PR description.

- [x] **Step 4: Commit + open the PR**

```bash
git add CHANGELOG.md
git commit -m "$(cat <<'EOF'
docs: provisional CHANGELOG entry for Google Drive (plan 1)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
git push -u origin feat/google-drive-plan-1
```

PR against `master`, title `feat(drive): connect Google Drive + open markdown from Drive (plan 1)`, body summarising the connection + import flow, the `drive.file` scope choice, the Picker security note, the CSP additions, the `dev-login.patch` regen, and that this is the first Drive plan toward one `1.65.0` release. **Close the stale PR #172 / branch `feat/google-drive-sync` with a note pointing at this one.** Wait for CI green (`e2e-collab` / `e2e-github` in particular — they apply the regenerated `dev-login.patch`). **Do not merge yet** unless incremental shipping is intended — confirm with the user.

---

## Self-Review

**1. Spec coverage (this plan = the "connection foundation" + "Open markdown from Drive" capability):**
- Spec "src/google-auth.ts (connect / callback / status / disconnect / getGoogleAccessToken / picker-token)" → Tasks 3–6 (picker-token is in `google-drive.ts` per the spec's route table — Task 6).
- Spec "generic encryptJSON/decryptJSON extracted from auth.ts; encryptSession/decryptSession become wrappers" → Task 2.
- Spec "new mde_google_session cookie holding { refreshToken, accessToken, accessTokenExp }" → Task 1 (`GoogleSessionData`), Task 4.
- Spec "refreshes transparently and threads a Set-Cookie back" → Task 4 (`getGoogleAccessToken` return shape), Task 6 (`withCookie`).
- Spec "POST /api/drive/import — from the Picker, server-side download, best-effort per file, 200 overall" → Task 6.
- Spec "GET /api/auth/google/picker-token → { token, apiKey }; security note" → Task 6 (with the note in the code comment).
- Spec "drive-files.ts (Picker import); File > Open > Markdown from Google Drive; docs land in the current workspace; name collisions -2; images left as-is + toast" → Tasks 9–11.
- Spec "Settings 'Connections' section" → Task 12.
- Spec "GOOGLE_API_KEY non-secret; GOOGLE_CLIENT_ID plain var; graceful 503 + hidden menu when unconfigured" → Tasks 1, 7, 11.
- Spec "onGoogleAuthComplete hook parallel to onGithubAuthComplete" → Tasks 8, 9.
- Spec "Picker CSP (open-question 4)" — **the app now HAS a CSP** (`src/csp.ts` `appCsp` per-request nonce + a dev `<meta>`, both since v1.60.3). The original "nothing to do" is stale → **Task 7b** adds `apis.google.com` (`script-src`), `docs.google.com` (`frame-src`), `www.googleapis.com` (`connect-src`) to both, with a `csp.test.ts` assertion.
- `dev-login.patch` breaks when Task 7 grows `src/worker.ts`'s import block → **Task 7c** regenerates it (project memory `project_dev_login_patch_fragility`); `scripts/check-no-dev-login.mjs` stays green.
- Spec "CONTRIBUTING.md Google OAuth setup" → Task 12.
- Deferred to later plans (correctly out of this plan): folder sync (`Workspace.driveLink`, planPull/planPush, `SyncConflictModal`, folder/tree/push endpoints), Save-to-Drive (`Doc.driveExportId`, `/api/drive/export`, the Publish menu row), Version History Drive revisions, `.mde/history` in the folder, the whats-new entry + version bump + `docs/TEST-COVERAGE.md` §15.

**2. Placeholder scan:** Task 11 leaves the `driveConfigured` gating and the icon choice as "decide when implementing, here's the fallback" — bounded, with the fallback spelled out, not a TODO. Every code step has real code. No "add error handling" hand-waving (each endpoint's error paths are in the code and asserted in a test).

**3. Type consistency:**
- `getGoogleAccessToken` returns `{ token: string; setCookie?: string } | null` everywhere it's referenced (Tasks 4, 6).
- `handleDriveImport` response shape `{ results: [{ fileId, name?, contentBase64?, ok, error? }] }` — the test (Task 6 Step 1) and the client consumer (Task 10 `importMarkdownFromDrive`) agree.
- `GoogleSessionData` fields (`refreshToken`/`accessToken`/`accessTokenExp`) identical in Task 1, 4, 5, 6.
- `driveConnected` / `driveImportBusyLabel` — one definition (Task 8), consumed in Tasks 9–12.
- Bridge method names (`connectGoogleDrive`, `disconnectGoogleDrive`, `importMarkdownFromDrive`, `onGoogleAuthComplete`) identical in `types.ts` (Task 8) and the implementation/consumers (Tasks 9–12).
- Popup message `type: "mde-google-auth"` — set in `popupHtml` (Task 2), matched by `drive-files.ts`'s own `window` `message` listener (Task 9 Step 4 — revised; the GitHub equivalent is in `GithubSignInModal.svelte`, so `app.ts` is not touched).
