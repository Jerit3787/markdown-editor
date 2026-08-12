// Kept local rather than reused from app.ts: app.ts's escapeHtml is private
// to its own closure, and this module needs to stay importable/testable on
// its own without pulling in app.ts.
function escapeForHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function mermaidThemeFor(dataTheme: string | null): "default" | "dark" {
  return dataTheme === "dark" ? "dark" : "default";
}

export function mermaidCodeRenderer(
  code: string,
  infostring: string | undefined,
  escaped: boolean,
  defaultRender: (code: string, infostring: string | undefined, escaped: boolean) => string,
): string {
  const lang = (infostring || "").trim().split(/\s+/)[0];
  if (lang !== "mermaid") return defaultRender(code, infostring, escaped);
  // Always HTML-escape here regardless of the `escaped` flag: mermaid reads
  // this element's textContent, which the browser decodes back to the
  // original characters, so escaping is just this placeholder's own HTML
  // safety, independent of what marked's `escaped` flag means upstream.
  return `<pre class="mermaid">${escapeForHtml(code)}</pre>`;
}

export interface MermaidLike {
  initialize(config: { theme: "default" | "dark"; startOnLoad: boolean }): void;
  render(id: string, text: string): Promise<{ svg: string }>;
}

async function loadRealMermaid(): Promise<{ default: MermaidLike }> {
  const mod = await import("mermaid");
  // The real package's type is a strict superset of MermaidLike (this
  // module only ever calls .initialize and .render) — narrowing here keeps
  // this file's public surface independent of mermaid's full API/types.
  return { default: mod.default as unknown as MermaidLike };
}

let nextDiagramId = 0;

export async function renderMermaidDiagrams(
  container: ParentNode,
  theme: "default" | "dark",
  loadMermaid: () => Promise<{ default: MermaidLike }> = loadRealMermaid,
): Promise<void> {
  const blocks = Array.from(container.querySelectorAll(".mermaid"));
  if (blocks.length === 0) return;

  const mermaid = (await loadMermaid()).default;
  mermaid.initialize({ theme, startOnLoad: false });

  for (const block of blocks) {
    const source = block.textContent ?? "";
    const id = `mermaid-diagram-${nextDiagramId++}`;
    try {
      const { svg } = await mermaid.render(id, source);
      block.innerHTML = svg;
      block.classList.remove("mermaid-error");
      block.classList.add("mermaid-rendered");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      block.innerHTML =
        `<div class="mermaid-error-message">Diagram error: ${escapeForHtml(message)}</div>` +
        `<code class="mermaid-error-source">${escapeForHtml(source)}</code>`;
      block.classList.remove("mermaid-rendered");
      block.classList.add("mermaid-error");
    }
  }
}
