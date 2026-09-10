import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { JSDOM } from "jsdom";

const root = resolve(__dirname, "../../..");
const indexHtml = readFileSync(resolve(root, "client/index.html"), "utf8");
const headersFile = readFileSync(resolve(root, "client/public/_headers"), "utf8");

function metaCsp(html: string): string {
  const el = new JSDOM(html).window.document.querySelector('meta[http-equiv="Content-Security-Policy" i]');
  if (!el) throw new Error("no CSP <meta> found");
  return (el.getAttribute("content") ?? "").replace(/\s+/g, " ").trim();
}

// The one attribute-less inline <script> in client/index.html — parsed via
// a real DOM so there is no hand-rolled tag-matching regex.
function inlineScriptBody(html: string): string {
  const scripts = [...new JSDOM(html).window.document.querySelectorAll("script")];
  const inline = scripts.filter((s) => !s.hasAttribute("src") && !s.hasAttribute("type"));
  if (inline.length !== 1) throw new Error(`expected exactly one attribute-less inline <script>, found ${inline.length}`);
  return inline[0]!.textContent ?? "";
}

function headerValue(headers: string, name: string): string | null {
  const m = headers.match(new RegExp(`^\\s{2}${name}:\\s*(.+)$`, "im"));
  return m ? m[1]!.trim() : null;
}

// client/index.html keeps its <meta> CSP as the policy enforced under
// `vite dev` (which runs no Worker). Production strips this <meta> and
// serves a per-request nonce header instead — see src/csp.ts and the
// collab e2e specs. This suite guards the dev policy + the companion
// headers that stay in _headers.
describe("app Content-Security-Policy (dev <meta> policy)", () => {
  const csp = metaCsp(indexHtml);

  it("names every directive the app needs", () => {
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toMatch(/script-src [^;]*'self'/);
    expect(csp).toContain("https://challenges.cloudflare.com");
    expect(csp).toContain("https://www.googletagmanager.com");
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain("img-src 'self' data: blob: https:");
    // `data:` — Vite inlines KaTeX's small fonts (KaTeX_Size3 etc.) as data URIs.
    expect(csp).toContain("font-src 'self' data:");
    expect(csp).toMatch(/connect-src [^;]*'self'/);
    expect(csp).toContain("https://*.google-analytics.com");
    expect(csp).toContain("frame-src https://challenges.cloudflare.com");
    // Google Drive: the Picker loader, the Drive REST API, the Picker iframe.
    expect(csp).toMatch(/script-src [^;]*https:\/\/apis\.google\.com/);
    expect(csp).toMatch(/connect-src [^;]*https:\/\/www\.googleapis\.com/);
    expect(csp).toMatch(/frame-src [^;]*https:\/\/docs\.google\.com/);
    expect(csp).toContain("worker-src 'self' blob:");
    expect(csp).toContain("form-action 'self'");
    // `upgrade-insecure-requests` is deliberately absent: WebKit applies it
    // to http://localhost too (Chromium exempts localhost), breaking
    // `vite dev` / the webkit e2e project. Production is HTTPS-only with no
    // http: resource refs, so the directive would be a no-op there anyway.
    expect(csp).not.toContain("upgrade-insecure-requests");
    // the belt-and-braces items that block whole attack classes
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
  });

  it("allows the one inline script by its current hash", () => {
    const hash = createHash("sha256").update(inlineScriptBody(indexHtml), "utf8").digest("base64");
    expect(csp).toContain(`'sha256-${hash}'`);
  });

  it("the _headers file no longer carries a CSP — the Worker sets it per request", () => {
    expect(headersFile).not.toContain("Content-Security-Policy");
  });

  it("_headers carries the companion security headers", () => {
    expect(headerValue(headersFile, "X-Frame-Options")).toBe("DENY");
    expect(headerValue(headersFile, "X-Content-Type-Options")).toBe("nosniff");
    expect(headerValue(headersFile, "Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(headerValue(headersFile, "Permissions-Policy")).toContain("camera=()");
    // same-origin-allow-popups, not same-origin: the GitHub / Google OAuth
    // popups postMessage their result back to window.opener, which plain
    // `same-origin` severs the moment the popup navigates to the provider.
    // The app uses no crossOriginIsolated-gated APIs, so this costs nothing.
    expect(headerValue(headersFile, "Cross-Origin-Opener-Policy")).toBe("same-origin-allow-popups");
  });

  it("_headers applies the rules to every path", () => {
    expect(headersFile.split("\n")[0]!.trim()).toBe("/*");
  });
});

describe("legal pages Content-Security-Policy", () => {
  const LEGAL_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; font-src 'self'; base-uri 'self'; form-action 'none'";

  for (const page of ["privacy", "terms"]) {
    it(`${page}.html carries the strict standalone CSP`, () => {
      const html = readFileSync(resolve(root, `legal/${page}.html`), "utf8");
      expect(metaCsp(html)).toBe(LEGAL_CSP);
    });
  }
});
