import { describe, it, expect } from "vitest";
import { renderLink, withBlankTarget, type RenderLinkDeps } from "../../../client/src/preview-link-render";
import type { Doc } from "../../../client/src/types";

const doc = (over: Partial<Doc>): Doc => ({ id: "x", name: "N", content: "", updatedAt: 0, createdAt: 0, workspaceId: "w", ...over });
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const renderDefault = (href: string, _t: string | null, text: string) => `<a href="${esc(href)}">${text}</a>`;
const deps = (docs: Doc[]): RenderLinkDeps => ({ docs, renderDefault, escapeHtml: esc });

describe("withBlankTarget", () => {
  it("adds target+rel to a bare anchor", () => {
    expect(withBlankTarget('<a href="https://x.com">x</a>')).toBe('<a target="_blank" rel="noopener noreferrer" href="https://x.com">x</a>');
  });
  it("leaves an anchor that already has target alone", () => {
    const html = '<a target="_self" href="x">x</a>';
    expect(withBlankTarget(html)).toBe(html);
  });
});

describe("renderLink", () => {
  it("wikilink: scheme, resolved -> .wikilink with data-doc-name", () => {
    const out = renderLink("wikilink:Recipes", null, "Recipes", [], deps([doc({ name: "Recipes" })]));
    expect(out).toBe('<a href="#" class="wikilink" data-doc-name="Recipes">Recipes</a>');
  });
  it("wikilink: scheme, unresolved -> .wikilink-missing", () => {
    const out = renderLink("wikilink:Ghost", null, "Ghost", [], deps([]));
    expect(out).toContain('class="wikilink wikilink-missing"');
  });
  it("doc-ref that resolves -> .wikilink with the RESOLVED name", () => {
    const out = renderLink("api.md", null, "the API", [], deps([doc({ id: "2", name: "API", repoPath: "api.md" })]));
    expect(out).toBe('<a href="#" class="wikilink" data-doc-name="API">the API</a>');
  });
  it("doc-ref, no doc, domain-like -> external https:// in a new tab", () => {
    const out = renderLink("example.com", null, "site", [], deps([]));
    expect(out).toBe('<a target="_blank" rel="noopener noreferrer" href="https://example.com">site</a>');
  });
  it("doc-ref, no doc, not domain-like -> .doc-ref-missing, no data-doc-name", () => {
    const out = renderLink("Some Draft", null, "draft", [], deps([]));
    expect(out).toContain('class="wikilink wikilink-missing doc-ref-missing"');
    expect(out).toContain('data-doc-ref="Some Draft"');
    expect(out).toContain('title="No document named &quot;Some Draft&quot;"');
    expect(out).not.toContain("data-doc-name");
  });
  it("real external link -> default renderer + target", () => {
    const out = renderLink("https://example.com/a", "t", "x", [], deps([]));
    expect(out).toBe('<a target="_blank" rel="noopener noreferrer" href="https://example.com/a">x</a>');
  });
  it("anchor and absolute -> untouched default renderer", () => {
    expect(renderLink("#top", null, "top", [], deps([]))).toBe('<a href="#top">top</a>');
    expect(renderLink("/x.png", null, "img", [], deps([]))).toBe('<a href="/x.png">img</a>');
  });
  it("escapes the link text and the ref", () => {
    const out = renderLink("a<b>", null, "<script>", [], deps([]));
    expect(out).toContain("&lt;script&gt;");
    expect(out).toContain('data-doc-ref="a&lt;b&gt;"');
  });
});
