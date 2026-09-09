// Escapes the five HTML-significant characters. `"` and `'` matter
// because callers interpolate the result into double- or single-quoted
// attribute values (preview-link-render.ts's data-doc-name / title), not
// just element text — the old textContent→innerHTML round-trip left
// quotes intact, which allowed an attribute breakout before DOMPurify
// re-parsed the markup.
const ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(str: string): string {
  return String(str).replace(/[&<>"']/g, (c) => ENTITIES[c]!);
}
