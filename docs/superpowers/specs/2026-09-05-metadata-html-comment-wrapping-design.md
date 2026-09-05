# Metadata Block HTML-Comment Wrapping — Design Spec

## Goal

A document's metadata (`doc.metadata`, edited via the Doc Info/Edit UI) is
serialized as plain `Key: Value` lines at the top of the file whenever it's
written out to something outside this app — Gist publish, `.md` export, and
repo-sync push. Bare `Key: Value` text has no meaning to a generic CommonMark
renderer, so it shows up as an ugly, fully visible paragraph on GitHub's Gist
page, GitHub's own repo file viewer, or any other markdown viewer — even
though this app's own editor and preview never show it (metadata lives
outside the editor body entirely and is invisible in both already). Wrap the
serialized block in an HTML comment so every CommonMark/GFM renderer hides it
automatically, while it stays fully visible and round-trippable in the raw
`.md` source.

## Non-goals / deferred scope

- **Repo-sync pull never reads metadata back out today** — `repo-sync.ts`
  serializes on push but has no corresponding parse-and-strip step on pull,
  so a pulled doc's `Key: Value` lines (old or new format) just become part
  of its plain body content. That's a pre-existing gap, not something this
  change introduces or is fixing — out of scope here.
- **No change to the Doc Info/Edit UI.** Both already work purely in terms
  of `MetadataPair[]`, never the serialized text — nothing about how a field
  is added, edited, or removed changes.
- **No change to `.html`/`.pdf`/`.txt` export.** Those already read the
  in-app Preview's rendered DOM, which never included metadata in the first
  place (`updatePreview()` renders straight from the editor body, with no
  `serializeMetadataBlock` call anywhere in that path) — already unaffected,
  before and after this change.
- **No new metadata capability** (no new field types, no reordering, no
  validation beyond the escaping below) — this is purely a serialization
  format change for the feature that already exists.

## Format

`serializeMetadataBlock` wraps the block in a single HTML comment instead of
writing bare lines:

```
<!--
Title: My Doc
Author: Jane
-->

body starts here...
```

(unchanged: returns `body` untouched when `metadata` is empty — no comment
is ever written for a doc with no metadata fields).

## Escaping

A metadata value containing the literal substring `-->` would otherwise
close the HTML comment early, leaking the rest of the block (and however
much follows) as visible body text — a real correctness issue, not a
theoretical one, since key/value fields are free-text input with no
character restrictions today. `serializeMetadataBlock` replaces every
`-->` inside a value with `--` + U+200B (zero-width space) + `>` before
writing it out: invisible in every rendered view, but no longer able to
close the comment. `parseMetadataBlock` reverses this — deleting a U+200B
that sits between `--` and `>` — when reading a value back out of the new
wrapped format. This only ever touches the exact `-->` substring; a value
merely containing `--` elsewhere (e.g. "1.0--beta") is written and read
back unchanged.

## Parsing (backward compatible)

`parseMetadataBlock` tries the new wrapped format first: if the text starts
with `<!--` immediately followed by a newline, it looks for the first line
that is exactly `-->` and, if found, parses every line between the two
markers with the existing `METADATA_LINE_RE`/`CONTINUATION_LINE_RE` logic
(unchanged), unescapes each value per the rule above, and treats everything
after the `-->` line — minus one immediately-following blank line, if
present, consumed as the separator — as `body`. If no closing `-->` line is
found, or the text doesn't open with `<!--\n` at all, parsing falls through
unchanged to the existing bare `Key: Value` line scan.

This means a Gist, repo file, or `.md` export already published under the
old bare format (from before this change, or written by some other
MultiMarkdown-aware tool) still round-trips correctly when reopened —
`createDoc()` in `stores/docs.ts` (the sole caller of `parseMetadataBlock`,
reached from every "open" entry point: local file import, opening a Gist,
etc.) needs no changes itself, since both formats resolve to the same
`{ metadata, body }` shape. Every new write always produces the wrapped
format.

## Testing

`tests/src/mmd-metadata.test.ts` (new — no existing test file for this
module):

- `serializeMetadataBlock`: wraps a non-empty metadata array in the comment
  form; returns `body` unchanged for an empty array; escapes a value
  containing `-->` so the produced text contains no un-escaped `-->` before
  the block's own closing marker.
- `parseMetadataBlock`: parses the new wrapped format (including a
  continuation line and an escaped `-->` round-tripping back to its
  original value); still parses the legacy bare-line format unchanged;
  returns empty metadata and the original text as `body` for a document
  with neither form (e.g. starting directly with a heading or an
  unterminated `<!--` block).
- Round-trip: `parseMetadataBlock(serializeMetadataBlock(m, body))` returns
  `{ metadata: m, body }` for a representative set of metadata arrays,
  including one with a `-->`-containing value.

## Versioning

Behind-the-scenes fix — the metadata feature itself is unchanged (same UI,
same data model, same call sites), only how it's written to external
targets. Patch version bump with a `CHANGELOG.md` entry, no What's New
entry, per this repo's versioning convention in `CLAUDE.md`.
