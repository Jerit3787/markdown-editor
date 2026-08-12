import { describe, it, expect, vi } from "vitest";
import { mermaidThemeFor, mermaidCodeRenderer, renderMermaidDiagrams, type MermaidLike } from "./mermaid-preview";

describe("mermaidThemeFor", () => {
  it("maps 'dark' to the mermaid dark theme", () => {
    expect(mermaidThemeFor("dark")).toBe("dark");
  });

  it("maps 'light' to the mermaid default theme", () => {
    expect(mermaidThemeFor("light")).toBe("default");
  });

  it("maps null (no data-theme attribute) to the mermaid default theme", () => {
    expect(mermaidThemeFor(null)).toBe("default");
  });

  it("maps any unrecognized value to the mermaid default theme", () => {
    expect(mermaidThemeFor("solarized")).toBe("default");
  });
});

describe("mermaidCodeRenderer", () => {
  it("wraps a mermaid fence in a <pre class=\"mermaid\"> placeholder", () => {
    const defaultRender = vi.fn().mockReturnValue("<pre><code>unused</code></pre>");
    const html = mermaidCodeRenderer("graph TD; A-->B;", "mermaid", false, defaultRender);
    expect(html).toBe('<pre class="mermaid">graph TD; A--&gt;B;</pre>');
    expect(defaultRender).not.toHaveBeenCalled();
  });

  it("treats a language tag with trailing info (e.g. 'mermaid foo=bar') as mermaid", () => {
    const defaultRender = vi.fn().mockReturnValue("unused");
    const html = mermaidCodeRenderer("graph TD;", "mermaid foo=bar", false, defaultRender);
    expect(html).toContain('<pre class="mermaid">');
  });

  it("HTML-escapes mermaid source so raw markup can't break out of the placeholder", () => {
    const defaultRender = vi.fn();
    const html = mermaidCodeRenderer('A["<script>"]', "mermaid", false, defaultRender);
    expect(html).toBe('<pre class="mermaid">A[&quot;&lt;script&gt;&quot;]</pre>');
  });

  it("delegates to defaultRender for any non-mermaid language", () => {
    const defaultRender = vi.fn().mockReturnValue("<pre><code>const x = 1;</code></pre>");
    const html = mermaidCodeRenderer("const x = 1;", "javascript", false, defaultRender);
    expect(defaultRender).toHaveBeenCalledWith("const x = 1;", "javascript", false);
    expect(html).toBe("<pre><code>const x = 1;</code></pre>");
  });

  it("delegates to defaultRender when there's no language at all", () => {
    const defaultRender = vi.fn().mockReturnValue("<pre><code>plain</code></pre>");
    const html = mermaidCodeRenderer("plain", undefined, false, defaultRender);
    expect(defaultRender).toHaveBeenCalledWith("plain", undefined, false);
    expect(html).toBe("<pre><code>plain</code></pre>");
  });

  it("resolves a known ref to its stored source and stamps data-diagram-ref", () => {
    const defaultRender = vi.fn();
    const html = mermaidCodeRenderer("diagram", "mermaid", false, defaultRender, {
      diagram: "flowchart TD\nA-->B",
    });
    expect(html).toBe('<pre class="mermaid" data-diagram-ref="diagram">flowchart TD\nA--&gt;B</pre>');
  });

  it("falls back to treating the fence content as literal source when the ref is unknown", () => {
    const defaultRender = vi.fn();
    const html = mermaidCodeRenderer("graph TD; A-->B;", "mermaid", false, defaultRender, {
      diagram: "flowchart TD\nX-->Y",
    });
    expect(html).toBe('<pre class="mermaid">graph TD; A--&gt;B;</pre>');
  });

  it("falls back to literal content when no diagrams map is passed at all", () => {
    const defaultRender = vi.fn();
    const html = mermaidCodeRenderer("graph TD; A-->B;", "mermaid", false, defaultRender);
    expect(html).toBe('<pre class="mermaid">graph TD; A--&gt;B;</pre>');
  });
});

