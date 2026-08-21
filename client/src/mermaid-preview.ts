// Kept local rather than reused from app.ts: app.ts's escapeHtml is private
// to its own closure, and this module needs to stay importable/testable on
// its own without pulling in app.ts.
function escapeForHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function mermaidThemeFor(dataTheme: string | null): "default" | "dark" {
  return dataTheme === "dark" ? "dark" : "default";
}

export function mermaidCodeRenderer(
  code: string,
  infostring: string | undefined,
  escaped: boolean,
  defaultRender: (code: string, infostring: string | undefined, escaped: boolean) => string,
  diagrams?: Record<string, string>,
): string {
  const lang = (infostring || "").trim().split(/\s+/)[0];
  if (lang !== "mermaid") return defaultRender(code, infostring, escaped);
  // A fence whose trimmed content matches a known ref renders the stored
  // source (see diagram-refs.ts); otherwise the fence's own content is
  // the literal source — this is what already shipped, so every
  // hand-written ```mermaid fence keeps rendering unchanged.
  const trimmedRef = code.trim();
  const knownSource = diagrams && diagrams[trimmedRef];
  const source = knownSource || code;
  const refAttr = knownSource ? ` data-diagram-ref="${escapeForHtml(trimmedRef)}"` : "";
  // Always HTML-escape here regardless of the `escaped` flag: mermaid reads
  // this element's textContent, which the browser decodes back to the
  // original characters, so escaping is just this placeholder's own HTML
  // safety, independent of what marked's `escaped` flag means upstream.
  return `<pre class="mermaid"${refAttr}>${escapeForHtml(source)}</pre>`;
}

export interface MermaidLike {
  initialize(config: { theme: "default" | "dark"; startOnLoad: boolean; htmlLabels: boolean }): void;
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
  // htmlLabels: false renders diagram text as native SVG <text> instead of
  // <foreignObject>-wrapped HTML. Without this, drawing the rendered SVG
  // onto a <canvas> (for PNG export) throws "Tainted canvases may not be
  // exported" — browsers refuse to read back pixels from a canvas that drew
  // an SVG containing embedded HTML, even same-origin.
  mermaid.initialize({ theme, startOnLoad: false, htmlLabels: false });

  for (const block of blocks) {
    // On a first pass, block.textContent is the raw mermaid source (see
    // mermaidCodeRenderer). On any later pass over this same element (a
    // theme change re-renders in place, without regenerating the preview
    // from source), block's children are already rendered SVG — its
    // textContent would be the SVG's own text, including CSS mermaid
    // embeds in a <style> tag. The original source is cached in a data
    // attribute on first render and read back from there afterward.
    const cachedSource = block.getAttribute("data-mermaid-source");
    const source = cachedSource ?? block.textContent ?? "";
    if (cachedSource === null) block.setAttribute("data-mermaid-source", source);

    // app.ts's updatePreview() re-renders the whole document preview on
    // every keystroke and restores any already-rendered diagram whose
    // source is unchanged (see its own comment) so it never flashes back
    // to raw text — but that restored element still reaches this same
    // .mermaid query on the next debounced pass. Without this check,
    // every diagram in the document would get a full, unnecessary
    // mermaid.render() re-execution on every keystroke anywhere in the
    // doc, purely to reproduce the exact SVG already on screen. Skip that
    // when nothing this function's output could depend on (source, theme)
    // has actually changed since the last successful render.
    if (block.classList.contains("mermaid-rendered") && block.getAttribute("data-mermaid-theme") === theme) {
      continue;
    }

    const id = `mermaid-diagram-${nextDiagramId++}`;
    try {
      const { svg } = await mermaid.render(id, source);
      block.innerHTML = svg;
      block.setAttribute("data-mermaid-theme", theme);
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
