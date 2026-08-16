// A one-shot, read-only render of a historical version's content for the
// Version History overlay (see VersionHistory.svelte). Deliberately not
// app.ts's updatePreview() itself: that function also handles incremental
// re-render optimization (preserving already-rendered diagrams across
// re-renders) and scroll-sync line tagging, both meaningless here since
// this renders once per version selection, not on every keystroke. The
// underlying rendering building blocks (mermaidCodeRenderer,
// renderMermaidDiagrams, extractMathSpans, renderMathPlaceholders) are
// exactly the same ones updatePreview() uses, so a historical version's
// diagrams/math/images render identically to how they'd render live.
import { marked } from "marked";
import DOMPurify from "dompurify";
import { mermaidCodeRenderer, mermaidThemeFor, renderMermaidDiagrams } from "./mermaid-preview";
import { extractMathSpans, renderMathPlaceholders } from "./math-preview";
import type { Doc } from "./types";

// Kept local rather than imported from app.ts: app.ts's own escapeHtml is
// private to its closure, and this module needs to stay importable on its
// own — same reasoning mermaid-preview.ts's own local copy already uses.
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export async function renderVersionPreview(content: string, doc: Doc | undefined, container: HTMLElement): Promise<void> {
  const renderer = new marked.Renderer();
  // marked 18's renderer overrides take a single token object, not
  // positional args (see app.ts's updatePreview() for the same change,
  // verified against the actual loaded version's marked.d.ts).
  renderer.image = ({ href, title, text }) => {
    const resolved = doc && doc.images && doc.images[href] ? doc.images[href] : href;
    const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
    return `<img src="${escapeHtml(resolved)}" alt="${escapeHtml(text || "")}"${titleAttr}>`;
  };
  const defaultCodeRenderer = marked.Renderer.prototype.code.bind(renderer);
  renderer.code = ({ text, lang, escaped }) =>
    mermaidCodeRenderer(
      text,
      lang,
      !!escaped,
      (code, infostring, esc) => defaultCodeRenderer({ type: "code", raw: code, text: code, lang: infostring, escaped: esc }),
      doc?.diagrams
    );

  const { text: extractedRaw, sources } = extractMathSpans(content);
  const html = marked.parse(extractedRaw, { gfm: true, breaks: false, renderer }) as string;
  const clean = DOMPurify.sanitize(html, {
    ADD_TAGS: ["math", "semantics", "mrow", "mi", "mn", "mo", "msup", "msub", "msubsup", "msqrt", "mroot", "mfrac", "mtable", "mtr", "mtd", "mspace", "mtext", "mstyle", "mover", "munder", "munderover", "mpadded", "annotation"],
    ADD_ATTR: ["target", "mathvariant", "encoding", "xmlns"],
  });
  container.innerHTML = clean;

  const theme = mermaidThemeFor(document.documentElement.getAttribute("data-theme"));
  await renderMermaidDiagrams(container, theme);
  await renderMathPlaceholders(container, sources);
}