// @vitest-environment jsdom
describe("renderMermaidDiagrams", () => {
  function fakeMermaid(overrides: Partial<MermaidLike> = {}): MermaidLike {
    return {
      initialize: vi.fn(),
      render: vi.fn().mockResolvedValue({ svg: "<svg>diagram</svg>" }),
      ...overrides,
    };
  }

  it("does nothing and never loads mermaid when there are no .mermaid elements", async () => {
    const container = document.createElement("div");
    container.innerHTML = "<p>no diagrams here</p>";
    const loadMermaid = vi.fn();

    await renderMermaidDiagrams(container, "default", loadMermaid);

    expect(loadMermaid).not.toHaveBeenCalled();
  });

  it("initializes mermaid with the given theme and replaces the placeholder with rendered SVG", async () => {
    const container = document.createElement("div");
    container.innerHTML = '<pre class="mermaid">graph TD; A--&gt;B;</pre>';
    const mermaid = fakeMermaid();
    const loadMermaid = vi.fn().mockResolvedValue({ default: mermaid });

    await renderMermaidDiagrams(container, "dark", loadMermaid);

    expect(mermaid.initialize).toHaveBeenCalledWith({ theme: "dark", startOnLoad: false });
    const block = container.querySelector(".mermaid")!;
    expect(block.innerHTML).toBe("<svg>diagram</svg>");
    expect(block.classList.contains("mermaid-rendered")).toBe(true);
    expect(mermaid.render).toHaveBeenCalledWith(expect.any(String), "graph TD; A-->B;");
  });

  it("shows an inline error on that diagram without throwing, leaving the function to resolve", async () => {
    const container = document.createElement("div");
    container.innerHTML = '<pre class="mermaid">not valid mermaid</pre>';
    const mermaid = fakeMermaid({
      render: vi.fn().mockRejectedValue(new Error("Parse error on line 1")),
    });
    const loadMermaid = vi.fn().mockResolvedValue({ default: mermaid });

    await expect(renderMermaidDiagrams(container, "default", loadMermaid)).resolves.toBeUndefined();

    const block = container.querySelector(".mermaid")!;
    expect(block.classList.contains("mermaid-error")).toBe(true);
    expect(block.innerHTML).toContain("Parse error on line 1");
    expect(block.innerHTML).toContain("not valid mermaid");
  });

  it("renders each diagram independently — one failing doesn't affect the others", async () => {
    const container = document.createElement("div");
    container.innerHTML =
      '<pre class="mermaid">bad one</pre><pre class="mermaid">graph TD; A--&gt;B;</pre>';
    const mermaid = fakeMermaid({
      render: vi
        .fn()
        .mockRejectedValueOnce(new Error("boom"))
        .mockResolvedValueOnce({ svg: "<svg>ok</svg>" }),
    });
    const loadMermaid = vi.fn().mockResolvedValue({ default: mermaid });

    await renderMermaidDiagrams(container, "default", loadMermaid);

    const blocks = container.querySelectorAll(".mermaid");
    expect(blocks[0].classList.contains("mermaid-error")).toBe(true);
    expect(blocks[1].classList.contains("mermaid-rendered")).toBe(true);
    expect(blocks[1].innerHTML).toBe("<svg>ok</svg>");
  });

  it("uses a distinct id per diagram, even across multiple elements", async () => {
    const container = document.createElement("div");
    container.innerHTML =
      '<pre class="mermaid">graph TD; A--&gt;B;</pre><pre class="mermaid">graph TD; C--&gt;D;</pre>';
    const mermaid = fakeMermaid();
    const loadMermaid = vi.fn().mockResolvedValue({ default: mermaid });

    await renderMermaidDiagrams(container, "default", loadMermaid);

    const ids = (mermaid.render as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0]);
    expect(new Set(ids).size).toBe(2);
  });

  it("re-rendering an already-rendered element (e.g. on theme change) reuses the original source, not the rendered SVG", async () => {
    const container = document.createElement("div");
    container.innerHTML = '<pre class="mermaid">graph TD; A--&gt;B;</pre>';
    const mermaid = fakeMermaid();
    const loadMermaid = vi.fn().mockResolvedValue({ default: mermaid });

    await renderMermaidDiagrams(container, "default", loadMermaid); // first render: block now contains SVG
    await renderMermaidDiagrams(container, "dark", loadMermaid); // second render: same element, different theme

    const sourcesPassed = (mermaid.render as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[1]);
    expect(sourcesPassed).toEqual(["graph TD; A-->B;", "graph TD; A-->B;"]);
  });
});
