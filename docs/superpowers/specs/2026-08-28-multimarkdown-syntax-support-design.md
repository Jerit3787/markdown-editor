# MultiMarkdown Syntax Support — Design Spec

**IMPROVEMENTS.md Phase 2 item:** "MultiMarkdown syntax support."

## Scope decomposition

MultiMarkdown's dialect is large (metadata, definition lists, superscript/subscript,
citations & bibliography, cross-references, table captions, abbreviations, and more).
Confirmed with the user: this spec covers three pieces —

- **Definition lists** (`Term` / `: Definition`)
- **Superscript & subscript** (`2^10^`, `H~2~O`)
- **Document metadata** (Title/Author/etc.), reworked from MultiMarkdown's own inline
  text-block convention into a structured, UI-edited document field (see below) —
  still round-trips as a real `Key: Value` block on import/export, so files stay
  interoperable with tools that expect it inline

**Citations & bibliography** is explicitly out of scope — confirmed with the user as
too different in kind (it needs its own bibliography data model and UI, not just a
rendering change) to bundle here. Left as a separate, later IMPROVEMENTS.md item.

This app renders with `marked` in GFM mode plus `marked-footnote`
(`client/src/components/Preview.svelte`), with three existing syntax extensions of
its own layered on via pre/post-processing rather than real markdown syntax:
`[[Wikilinks]]` (`wikilinks.ts`), image references (`app.ts`'s `resolveImageRefs`),
and diagram references (`diagram-refs.ts`'s `resolveDiagramRefs`). This spec adds a
fourth and fifth such extension (definition lists, superscript/subscript) using the
same "preprocess before `marked.parse()`" approach — and, since neither needs
KaTeX-style async rendering, generates real HTML directly during preprocessing
rather than `math-preview.ts`'s placeholder-then-DOM-walk approach (see
Definition lists & superscript/subscript below for why that's safe here).

## Goal

- Typing a recognized definition-list block or `^superscript^`/`~subscript~` span
  renders it correctly in the live preview, in every export format, and is flagged
  by the existing Markdown Compatibility Checker as flavor-specific (won't render
  the same on GitHub or a plain CommonMark renderer).
- A new "Metadata" section in the Document Info panel lets a user add/edit/remove
  freeform `Key: Value` pairs on the active document. These sync live for a shared
  document (same mechanism as the document name already does) and round-trip
  through every place raw markdown leaves or enters the app: `.md` export, Gist
  publish, repo push, and — on the way in — opening a `.md` file, importing from a
  Gist, or linking a workspace to a repo, all of which already funnel through the
  single `createDoc()` chokepoint.

## Non-goals (deferred)

- **Citations & bibliography** — see Scope decomposition above.
- **Multi-paragraph / nested-block definitions.** A definition list's terms and
  definitions are each a single line for this first pass — no lazy continuation, no
  nested blockquotes/code blocks/lists inside a definition. Inline formatting
  (bold/italic/code/links) inside a term or definition still works.
- **Custom app-specific inline syntax inside a definition's text.** An image
  reference or `[[wikilink]]` typed inside a definition-list term/definition won't
  get this app's custom resolution (see Definition lists & superscript/subscript
  below) — plain links/bold/italic/code do work. Accepted as a rare edge case.
- **A fixed/known metadata key list, or any validation on keys.** Freeform, exactly
  as MultiMarkdown itself allows.
- **Metadata block detection while typing.** Metadata is never inferred from the
  live editor body at all — only edited via the Document Info UI, and only ever
  parsed out of markdown text at the single import chokepoint (`createDoc()`), a
  one-time action, not a per-keystroke scan. This sidesteps MultiMarkdown's own
  real ambiguity (a document that happens to start with "Note: draft" looking like
  metadata) entirely, rather than trying to further disambiguate it.
- **Compatibility-checker coverage for metadata.** Since metadata is never present
  in the live editor body, there's nothing there for the existing checker (which
  scans editor text) to flag — this only applies to definition lists and
  superscript/subscript, which remain real inline/block syntax typed into the
  document.

## Components

### `client/src/mmd-inline-blocks.ts` (new)

Pure module, parallel to `wikilinks.ts`/`math-preview.ts` — preprocessing transforms
run on raw markdown before `marked.parse()`. Both transforms generate literal HTML
directly (`<dl>`/`<dt>`/`<dd>`, `<sup>`/`<sub>`) rather than the placeholder-then-
DOM-walk indirection `extractMathSpans`/`renderMathPlaceholders` need — that
indirection exists there only because KaTeX rendering is async and unavailable at
synchronous preprocessing time; neither of these transforms needs an external
library, so there's no async gap to bridge. CommonMark (and `marked`) already
passes through `<dl>`/`<dt>`/`<dd>` as a recognized HTML block, and `<sup>`/`<sub>`
as inline HTML, with no config change — DOMPurify's default allowlist covers all
five tags already.

