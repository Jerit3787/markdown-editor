# Content-Security-Policy — design

**Status:** approved approach (brainstorm 2026-09-09), design under review
**Roadmap:** `ROADMAP.md` → Deferred considerations → "A Content-Security-Policy — the app has none".
**Ships as:** a patch release (`1.60.2`) — the change is invisible when the allowlist is right, so it is behind-the-scenes hardening: a `CHANGELOG.md` `### Security` entry, **no** What's New entry, no screenshot (per `CLAUDE.md`'s patch rule).

## Goal

Give the app a Content-Security-Policy that blocks injected/inline script and restricts where scripts, styles, frames, images, fonts and network connections may come from — without breaking any current feature (GA, Turnstile, GitHub avatars, markdown images from arbitrary hosts, PDF/HTML/SVG/PNG export, math, diagrams, live collaboration). Add the companion security headers a CSP is normally paired with.

## Why

The app loads third-party script (Google Analytics, Cloudflare Turnstile) and renders user-authored markdown as HTML. DOMPurify sanitises the rendered HTML, but a CSP is defence-in-depth: if a sanitiser bypass or a dependency compromise ever lands executable content in the page, `script-src` without `'unsafe-inline'` stops it running. It also stops the page being framed (clickjacking) and pins every allowed origin so a future contributor adding a script from a new host has to make a deliberate, reviewed change.

## Non-goals / deferred

- **A violation-reporting endpoint** (`report-uri` / `report-to` + a collector). No server-side log sink exists for it and nobody would watch it. `<meta>` CSP cannot carry `report-to` anyway. Browser-console violations during development + the e2e suite are the feedback loop.
- **A nonce-per-response pipeline.** One 3-line inline script does not justify per-request HTML rewriting. Its `sha256` hash goes in the policy instead.
- **Trusted Types** (`require-trusted-types-for 'script'`). A larger, separate hardening step — DOMPurify would need a Trusted Types sink and every `innerHTML` assignment audited.
- **CSP on the JSON API / WebSocket responses.** Those render no document; the Worker's `/api/*` and Durable Object responses are left untouched.
- **Locking `img-src` to an allowlist.** Markdown authors legitimately embed `![](https://any-host/pic.png)`; images cannot execute, so `img-src` stays `https:`-wide.

## Global constraints

- Two `tsconfig.json`s, checked separately. Server code (`src/**`, `tests/src/**`) is full strict.
- The `local` Playwright project (200+ tests) runs against **`vite dev`**, which does **not** process Cloudflare `_headers`. The CSP therefore lives in a `<meta http-equiv>` tag inside `index.html` so the whole local suite runs under it. `_headers` carries only the header-only companions.
- `npm run format` (Prettier) + `npm run typecheck` must pass.
- `client/public/*` is copied verbatim into `client/dist/` by Vite — `client/public/_headers` → `client/dist/_headers`, which Cloudflare Workers Assets (and `wrangler dev`) read.
- `/privacy` and `/terms` are generated from `legal/*.html` by `scripts/generate-legal.mjs` — the CSP `<meta>` for those two goes in the templates.

---

## Part 1 — The policy

A single `<meta http-equiv="Content-Security-Policy" content="…">` placed in `<head>` of `client/index.html`, as early as possible (right after `<meta charset>` / `<meta viewport>`, before any other tag that could trigger a fetch).

```
default-src 'self';
base-uri 'self';
object-src 'none';
script-src 'self' 'sha256-dvrkhVN+dXykZmzU3pQRkYg38F+aYnJ2WXnZwjPgC04=' https://challenges.cloudflare.com https://www.googletagmanager.com;
style-src 'self' 'unsafe-inline';
img-src 'self' data: blob: https:;
font-src 'self' data:;
connect-src 'self' https://challenges.cloudflare.com https://www.googletagmanager.com https://*.google-analytics.com https://*.analytics.google.com;
frame-src https://challenges.cloudflare.com;
worker-src 'self' blob:;
manifest-src 'self';
form-action 'self';
```

Written as one line (no newlines) in the attribute. Rationale per directive:

