import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";

const root = resolve(__dirname, "../../..");
const indexHtml = readFileSync(resolve(root, "client/index.html"), "utf8");
const headersFile = readFileSync(resolve(root, "client/public/_headers"), "utf8");

function metaCsp(html: string): string {
  const m = html.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([\s\S]+?)"\s*\/?>/i);
  if (!m) throw new Error("no CSP <meta> found");
  return m[1]!.replace(/\s+/g, " ").trim();
}

function headerValue(headers: string, name: string): string | null {
  const m = headers.match(new RegExp(`^\\s{2}${name}:\\s*(.+)$`, "im"));
  return m ? m[1]!.trim() : null;
}

describe("app Content-Security-Policy", () => {
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
    expect(csp).toContain("worker-src 'self' blob:");
    expect(csp).toContain("upgrade-insecure-requests");
    // the belt-and-braces items that block whole attack classes
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
  });

  it("allows the one inline script by its current hash", () => {
    const scripts = [...indexHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    expect(scripts).toHaveLength(1);
    const hash = createHash("sha256").update(scripts[0]![1]!, "utf8").digest("base64");
    expect(csp).toContain(`'sha256-${hash}'`);
  });

  it("the _headers file's CSP is byte-identical to the <meta>", () => {
    expect(headerValue(headersFile, "Content-Security-Policy")).toBe(csp);
  });

  it("_headers carries the companion security headers", () => {
    expect(headerValue(headersFile, "X-Frame-Options")).toBe("DENY");
    expect(headerValue(headersFile, "X-Content-Type-Options")).toBe("nosniff");
    expect(headerValue(headersFile, "Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(headerValue(headersFile, "Permissions-Policy")).toContain("camera=()");
    expect(headerValue(headersFile, "Cross-Origin-Opener-Policy")).toBe("same-origin");
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
