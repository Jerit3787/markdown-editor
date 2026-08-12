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
