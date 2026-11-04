// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { previewHtmlForExport, previewTextForExport } from "../../../client/src/export-text";

function preview(): HTMLElement {
  const el = document.createElement("div");
  el.innerHTML = `
    <h1>Title</h1>
    <p>Before <span class="katex"><span class="katex-mathml"><math><semantics><annotation encoding="application/x-tex">x^2</annotation></semantics></math></span><span class="katex-html" aria-hidden="true">x2</span></span> after</p>
    <pre class="mermaid">A<button type="button" class="mermaid-edit-btn">Edit</button></pre>
    <p>Note<a data-footnote-backref>↩</a></p>
    <p class="focus-dim">Dimmed on screen</p>
  `;
  document.body.appendChild(el);
  return el;
}

describe("previewHtmlForExport", () => {
  it("removes app-only diagram controls but keeps the rendered content", () => {
    const html = previewHtmlForExport(preview());
    expect(html).not.toContain("mermaid-edit-btn");
    expect(html).not.toContain(">Edit<");
    expect(html).toContain("katex");
    expect(html).toContain("Dimmed on screen");
    expect(html).not.toContain("focus-dim");
    document.body.innerHTML = "";
  });
});

describe("previewTextForExport", () => {
  it("strips app-only controls and duplicate KaTeX text", () => {
    const text = previewTextForExport(preview());
    expect(text).not.toContain("Edit");
    expect(text).not.toContain("↩");
    expect(text).toContain("x^2");
    expect(text).toContain("Dimmed on screen");
    // The visual KaTeX HTML duplicate ("x2") must not survive alongside
    // the TeX annotation.
    expect(text).not.toContain("x2");
    document.body.innerHTML = "";
  });

  it("does not leave the measuring clone in the document", () => {
    const el = preview();
    previewTextForExport(el);
    expect(document.querySelectorAll("#preview").length).toBe(0);
    document.body.innerHTML = "";
  });
});