```ts
import { marked } from "marked";

// Term
// Term 2
// :   Definition A
// :   Definition B
//
// One or more consecutive non-indented "term" lines, followed by one or more
// ":"-prefixed definition lines. Consecutive term/definition groups (no
// intervening non-blank, non-matching line) merge into one <dl> — matching how
// adjacent list items already merge into one <ul>/<ol>.
// Exported (not just module-local) so markdown-compat.ts can detect the same
// shape it renders as, rather than a second, independently-drifting regex.
export const DEFLIST_GROUP_RE = /^((?:[^\s:][^\n]*\n)+)((?::[ \t]+[^\n]+\n?)+)/gm;
const DEFLIST_DEF_LINE_RE = /^:[ \t]+([^\n]+)$/gm;

export function transformDefinitionLists(text: string): string {
  return text.replace(DEFLIST_GROUP_RE, (_match, termLines: string, defLines: string) => {
    const terms = termLines
      .trim()
      .split("\n")
      .map((t) => `<dt>${marked.parseInline(t.trim())}</dt>`)
      .join("");
    const defs = [...defLines.matchAll(DEFLIST_DEF_LINE_RE)].map((m) => `<dd>${marked.parseInline(m[1]!.trim())}</dd>`).join("");
    return `<dl>${terms}${defs}</dl>\n\n`;
  });
}

// 2^10^ -> 2<sup>10</sup>. Neither delimiter may touch whitespace, and the
// opening "^" must not immediately follow "[" — a footnote reference's own
// caret ("[^label]") is always preceded by "[", so this single lookbehind is
// what keeps a footnote reference from ever being misread as superscript.
export const SUPERSCRIPT_RE = /(?<!\[)\^(?!\s)([^\s^]+?)(?<!\s)\^/g;
// H~2~O -> H<sub>2</sub>O. Must not fire inside a "~~text~~" GFM strikethrough
// span — resolved the same way math-preview.ts disambiguates $ from $$: match
// (and consume) "~~...~~" first via a non-capturing alternative so a single "~"
// inside it is never seen as a subscript delimiter on its own.
export const STRIKETHROUGH_OR_SUBSCRIPT_RE = /~~[^~\n]+~~|~(?!\s)([^\s~]+?)(?<!\s)~/g;

export function transformSuperscriptSubscript(text: string): string {
  const withSuperscript = text.replace(SUPERSCRIPT_RE, (_m, body: string) => `<sup>${marked.parseInline(body)}</sup>`);
  return withSuperscript.replace(STRIKETHROUGH_OR_SUBSCRIPT_RE, (m, body: string | undefined) => (body === undefined ? m : `<sub>${marked.parseInline(body)}</sub>`));
}
```

`Preview.svelte`'s `updatePreview()` calls both, right after
`extractMathSpans(transformWikilinks(raw))` and before `marked.parse()`. Running
them *after* wikilink/math extraction (not before) means a wikilink or math span
used inside a definition's text already looks like plain markdown or an opaque
`§MATH0§` placeholder by the time `marked.parseInline()` sees it inside
`transformDefinitionLists`, so it round-trips through this app's normal
placeholder-then-DOM-walk math rendering for free — the one exception is the custom
image/wikilink-link renderer overrides `Preview.svelte` builds locally, which
`marked.parseInline()`'s default renderer doesn't carry (see Non-goals).

`scroll-sync.ts` needs no changes — it lexes the *original*, untransformed raw
markdown (see its own top-of-file comment), and a definition-list block or a
superscript/subscript span is invisible to `marked`'s default lexer either way (it
just sees an ordinary paragraph/text token spanning those lines), so its existing
per-block line-position mapping already covers this correctly with zero new code.

### `client/src/markdown-compat.ts` (modify)

Two new categories, both `"flavor-specific"` (renders here, not guaranteed
elsewhere) — added inside `scanTextToken`'s existing per-text-token regex loop,
the same mechanism `WIKILINK_RE`/`FOOTNOTE_REF_RE`/`MATH_RE` already use, reusing
`mmd-inline-blocks.ts`'s own `SUPERSCRIPT_RE`/`STRIKETHROUGH_OR_SUBSCRIPT_RE`
constants (imported, not duplicated, so detection here can never drift from what
actually renders) for the two inline spans:

```ts
import { SUPERSCRIPT_RE, STRIKETHROUGH_OR_SUBSCRIPT_RE, DEFLIST_GROUP_RE } from "./mmd-inline-blocks";
```

Superscript/subscript slot into `scanTextToken`'s existing per-text-token loop
alongside the three existing regexes (labels: `"Superscript"`, `"Subscript"` — the
strikethrough/subscript regex's `body === undefined` branch, meaning a real
`~~strikethrough~~` match, is skipped here since that's already flagged separately
by the `del`-token branch elsewhere in this file).