| Directive | Value | Why |
|---|---|---|
| `default-src` | `'self'` | Backstop for anything not named below (`media-src`, `child-src`, …). |
| `base-uri` | `'self'` | Stops an injected `<base>` from re-pointing every relative URL. |
| `object-src` | `'none'` | No `<embed>`/`<object>`/Flash; pure attack surface removal. |
| `script-src` | `'self'` + one hash + Turnstile + GTM | `'self'` = the built entry bundle + Cloudflare's same-origin `/cdn-cgi/challenge-platform/*` scripts. The hash is the mobile-sidebar inline snippet (see Part 2). `challenges.cloudflare.com` = Turnstile `api.js` and the sub-scripts it pulls. `www.googletagmanager.com` = `gtag/js`. **No `'unsafe-inline'`, no `'unsafe-eval'`** — the built `html2pdf` chunk and app bundle contain neither `eval(` nor `new Function(` (verified); Part 4's e2e confirms the PDF-export path at runtime. |
| `style-src` | `'self' 'unsafe-inline'` | Svelte runtime `style=` attributes, KaTeX, Mermaid's injected `<style>` and inline styles, the app's own `el.style.x =` writes. `'unsafe-inline'` for style is the standard accepted compromise — style injection is low-severity and hash/nonce cannot cover attribute styles. |
| `img-src` | `'self' data: blob: https:` | `data:` = pasted/embedded images stored as data URIs, KaTeX/Mermaid inline SVG data. `blob:` = export object URLs, diagram PNG/SVG export. `https:` = GitHub avatars (`github.com/<user>.png`), the GA pixel fallback, and **any image a markdown author embeds**. |
| `font-src` | `'self' data:` | KaTeX `.woff2` files are bundled to `/assets/`, but Vite's CSS pipeline inlines the *small* ones (`KaTeX_Size3`, …, under 4 KB) as `data:font/woff2` URIs — `data:` covers those. No Google Fonts. |
| `connect-src` | `'self'` + Turnstile + GA wildcards | `'self'` covers every `/api/*` fetch and the same-origin `wss://` collaboration socket. GA4 posts hits to `www.google-analytics.com` **or** a region shard (`region1`–`region6.google-analytics.com` depending on the visitor's geography), and consent-mode uses `*.analytics.google.com` — the two `*.` wildcards cover all of them and stay narrow (only Google Analytics subdomains). Turnstile's widget calls `challenges.cloudflare.com`. |
| `frame-src` | `https://challenges.cloudflare.com` | The only iframe the app renders is Turnstile's. DOMPurify strips author `<iframe>`, so nothing else is needed. |
| `worker-src` | `'self' blob:` | Defensive — no code spawns a Worker today, but a future `blob:`-backed worker (some PDF/image libs) would otherwise be a silent break. |
| `manifest-src` | `'self'` | `/site.webmanifest`. |
| `form-action` | `'self'` | No cross-origin `<form>` posts. The GitHub OAuth start is a Worker `302`, not a form, so this does not interfere. |
| ~~`upgrade-insecure-requests`~~ | *removed* | WebKit applies it to `http://localhost` too (Chromium exempts localhost), breaking `vite dev` / the webkit e2e. Production is HTTPS-only with no `http:` resource refs, so it would be a no-op there. |

**`frame-ancestors` is intentionally absent** — `<meta>` CSP ignores it. Clickjacking protection comes from `X-Frame-Options: DENY` in Part 3.

### `/privacy` and `/terms`

These two pages load **zero** JavaScript and one inline `<style>` block each. Their `<meta>` CSP (added to `legal/privacy.html` and `legal/terms.html`, which `generate-legal.mjs` copies through):

```
default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; font-src 'self'; base-uri 'self'; form-action 'none'
```

Strict — they need nothing external. `img-src 'self'` covers the `<span>Md</span>` brand mark (it is text, but keep the door open for a future `<img>`).

---

## Part 2 — The inline script

`client/index.html` has exactly one inline `<script>` (mid-`<body>`, before `#main`):

```html
<script>
  if (window.matchMedia("(max-width: 780px)").matches) {
    document.getElementById("sidebar").classList.add("collapsed");
  }
</script>
```

It runs synchronously during parse to collapse the sidebar on mobile before first paint (flash-of-expanded-sidebar prevention). It is kept as-is; its exact bytes hash to:

```
sha256-dvrkhVN+dXykZmzU3pQRkYg38F+aYnJ2WXnZwjPgC04=
```

which is listed in `script-src`. The hash is over the text node *between* the `<script>` tags including its surrounding whitespace/newlines exactly as they appear in `client/index.html` — Part 4 has a unit test that recomputes it from the file and fails if the snippet or the policy drifts apart.

If the snippet ever needs to change, the test failure names the new hash to paste in.

---

## Part 3 — `client/public/_headers`

A new file. Cloudflare Workers Assets and `wrangler dev` apply it to every asset response (including the SPA `not_found_handling` fallback that serves `index.html` for `/d/…` routes, and `/privacy` / `/terms`).

```
/*
  X-Frame-Options: DENY
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=(), browsing-topics=()
  Cross-Origin-Opener-Policy: same-origin
```

- `X-Frame-Options: DENY` — the `frame-ancestors` stand-in; the app is never meant to be embedded.
- `X-Content-Type-Options: nosniff` — stops MIME-sniffing a response into script.
- `Referrer-Policy: strict-origin-when-cross-origin` — the browser default on modern Chrome, made explicit for older engines; a shared-link URL never leaks its path to a third-party origin.
- `Permissions-Policy` — the app uses no camera/mic/geolocation; `browsing-topics=()` opts out of the Topics API.
- `Cross-Origin-Opener-Policy: same-origin` — isolates the browsing context group; harmless here and a small XS-Leaks mitigation. **Not** `Cross-Origin-Embedder-Policy` (that would break the cross-origin GA/Turnstile/avatar loads unless every one sent CORP headers).

A **duplicate authoritative `Content-Security-Policy` header** is added here too, identical to the `<meta>` value — so production and `wrangler dev` serve it as a real header (slightly more robust: a header CSP applies before `<meta>` parsing and cannot be stripped by an injected earlier tag). The `<meta>` remains the source that the `vite dev` local suite exercises; a unit test asserts the two strings are byte-identical.

---

## Part 4 — Testing

### Unit — `tests/client/src/csp.test.ts` (new)

- Parse the `<meta http-equiv="Content-Security-Policy">` `content` out of `client/index.html`. Assert it contains each required directive and host from Part 1 (`script-src` has the three sources + a `sha256-`; `connect-src` has the GA hosts; `frame-src` has Turnstile; `object-src 'none'`; `default-src 'self'`).
- Recompute `sha256` of the inline `<script>` body from `client/index.html` and assert `script-src` contains exactly that `'sha256-…'`.
- Read `client/public/_headers`; assert the five header lines are present and that its `Content-Security-Policy:` value equals the `<meta>` `content` string exactly.
- `legal/privacy.html` and `legal/terms.html` each carry the strict `<meta>` CSP.

### e2e — `tests/e2e/local/csp.spec.ts` (new, `local` project → `vite dev`, runs under the `<meta>` CSP)

One spec, several assertions, each failing on any `page.on("console")` message whose text matches `/Content Security Policy|Refused to (load|execute|connect|apply)/i`:

- Load `/`, wait for the editor, type markdown that exercises **inline math** (`$x^2$`), a **`mermaid` fence**, an **`![](https://raw.githubusercontent.com/...png)` image**, and a data-URI image. Assert the preview renders each (`.katex`, `svg` inside the mermaid block, `img[src^="data:"]`) and **no CSP violation was logged**.
- Open every top-bar menu, the Command Palette, Settings, the Share dialog — no violation.
- **Export**: `File ▸ Export ▸ HTML`, `… ▸ Markdown`, `… ▸ PDF` (the PDF path pulls in `html2pdf`); assert a `download` event fires for each and no `eval`/`script` CSP violation surfaces. This is the `'unsafe-eval'` check — if PDF export logs a violation, the finding is "add `'unsafe-eval'` to `script-src` with a comment naming `jspdf`", not a silent failure.
- Assert `document.querySelector('meta[http-equiv="Content-Security-Policy"]')` is present and `getAttribute("content")` starts with `default-src 'self'`.

### e2e — `tests/e2e/collab/*` (existing suite → `wrangler dev`, runs under `_headers`)

- Add to an existing collab spec (or a tiny new one): after `joinSharedWorkspace`, assert the response headers on `/` include `content-security-policy`, `x-frame-options: DENY`, `x-content-type-options: nosniff`. This is the only place the real header path is exercised.
- The Turnstile-disabled collab suite already covers that live sync (`wss://` same-origin) works — `connect-src 'self'` must not break it. If any collab spec starts logging a CSP connect violation, `connect-src` is wrong.

### Manual (documented in the spec, run once before merge)

`VITE_GA_MEASUREMENT_ID=G-… npm run build && npm run dev`, open in a real browser with a real Turnstile site key configured:

- GA `gtag/js` loads, `/g/collect` fires, **no** `script-src` / `connect-src` violation for `googletagmanager.com` / `google-analytics.com`.
- An anonymous share join renders the Turnstile widget (its `challenges.cloudflare.com` iframe) — `frame-src` / `script-src` clean.
- Signed-in: the GitHub avatar in the top bar loads (`img-src https:`).

---

## Part 5 — Rollout & release

- No `Content-Security-Policy-Report-Only` phase. The `<meta>`-in-the-asset choice means the full local suite is the safety net; shipping straight to enforcing is acceptable for a solo project with this coverage. If a violation is found in production after merge, it is a fast follow patch (adjust one host in two files).
- **Version:** patch → `1.60.2`. `package.json` + both `package-lock.json` `"version"` fields.
- `CHANGELOG.md` `## [1.60.2]` → `### Security`: "Added a Content-Security-Policy plus the standard companion headers (`X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, `Cross-Origin-Opener-Policy`). The page now refuses to load script, frames, or network connections from anywhere not on a short allowlist, and cannot be embedded in an iframe. No change to how the app behaves."
- **No** `client/src/whats-new-entries.ts` entry (patch release, no visible behaviour change → no What's New per `CLAUDE.md`).
- `docs/TEST-COVERAGE.md`: new `SHELL-38` row (CSP `<meta>` + `_headers` parity, inline-script hash, no-violation e2e, export path).
- `ROADMAP.md`: tick the "Content-Security-Policy" deferred-considerations line, note it shipped v1.60.2, and record the deferred pieces (reporting endpoint, nonce pipeline, Trusted Types).

## File summary

| File | Change |
|---|---|
| `client/index.html` | Add the `<meta http-equiv="Content-Security-Policy">` in `<head>` |
| `client/public/_headers` | **new** — companion headers + authoritative CSP header |
| `legal/privacy.html`, `legal/terms.html` | Add strict `<meta>` CSP |
| `tests/client/src/csp.test.ts` | **new** — policy/hash/parity unit checks |
| `tests/e2e/local/csp.spec.ts` | **new** — no-violation walkthrough incl. export |
| `tests/e2e/collab/…` | one added header assertion |
| `package.json`, `package-lock.json`, `CHANGELOG.md`, `docs/TEST-COVERAGE.md`, `ROADMAP.md` | `1.60.2` release (no What's New) |

## Open risks

1. **`'unsafe-eval'` for PDF export.** Static analysis says no; Part 4's PDF e2e is the runtime confirmation. If it fails, the fix is one token in `script-src` + a comment — not a redesign.
2. **A stray Google host.** `connect-src` uses `https://*.google-analytics.com` + `https://*.analytics.google.com`, which covers `www.`, every `regionN.`, and consent-mode calls. If GA4 ever calls a host outside those two suffixes (unlikely), a fast-follow patch adds it.
3. **`wrangler dev` `_headers` support.** Assumed present (wrangler ≥ 3.x). The collab-e2e header assertion is what proves it in CI; if `wrangler dev` turns out not to apply `_headers`, that assertion moves to a production smoke check and the unit parity test still guards the file's content.
