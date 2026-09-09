// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { escapeHtml } from "../../../client/src/escape-html";

describe("escapeHtml (SHELL-16)", () => {
  it("escapes the angle brackets and ampersand that open a tag or entity", () => {
    expect(escapeHtml("<script>alert(1)</script>")).toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(escapeHtml("a & b")).toBe("a &amp; b");
  });

  it("leaves plain text untouched", () => {
    expect(escapeHtml("just some words 123")).toBe("just some words 123");
  });

  it("escapes quotes so an interpolated attribute value can't break out", () => {
    expect(escapeHtml('" onerror="alert(1)')).toBe("&quot; onerror=&quot;alert(1)");
    expect(escapeHtml("it's")).toBe("it&#39;s");
  });

  it("is idempotent-safe: an already-escaped string re-escapes its ampersands", () => {
    expect(escapeHtml("&lt;")).toBe("&amp;lt;");
  });

  it("returns an empty string for an empty input", () => {
    expect(escapeHtml("")).toBe("");
  });
});
