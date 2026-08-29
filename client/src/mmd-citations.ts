import { marked } from "marked";

export interface BibEntry {
  key: string;
  author: string;
  year: string;
  text: string;
}

export interface CitationPrefs {
  markerStyle: "pandoc" | "multimarkdown";
  bibliographySource: "text" | "structured";
  displayStyle: "numbered" | "author-year";
}

export const DEFAULT_CITATION_PREFS: CitationPrefs = { markerStyle: "pandoc", bibliographySource: "text", displayStyle: "numbered" };
export const EMPTY_CITATIONS = { prefs: DEFAULT_CITATION_PREFS, bibliography: [] as BibEntry[] };

// Exported so markdown-compat.ts can flag both marker styles directly,
// rather than a second, independently-drifting pair of regexes.
export const PANDOC_CITATION_RE = /\[@([^\]\s]+)\]/g;
export const MULTIMARKDOWN_CITATION_RE = /\[#([^\]\s]+)\]/g;

const MARKER_RE: Record<CitationPrefs["markerStyle"], RegExp> = { pandoc: PANDOC_CITATION_RE, multimarkdown: MULTIMARKDOWN_CITATION_RE };
const DEFINITION_RE: Record<CitationPrefs["markerStyle"], RegExp> = {
  pandoc: /^\[@([^\]\s]+)\]:[ \t]+(.+)$/gm,
  multimarkdown: /^\[#([^\]\s]+)\]:[ \t]+(.+)$/gm,
};

export function transformCitations(text: string, prefs: CitationPrefs, structuredBibliography: BibEntry[]): string {
  let body = text;
  const pool = new Map<string, BibEntry>();
  if (prefs.bibliographySource === "structured") {
    for (const entry of structuredBibliography) pool.set(entry.key, entry);
  } else {
    body = body.replace(DEFINITION_RE[prefs.markerStyle], (_match, key: string, refText: string) => {
      pool.set(key, { key, author: "", year: "", text: refText.trim() });
      return "";
    });
  }

  const order: string[] = [];
  body = body.replace(MARKER_RE[prefs.markerStyle], (match, key: string) => {
    const entry = pool.get(key);
    if (!entry) return match;
    if (!order.includes(key)) order.push(key);
    if (prefs.displayStyle === "numbered") {
      const n = order.indexOf(key) + 1;
      return `<sup><a href="#cite-${key}">${n}</a></sup>`;
    }
    const label = entry.author && entry.year ? `${entry.author}, ${entry.year}` : entry.author || entry.year || entry.key;
    return `(${label})`;
  });

  if (order.length === 0) return body;

  const cited = order.map((key) => pool.get(key)!);
  if (prefs.displayStyle === "author-year") cited.sort((a, b) => a.author.localeCompare(b.author));
  const items = cited
    .map((entry) =>
      prefs.displayStyle === "numbered"
        ? `<li id="cite-${entry.key}">${marked.parseInline(entry.text)}</li>`
        : `<li id="cite-${entry.key}">${entry.author} (${entry.year}). ${marked.parseInline(entry.text)}</li>`,
    )
    .join("");
  const listTag = prefs.displayStyle === "numbered" ? "ol" : "ul";
  return `${body}\n\n<div class="citation-bibliography"><h2>Bibliography</h2><${listTag}>${items}</${listTag}></div>\n`;
}
