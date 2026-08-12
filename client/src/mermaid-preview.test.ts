import { describe, it, expect, vi } from "vitest";
import { mermaidThemeFor, mermaidCodeRenderer } from "./mermaid-preview";

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
});
