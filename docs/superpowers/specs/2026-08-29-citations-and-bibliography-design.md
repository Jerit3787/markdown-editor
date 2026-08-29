# Citations & Bibliography — Design Spec

**IMPROVEMENTS.md Phase 2 item:** "Citations & bibliography — `[#Author2000]`-style citations resolved against a bibliography. Needs its own bibliography data model and UI, split off from the MultiMarkdown syntax support item above as too different in kind to bundle with it."

## Scope

Three independently configurable, **per-document** citation settings, all editable from a new "Citations" section in the Document Info panel:

- **Marker syntax**: `[@key]` (Pandoc/CSL style — confirmed as the recommended default) or `[#key]` (the original MultiMarkdown-style syntax named in the backlog item).
- **Bibliography source**: `text` (entries typed directly in the document as `[@key]: reference text` definition lines, exactly like footnote definitions today) or `structured` (entries edited via form rows in Document Info, stored as structured `Doc` data, and serialized back into real definition-line text on export).
- **Display style**: `numbered` (footnote-style — a citation renders as a small superscript number linking down to the bibliography) or `author-year` (renders inline as `(Smith, 2020)`).

**Confirmed constraint:** `author-year` requires `bibliographySource: "structured"` — it needs real, separately-addressable Author/Year fields to render, which only exist in structured mode (text mode's entries are freeform typed strings with nothing reliably parseable out of them). The UI disables (not hides) the Author-year option whenever source is `text`, and switching source away from `structured` while `author-year` is active silently falls back to `numbered`.

## Goal

Typing `[@key]` (or `[#key]`, depending on the document's marker-syntax setting) renders as a working citation in the live preview — a clickable number or an inline author-year parenthetical — linking to a generated Bibliography section built from whichever entries are actually available (typed in the document, or added via the Document Info UI). The Markdown Compatibility Checker flags citation markers as flavor-specific.

## Non-goals (deferred)

- **No CSL/BibTeX citation-style engine.** `author-year` is one fixed format (`(Author, Year)`), not a picker among APA/MLA/Chicago/etc. — that's a `citation-js`-sized dependency and project of its own.
- **No `.bib`/BibTeX import.**
- **No cross-document bibliography sharing.** Each document's entries are its own; no shared/global reference library.
- **No citation autocomplete.** Typing `[@` doesn't trigger a picker the way `[[` does for wikilinks — a reasonable, independent follow-up item, not bundled here.
- **No import-time detection or promotion.** Opening a document that already contains `[@key]: text` lines just works as `text`-source mode automatically (see Components below — there's nothing to detect, since text mode reads directly from the document body) — there is no attempt to infer citation *preferences* (marker style, display style) from existing content, and no path that promotes existing typed definitions into `structured` mode automatically. A user who wants structured entries adds them via the UI; the two storage modes are not auto-converted between.

## Components

### `client/src/mmd-citations.ts` (new)

Pure preprocessing module, parallel to `mmd-metadata.ts`/`mmd-inline-blocks.ts` — a single transform function called from `Preview.svelte`'s pipeline, alongside the existing definition-list/superscript-subscript transforms.

```ts
export interface BibEntry {
  key: string;    // citation key, e.g. "Smith2020" — no @ or #
  author: string; // e.g. "Smith, J." — empty in text-source mode
  year: string;   // e.g. "2020" — empty in text-source mode
  text: string;   // full formatted reference-list line, e.g. "Smith, J. (2020). Title. Publisher."
}

export interface CitationPrefs {
  markerStyle: "pandoc" | "multimarkdown";
  bibliographySource: "text" | "structured";
  displayStyle: "numbered" | "author-year";
}

export const DEFAULT_CITATION_PREFS: CitationPrefs = { markerStyle: "pandoc", bibliographySource: "text", displayStyle: "numbered" };
export const EMPTY_CITATIONS = { prefs: DEFAULT_CITATION_PREFS, bibliography: [] as BibEntry[] };

// Exported so markdown-compat.ts can flag both marker styles directly,
// rather than a second, independently-drifting pair of regexes — same
// reasoning as mmd-inline-blocks.ts's own exported constants.
export const PANDOC_CITATION_RE = /\[@([^\]\s]+)\]/g;
export const MULTIMARKDOWN_CITATION_RE = /\[#([^\]\s]+)\]/g;

const MARKER_RE: Record<CitationPrefs["markerStyle"], RegExp> = { pandoc: PANDOC_CITATION_RE, multimarkdown: MULTIMARKDOWN_CITATION_RE };
const DEFINITION_RE: Record<CitationPrefs["markerStyle"], RegExp> = {
  pandoc: /^\[@([^\]\s]+)\]:[ \t]+(.+)$/gm,
  multimarkdown: /^\[#([^\]\s]+)\]:[ \t]+(.+)$/gm,
};

export function transformCitations(text: string, prefs: CitationPrefs, structuredBibliography: BibEntry[]): string {
  // 1. Build the available entry pool: structured mode reads it straight from
  // Doc data (no text scanning at all — there's no typed definition-line
  // syntax to strip, since the user manages entries entirely through the UI);
  // text mode scans for "[@key]: reference text" lines (mirroring footnote
  // definitions) and strips them from the body, each becoming a BibEntry with
  // author/year left empty.
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

  // 2. Assign citation order (first appearance) and replace inline markers.
  const order: string[] = [];
  body = body.replace(MARKER_RE[prefs.markerStyle], (match, key: string) => {
    const entry = pool.get(key);
    if (!entry) return match; // unknown key — leave untouched, same as an unresolved wikilink
    if (!order.includes(key)) order.push(key);
    if (prefs.displayStyle === "numbered") {
      const n = order.indexOf(key) + 1;
      return `<sup><a href="#cite-${key}">${n}</a></sup>`;
    }
    const label = entry.author && entry.year ? `${entry.author}, ${entry.year}` : entry.author || entry.year || entry.key;
    return `(${label})`;
  });

  if (order.length === 0) return body;

  // 3. Append the bibliography — only entries actually cited, ordered by
  // first appearance (numbered) or alphabetically by author (author-year).
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
```

(The full file also needs `import { marked } from "marked";` at the top, same as `mmd-inline-blocks.ts`.)

`Preview.svelte`'s pipeline gains one more step, reading the active document's `citations` field:

```ts
const prefs = doc?.citations?.prefs ?? DEFAULT_CITATION_PREFS;
const withCitations = transformCitations(withInlineBlocks, prefs, doc?.citations?.bibliography ?? []);
const html = marked.parse(withCitations, { gfm: true, breaks: false, renderer }) as string;
```

### `client/src/markdown-compat.ts` (modify)

A `"Citation"` flavor-specific flag, added to `scanTextToken`'s regex loop the same way every other inline construct there works, importing and matching **both** `PANDOC_CITATION_RE` and `MULTIMARKDOWN_CITATION_RE` from `mmd-citations.ts` regardless of the active document's own `citations.prefs.markerStyle` — the checker's job is "what syntax appears in this text," not "what this document's current settings expect." A `[@key]: text` definition line in `text`-source mode is *also* flagged (the line's own leading `[@key]` bracket span looks identical to a citation usage to the compat checker's plain lexer, which has no special knowledge of this app's citation-definition convention) — this mirrors the exact, already-accepted precedent for footnote definition lines (`[^label]: text`) flagging twice in the existing test suite.

### `client/src/types.ts` (modify)

```ts
citations?: { prefs: CitationPrefs; bibliography: BibEntry[] };
```

One field (not two), since both parts always travel and sync together as a single unit (see the Y.Doc sync section below).

### `client/src/stores/docs.ts` (modify)

One new setter, mirroring `setActiveDocMetadata` exactly:

```ts
export function setActiveDocCitations(citations: { prefs: CitationPrefs; bibliography: BibEntry[] }) {
  const doc = getActiveDoc();
  if (!doc) return;
  updateDoc(doc.id, { citations });
  persistDocs();
}
```

`syncRemoteDocContent` gains one more optional parameter (`citations?: ...`), applied the same way `metadata` was added alongside `name` in that function.

**No changes to `createDoc()`.** Unlike metadata, there is nothing to parse out of imported content — `text`-source mode reads its definitions live from `doc.content` at render time, so a document imported with existing `[@key]: text` lines already works correctly with zero import-time action, and there's no reasonable "promote to structured" inference to attempt (see Non-goals).

### `client/src/components/DocInfoPanel.svelte` (modify)

New "Citations" section, after Metadata:

- Three controls (each a small set of toggle buttons, matching this panel's existing `Toggletip`/button-row visual language): Marker style, Bibliography source, Display style. The Author-year button is `disabled` whenever source is `text`.
- When source is `structured`: entry rows (Key / Author / Year / Text — four inputs per row instead of Metadata's two), with the same add/remove-row interaction `doc-info-metadata-row` already established. New `.doc-info-citation-row` CSS class, structurally identical to `.doc-info-metadata-row` with one more input.
- When source is `text`: no entry-editing UI shown at all here.

Handlers mirror `updateMetadata`/`addMetadataField`/etc. exactly, calling `setActiveDocCitations` and `window.MDE.onDocCitationsChanged?.(doc.id, citations)`.

### `client/src/types.ts` (`MDEBridge`, modify)

```ts
setDocCitations(id: string, citations: { prefs: CitationPrefs; bibliography: BibEntry[] }): void;
onDocCitationsChanged: ((id: string, citations: { prefs: CitationPrefs; bibliography: BibEntry[] }) => void) | null;
```

### `client/src/app.ts` (modify)

- Bridge method `setDocCitations`, mirroring `setDocMetadata` exactly (guarded on `getActiveDoc()?.id === id`, calls `setActiveDocCitations`).
- `onDocCitationsChanged: null` added next to `onDocMetadataChanged: null`.
- `getResolvedContent()` and `exportAs("md")`: when `doc?.citations?.prefs.bibliographySource === "structured"`, append a synthesized definition-line block (one `[@key]: text` — or `[#key]: text` per the active marker style — per bibliography entry) to the exported content, so the exported file is a valid, self-contained Pandoc/MultiMarkdown document even though the data lived structured inside the app. When source is `text`, nothing extra is needed — the document body already contains the real definition lines.

### `client/src/collab.ts` (modify)

Mirrors every place `metaMap`'s `"metadata"` key was added, with one more parallel key, `"citations"` (JSON-serialized `{ prefs, bibliography }`):

- `seedDocBindingFromEditor`: also seeds `metaMap.set("citations", JSON.stringify(doc.citations ?? EMPTY_CITATIONS))` (using `mmd-citations.ts`'s exported `EMPTY_CITATIONS` constant).
- `metaMap.observe(...)`: a third branch alongside `"name"`/`"metadata"`, parsing and calling `window.MDE.setDocCitations(docId, parsed)`.
- `flushDirtyBackgroundDocs`: reads `binding.metaMap.get("citations")` (JSON-parsed) and passes it into `syncRemoteDocContent`'s new `citations` parameter.
- `window.MDE.onDocCitationsChanged` assigned in `init()`, mirroring `onDocMetadataChanged` exactly.

### `client/src/repo-sync.ts` (modify)

The push-loop call site gains the same structured-mode serialization `app.ts`'s export path uses — when `doc.citations?.prefs.bibliographySource === "structured"`, append the synthesized definition-line block to the content passed into `rewriteImagesForPush`, same as `serializeMetadataBlock` is already layered in there.

### `client/src/styles/_diff-view.scss` (modify)

`.doc-info-citation-row` (four-input variant of `.doc-info-metadata-row`) plus `.citation-bibliography` (the rendered preview block: a small heading + list, minimal styling consistent with how footnotes render today).

## Testing

- `tests/client/src/mmd-citations.test.ts` (new, unit): one test per marker style × display style combination for the happy path; text-mode definition-line stripping; an unknown citation key left untouched; multiple citations of the same key reuse the same number; author-year sorts the bibliography alphabetically while numbered preserves first-appearance order; an author-year entry with only one of author/year renders just that value, and one with both blank falls back to `(key)`; only cited entries appear in the generated bibliography (an unused `structured` entry is silently omitted).
- `tests/client/src/markdown-compat.test.ts` (extend): both marker styles flag `"Citation"`.
- `tests/client/src/stores/docs.test.ts` (extend): `setActiveDocCitations` updates and persists.
- `tests/client/src/collab.test.ts` (extend): seeding and remote-change tests for the `"citations"` key, mirroring the existing `"metadata"` key tests exactly.
- `tests/client/src/repo-sync.test.ts` (extend): a `structured`-mode doc's pushed content includes the synthesized definition lines.
- `tests/client/src/components/DocInfoPanel.test.ts` (extend): the Citations section's preference toggles and entry rows; Author-year is disabled when source is `text`.
- `tests/e2e/local/mmd-citations.spec.ts` (new): typing `[@key]` plus a `[@key]: text` definition line renders a numbered citation and a Bibliography section in the preview; switching preferences (via Document Info) and adding a structured entry round-trips through `.md` export as real definition-line text.
