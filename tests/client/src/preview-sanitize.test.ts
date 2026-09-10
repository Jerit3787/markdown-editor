// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from "vitest";
import DOMPurify from "dompurify";

// Mirrors the config + hook Preview.svelte uses for markdown output.
// Guards the reverse-tabnabbing defence: a raw HTML `<a target="_blank">`
// typed straight into the source (which `ADD_ATTR: ["target"]` lets
// through) must always come out with rel="noopener noreferrer".
beforeAll(() => {
  // Kept byte-identical to Preview.svelte's hook.
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (node.nodeName.toUpperCase() !== "A") return;
    const target = node.getAttribute("target")?.trim().toLowerCase();
    const rel = node.getAttribute("rel")?.toLowerCase() ?? "";
    if (target === "_blank" || rel.split(/\s+/).includes("opener")) {
      node.setAttribute("rel", "noopener noreferrer");
    }
  });
});

// Same call shape Preview.svelte uses. DOMPurify allows the SVG tag set
// by default (no USE_PROFILES needed), so an <svg><a> round-trips too.
function clean(html: string): string {
  return DOMPurify.sanitize(html, {
    ADD_TAGS: ["math", "semantics", "mrow", "mi", "mn", "mo", "annotation"],
    ADD_ATTR: ["target", "mathvariant", "encoding", "xmlns"],
  });
}

describe("Preview raw-HTML anchor hardening", () => {
  it("forces rel=noopener noreferrer on a raw target=_blank anchor with no rel", () => {
    const out = clean('<a href="https://evil.example" target="_blank">x</a>');
    expect(out).toContain('rel="noopener noreferrer"');
    expect(out).toContain('target="_blank"');
  });

  it("overrides an author-supplied rel=opener", () => {
    const out = clean('<a href="https://evil.example" target="_blank" rel="opener">x</a>');
    expect(out).toContain('rel="noopener noreferrer"');
    expect(out).not.toContain('rel="opener"');
  });

  it("catches a case-variant target=_BLANK (browsers match it case-insensitively) — MDE-26", () => {
    const out = clean('<a href="https://evil.example" target="_BLANK">x</a>');
    expect(out).toContain('rel="noopener noreferrer"');
  });

  it("catches an uppercase rel=OPENER — MDE-26", () => {
    const out = clean('<a href="https://evil.example" target="_self" rel="OPENER">x</a>');
    expect(out).toContain('rel="noopener noreferrer"');
  });

  it("hardens an SVG anchor, whose nodeName is lowercase 'a' — MDE-26", () => {
    const out = clean('<svg><a href="https://evil.example" target="_blank"><text>x</text></a></svg>');
    expect(out).toContain('rel="noopener noreferrer"');
  });

  it("leaves a same-tab link untouched", () => {
    const out = clean('<a href="https://ok.example">x</a>');
    expect(out).not.toContain("rel=");
  });
});
