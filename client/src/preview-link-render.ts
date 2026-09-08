import type { Doc } from "./types";
import { resolveWikilinkTarget } from "./wikilinks";
import { classifyLinkHref, looksLikeExternalDomain, resolveDocRef } from "./doc-link";

export interface RenderLinkDeps {
  docs: Doc[];
  // marked's default link renderer, already bound to the active Renderer.
  renderDefault: (href: string, title: string | null, text: string, tokens: unknown[]) => string;
  escapeHtml: (s: string) => string;
}

const WIKILINK_SCHEME = "wikilink:";

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// marked's default link renderer emits a single predictable
// `<a href="..."[ title="..."]>` opening tag — a targeted insert after
// `<a ` is enough (covered by tests), no HTML parse needed.
export function withBlankTarget(anchorHtml: string): string {
  if (/<a\s[^>]*\btarget=/.test(anchorHtml)) return anchorHtml;
  return anchorHtml.replace(/<a\s/, '<a target="_blank" rel="noopener noreferrer" ');
}

// The whole `renderer.link` decision for the preview. Kept a pure
// function (deps injected) so it is unit-testable without mounting
// Preview.svelte.
export function renderLink(href: string, title: string | null, text: string, tokens: unknown[], deps: RenderLinkDeps): string {
  const { docs, renderDefault, escapeHtml } = deps;

  // [[Name]] links (transformWikilinks rewrites them to this scheme
  // before marked runs).
  if (href.startsWith(WIKILINK_SCHEME)) {
    const name = safeDecode(href.slice(WIKILINK_SCHEME.length));
    const cls = resolveWikilinkTarget(name, docs) ? "wikilink" : "wikilink wikilink-missing";
    return `<a href="#" class="${cls}" data-doc-name="${escapeHtml(name)}">${escapeHtml(text)}</a>`;
  }

  const kind = classifyLinkHref(href);
  if (kind === "doc-ref") {
    const hit = resolveDocRef(href, docs);
    if (hit) {
      // Route through the same click handler as a resolved [[wikilink]].
      return `<a href="#" class="wikilink" data-doc-name="${escapeHtml(hit.name)}">${escapeHtml(text)}</a>`;
    }
    const ref = safeDecode(href).replace(/^\.\//, "");
    if (looksLikeExternalDomain(ref)) {
      return withBlankTarget(renderDefault(`https://${ref}`, title, text, tokens));
    }
    return `<a href="#" class="wikilink wikilink-missing doc-ref-missing" data-doc-ref="${escapeHtml(ref)}" title="No document named &quot;${escapeHtml(ref)}&quot;">${escapeHtml(text)}</a>`;
  }

  if (kind === "external") {
    return withBlankTarget(renderDefault(href, title, text, tokens));
  }

  return renderDefault(href, title, text, tokens); // anchor / absolute
}
