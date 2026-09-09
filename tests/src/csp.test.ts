import { describe, it, expect } from "vitest";
import { generateNonce, appCsp, legalCsp } from "../../src/csp";

describe("generateNonce", () => {
  it("returns a base64 string that decodes to 16 bytes", () => {
    const n = generateNonce();
    expect(typeof n).toBe("string");
    expect(n.length).toBeGreaterThan(0);
    expect(atob(n).length).toBe(16);
  });

  it("returns a different value on each call", () => {
    const seen = new Set(Array.from({ length: 50 }, () => generateNonce()));
    expect(seen.size).toBe(50);
  });
});

describe("appCsp", () => {
  const nonce = "TESTNONCEtestnonce123456==";
  const csp = appCsp(nonce);

  it("puts the nonce in script-src", () => {
    expect(csp).toMatch(new RegExp(`script-src [^;]*'nonce-${nonce.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}'`));
  });

  it("keeps every directive the app needs", () => {
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain("img-src 'self' data: blob: https:");
    expect(csp).toContain("font-src 'self' data:");
    expect(csp).toContain("frame-src https://challenges.cloudflare.com");
    expect(csp).toContain("worker-src 'self' blob:");
    expect(csp).toContain("manifest-src 'self'");
    expect(csp).toContain("form-action 'self'");
  });

  it("keeps the GA + Turnstile allowlist alongside the nonce", () => {
    expect(csp).toMatch(/script-src [^;]*https:\/\/challenges\.cloudflare\.com/);
    expect(csp).toMatch(/script-src [^;]*https:\/\/www\.googletagmanager\.com/);
    expect(csp).toContain("https://*.google-analytics.com");
    expect(csp).toContain("https://*.analytics.google.com");
  });

  it("never allows unsafe-inline or unsafe-eval in script-src", () => {
    const scriptSrc = csp.split(";").find((d) => d.trim().startsWith("script-src"))!;
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(scriptSrc).not.toContain("'unsafe-eval'");
  });

  it("is a single line and stable for a given nonce", () => {
    expect(csp).not.toContain("\n");
    expect(appCsp(nonce)).toBe(csp);
  });
});

describe("legalCsp", () => {
  const nonce = "LEGALNONCElegalnonce9876==";
  const csp = legalCsp(nonce);

  it("is default-src 'none' with only the nonce in script-src", () => {
    expect(csp.startsWith("default-src 'none'")).toBe(true);
    const scriptSrc = csp
      .split(";")
      .find((d) => d.trim().startsWith("script-src"))!
      .trim();
    expect(scriptSrc).toBe(`script-src 'nonce-${nonce}'`);
  });

  it("locks base-uri and form-action down", () => {
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'none'");
  });
});