Definition lists are block-level (a term + `:`-line pair can span a whole
paragraph token's raw text), so they're checked once per block token — alongside
the existing `table`/`list` block-level checks — using `DEFLIST_GROUP_RE` directly
against a `paragraph` token's raw text, flagging a `"Definition list"` issue for
each match.

### `client/src/mmd-metadata.ts` (new)

Pure module — parse/serialize only, no Svelte/store dependency (mirrors
`markdown-compat.ts`'s own independence).

```ts
export interface MetadataPair {
  key: string;
  value: string;
}

const METADATA_LINE_RE = /^([A-Za-z][\w \t-]*):[ \t]+(.*)$/;
const CONTINUATION_LINE_RE = /^[ \t]+(.*)$/;

// Metadata must be the first thing in the document: a run of "Key: Value" lines
// (any key name — this app doesn't restrict to a known set), each optionally
// followed by indented continuation lines that extend the previous value
// (joined with a space), terminated by the first blank line (consumed as the
// separator) or the first non-matching, non-blank line (left in body). If line
// 1 doesn't match, there is no metadata block at all.
export function parseMetadataBlock(text: string): { metadata: MetadataPair[]; body: string } {
  const lines = text.split("\n");
  const metadata: MetadataPair[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === "") {
      i++;
      break;
    }
    const m = METADATA_LINE_RE.exec(line);
    if (!m) break;
    let value = m[2]!;
    let j = i + 1;
    while (j < lines.length && lines[j]!.trim() !== "" && CONTINUATION_LINE_RE.test(lines[j]!)) {
      value += ` ${lines[j]!.trim()}`;
      j++;
    }
    metadata.push({ key: m[1]!.trim(), value });
    i = j;
  }
  if (metadata.length === 0) return { metadata: [], body: text };
  return { metadata, body: lines.slice(i).join("\n") };
}

// Inverse of parseMetadataBlock — a real "Key: Value\n" block, one line per
// pair (continuation lines are never re-derived; a value is written back out
// as a single line even if it was originally read from a continuation),
// followed by a blank line, prepended to body. Returns body unchanged if
// metadata is empty.
export function serializeMetadataBlock(metadata: MetadataPair[], body: string): string {
  if (metadata.length === 0) return body;
  const block = metadata.map((m) => `${m.key}: ${m.value}`).join("\n");
  return `${block}\n\n${body}`;
}
```

### `client/src/types.ts` (modify)

```ts
// MultiMarkdown-style document metadata (Title/Author/etc.) — freeform
// Key: Value pairs, edited via Document Info, not present in the live editor
// body (see mmd-metadata.ts). Order preserved for round-tripping on export.
metadata?: MetadataPair[];
```

### `client/src/stores/docs.ts` (modify)

- `createDoc()`: when `partial.content` is given and `partial.metadata` is not
  (i.e. a real text import, not a duplicate that already carries structured
  metadata), run `parseMetadataBlock` and store the result's `metadata` on the new
  `Doc`, using its `body` as the doc's actual `content`. This is the single
  chokepoint already shared by File→Open import, Gist import, and repo-link
  import (per this function's own existing comment), so no other file needs an
  import-side change.
- New exported setter, mirroring `renameDoc`'s exact shape:
  ```ts
  export function setActiveDocMetadata(metadata: MetadataPair[]) {
    const doc = getActiveDoc();
    if (!doc) return;
    updateDoc(doc.id, { metadata });
    persistDocs();
  }
  ```
- `syncRemoteDocContent()` gains an optional `metadata` parameter alongside its
  existing optional `name`, applied the same way (only written when provided and
  different from the doc's current value).

### `client/src/components/DocInfoPanel.svelte` (modify)

New "Metadata" section, placed after the existing "Compatibility" row and before
the "Synced to" section — a list of key/value input pairs (one row per
`MetadataPair`, a delete button per row) plus an "Add field" button, editing a
local `$state` draft array that calls `setActiveDocMetadata` (imported from
`stores/docs.ts`) on each change, then `window.MDE.onDocMetadataChanged?.(doc.id, metadata)` to push the change out for a shared document (mirrors the existing
`docTitleInput`'s `renameDoc()` + `window.MDE.onDocRenamed?.(...)` pairing in
`app.ts`). Uses the panel's own existing `.doc-info-row` styling for each pair row;
a small new `_modals.scss` rule for the delete/add buttons.

### `client/src/types.ts` (`MDEBridge`, modify)

New paired hook, mirroring `setDocName`/`onDocRenamed` exactly:

```ts
setDocMetadata(id: string, metadata: MetadataPair[]): void;
onDocMetadataChanged: ((id: string, metadata: MetadataPair[]) => void) | null;
```

### `client/src/app.ts` (modify)

- New bridge method `setDocMetadata(id, metadata)`, mirroring `setDocName`: calls
  `setActiveDocMetadata` (only meaningful when `id` is the active doc, same
  restriction `setActiveDocMetadata` itself already has) and, if the Document Info
  panel is currently open on that document, nothing else is needed — its own
  `$derived doc` already re-reads `$docsStore` reactively.
- `onDocMetadataChanged: null` added to the bridge object next to the existing
  `onDocRenamed: null`.
- `getResolvedContent()` and `exportAs("md")`'s `resolved` value both get wrapped
  in `serializeMetadataBlock(doc?.metadata ?? [], ...)` before being used —
  `getResolvedContent()` covers Gist publish for free since `gist.ts` is its only
  real caller.

### `client/src/collab.ts` (modify)

Mirrors every place `metaMap`'s `"name"` key is already read/written, adding a
parallel `"metadata"` key (JSON-serialized `MetadataPair[]`, since `metaMap` is a
plain `Y.Map<string>` and this is one more small string value on it — no new
top-level Y type, no server-side change, matching how `name` itself was added):

- `seedDocBindingFromEditor`: also seeds `metaMap.set("metadata", JSON.stringify(doc.metadata ?? []))`.
- `metaMap.observe(...)`: also branches on `event.changes.keys.has("metadata")`,
  parsing and calling a new bridge method `window.MDE.setDocMetadata(docId, metadata)`
  the same way a remote rename calls `window.MDE.setDocName`.
- `flushDirtyBackgroundDocs`: also reads `binding.metaMap.get("metadata")`
  (JSON-parsed) and passes it into `syncRemoteDocContent`'s new `metadata` param.
- `window.MDE.onDocMetadataChanged` assigned in `init()`, mirroring the existing
  `onDocRenamed` assignment: writes into the active binding's `metaMap` inside a
  `"local"`-origin transaction.

### `client/src/repo-sync.ts` (modify)

The single push-loop call site (`rewriteImagesForPush(doc.content, ...)`) becomes
`rewriteImagesForPush(serializeMetadataBlock(doc.metadata ?? [], doc.content), ...)`
— `rewriteImagesForPush` itself needs no change, since it just receives different
input text.

## Testing

- `tests/client/src/mmd-inline-blocks.test.ts` (unit): one test per construct
  (single term/definition, multiple terms, multiple definitions, consecutive
  groups merging into one `<dl>`, inline formatting inside a term/definition,
  no-match cases left untouched); superscript/subscript happy paths; the two
  disambiguation regressions (`~~strikethrough~~` never becomes `<sub>`, `[^1]`
  footnote references never becomes `<sup>`).
- `tests/client/src/mmd-metadata.test.ts` (unit): parse a simple block, parse with
  an indented continuation line, no metadata present (body returned unchanged),
  a document whose very first line doesn't look like `Key: Value` at all, and a
  round-trip for a single-line-only document (`serializeMetadataBlock(parseMetadataBlock(x).metadata, parseMetadataBlock(x).body)` reproduces `x` exactly — a
  continuation-line input is deliberately excluded from this exact-equality case,
  since serializing always flattens a continuation back to one line).
- `tests/client/src/markdown-compat.test.ts` (extend, existing file): a
  definition-list block flags `"Definition list"`; `2^10^` flags `"Superscript"`;
  `H~2~O` flags `"Subscript"`; `~~text~~` still only flags `"Strikethrough"` (not
  also `"Subscript"`); `[^1]` still only flags `"Footnote reference"` (not also
  `"Superscript"`).
- `tests/client/src/stores/docs.test.ts` (extend): `createDoc` with content
  starting with a real metadata block splits it into `.metadata`/`.content`
  correctly; `createDoc` with both `content` and `metadata` given explicitly (the
  duplicate-doc case) never re-parses `content`; `setActiveDocMetadata` updates
  and persists.
- `tests/client/src/collab.test.ts` (extend): a local `setDocMetadata` call
  propagates into the Y.Doc's `meta` map under `"metadata"`; a remote change to
  that key calls `window.MDE.setDocMetadata` when the doc is active, and marks it
  dirty (background-sync path) when it isn't.
- `tests/client/src/components/DocInfoPanel.test.ts` (new, `components` Vitest
  project): renders existing metadata pairs as rows; "Add field" appends an empty
  row; editing a row's key/value calls `setActiveDocMetadata` with the updated
  array; deleting a row removes it.
- `tests/e2e/local` (extend an existing spec, likely `documents.spec.ts` or a new
  `mmd-syntax.spec.ts`): typing a definition list and a superscript/subscript span
  renders `<dl>`/`<sup>`/`<sub>` in the live preview; adding a metadata field in
  Document Info and exporting as `.md` produces a file starting with the expected
  `Key: Value` block.
