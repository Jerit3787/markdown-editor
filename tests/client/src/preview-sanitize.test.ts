// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from "vitest";
import DOMPurify from "dompurify";

// Mirrors the config + hook Preview.svelte uses for markdown output.
// Guards the reverse-tabnabbing defence: a raw HTML `<a target="_blank">`
// typed straight into the source (which `ADD_ATTR: ["target"]` lets
// through) must always come out with rel="noopener noreferrer".
beforeAll(() => {
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (node.nodeName === "A" && node.getAttribute("target") === "_blank") {
      node.setAttribute("rel", "noopener noreferrer");
    }
  });
});

function clean(html: string): string {
  return DOMPurify.sanitize(html, { ADD_ATTR: ["target", "mathvariant", "encoding", "xmlns"] });
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

  it("leaves a same-tab link untouched", () => {
    const out = clean('<a href="https://ok.example">x</a>');
    expect(out).not.toContain("rel=");
  });
});
