# Wikilink-rename anchor preservation — design

**Status:** approved (brainstorm 2026-09-10)
**Sizing:** small fix in code, but a shared-doc CRDT write-path correctness
change and a ROADMAP Group D deferred item — full spec + plan per
`CLAUDE.md`.

## Goal

A live wikilink rename must not collapse comment / suggestion anchors in
the shared documents whose `[[Old Name]]` references get rewritten.

## Background

Renaming a shared document triggers `runWikilinkRenameCascade`
(`client/src/wikilink-rename-cascade.ts`), which rewrites `[[Old]]` →
`[[New]]` in every backlinking document:

- the **renamed (active) doc** — `applyWikilinkRenameToActiveDoc` in
  `app.ts` dispatches a **targeted** multi-range CodeMirror `changes`
  edit built from `findWikilinkOccurrences`. Anchors survive.
- **local backlinking docs** — `rewriteWikilinksInLocalDoc` replaces the
  plain `doc.content` string. Local-doc comments are plain notes with no
  positional anchor, so nothing to preserve.
- **other shared backlinking docs** — `pushWikilinkRenameToSharedDoc`
  (`history.ts`) POSTs `/api/workspace/:id/docs/:docId/wikilink-rename`,
  handled server-side by `WorkspaceRoom.handleWikilinkRenameRequest`.

The server handler does:

```ts
docRoom.doc.transact(() => {
  text.delete(0, text.length);
  text.insert(0, rewritten);
}, "wikilink-rename");
```

Every Yjs relative position in that document's `comments` and
`suggestions` maps is bound to a character item that
`text.delete(0, text.length)` tombstones. On the next resolve each anchor
collapses (to index 0 / `null`). A workspace with several shared
documents — some carrying comments, one renamed — loses the comment
anchors in every other shared doc that happened to link to it.

The renamed doc itself is already fine (client targeted edit); only the
server's cascade path for *other* shared docs is broken.

## Non-goals

- **Version restore.** `handleVersionRestoreRequest` /
  `handleVersionRestoreContentRequest` do the same wholesale
  `delete(0,len)+insert` under a `"restore"` origin. A restore is a
  deliberate full content swap where the restored text may not contain a
  commented span at all — anchor collapse there is defensible. Left as a
  separate potential ROADMAP item.
- **Local-doc backlinks.** No CRDT, no anchors.
- **The client active-doc path.** Already correct.
- Any change to what counts as a wikilink occurrence, to the rename
  cascade's planning/triggering, or to the `{changed: boolean}` response
  contract.

## Design (approach A — targeted splices)

### `src/wikilink-rewrite.ts`

Add `findWikilinkOccurrences` and the `WikilinkOccurrence` interface,
copied **verbatim** from `client/src/wikilink-rewrite.ts` (the two files
are already hand-synced mirrors — same convention as `markdown-code.ts`,
`version-grouping.ts`). The import line widens to bring in
`codeSegmentRanges` and `isInsideCode`, both already exported by the
Worker's `src/markdown-code.ts`. `rewriteWikilinkReferences` stays (keeps
the mirror complete; used by a test as the oracle).

```ts
import { codeSegmentRanges, isInsideCode, replaceOutsideCode } from "./markdown-code";

// ... existing WIKILINK_RE + rewriteWikilinkReferences unchanged ...

export interface WikilinkOccurrence {
  from: number;
  to: number;
}

export function findWikilinkOccurrences(content: string, name: string): WikilinkOccurrence[] {
  const ranges = codeSegmentRanges(content);
  const re = /\[\[([^[\]\n]+)\]\]/g;
  const occurrences: WikilinkOccurrence[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) {
    if (m[1] === name && !isInsideCode(ranges, m.index, m.index + m[0].length)) {
      occurrences.push({ from: m.index, to: m.index + m[0].length });
    }
  }
  return occurrences;
}
```

The file header comment gains a note that the Worker copy now carries
`findWikilinkOccurrences` too (was previously omitted).

### `src/workspace-room.ts` — `handleWikilinkRenameRequest`

All request guards unchanged (method POST, `authorize()`, `role ===
"editor"`, JSON parse, `oldName`/`newName` non-empty). Body of the
handler after `loadDocRoom`:

```ts
const docRoom = await this.loadDocRoom(docId);
const text = docRoom.doc.getText("content");
const occurrences = findWikilinkOccurrences(text.toString(), oldName);
if (occurrences.length === 0) return Response.json({ changed: false });

const replacement = `[[${newName}]]`;
docRoom.doc.transact(() => {
  // Splice each occurrence in place, back to front, so an earlier
  // occurrence's `from` stays valid while we edit later ones. Relative
  // positions anchored outside a `[[oldName]]` span are physically
  // untouched, so every comment / suggestion anchor in this doc
  // survives — unlike the previous whole-text delete+reinsert, which
  // tombstoned every character item and collapsed all anchors.
  for (let i = occurrences.length - 1; i >= 0; i--) {
    const o = occurrences[i]!;
    text.delete(o.from, o.to - o.from);
    text.insert(o.from, replacement);
  }
}, "wikilink-rename");
return Response.json({ changed: true });
```

The `rewriteWikilinkReferences` import in `workspace-room.ts` is replaced
by `findWikilinkOccurrences`.

### Unchanged downstream

`handleDocUpdate` needs no change. The `"wikilink-rename"` origin is
still not `"storage"`/`"restore"`, so the update is broadcast to peers,
`schedulePersist` runs, and `maybeSnapshot` runs — exactly as before,
with a smaller update payload. `maybeSnapshot`'s `captureSnapshot` reads
`text.toString()` live, so the snapshotted content is the fully rewritten
string regardless of how the edit was applied.

## Edge cases

| Case | Behaviour |
|---|---|
| `oldName` appears only inside `` `code` `` / ```` ``` ```` fences | `findWikilinkOccurrences` returns `[]` → `{changed:false}`, no transaction (matches today). |
| An anchor's endpoints sit **inside** a `[[oldName]]` span | Endpoints shift by the length delta at that offset — identical to `applyWikilinkRenameToActiveDoc`'s client behaviour. Not special-cased. |
| `newName` longer/shorter than `oldName` | Back-to-front iteration keeps every not-yet-edited `from` correct regardless of delta. |
| Multiple occurrences, some in code some not | Only the out-of-code ones are spliced; the in-code `[[oldName]]` is left verbatim. |
| `oldName === newName` | Cascade never calls the endpoint for a no-op rename; if it did, occurrences would be spliced with an identical string (semantically a no-op, `changed:true`). Not a regression. |

## Testing

New / changed tests:

1. **`tests/src/wikilink-rewrite.test.ts`** — add `findWikilinkOccurrences`
   unit cases mirroring `tests/client/src/wikilink-rewrite.test.ts` (or
   the client's `wikilinks.test.ts` occurrence cases): exact-match only,
   multiple occurrences with ascending ranges, in-code skipped, name not
   present → `[]`.

2. **`tests/src/workspace-room.test.ts`,
   `describe("WorkspaceRoom.handleWikilinkRenameRequest")`:**
   - **Anchor preservation (the regression test).** A doc whose content
     is e.g. `"see [[Old]] here, and a commented word after"`, with a
     `comments` thread and a `suggestions` entry both anchored on a span
     *after* the `[[Old]]`. POST the rename `Old → New`. Assert
     `text.toString()` rewrote, and `listResolvedCommentThreads(doc)[0]`
     / `listResolvedSuggestions(doc)[0]` still report their original
     `from`/`to` (not `0`). Fails on `master` (anchors collapse), passes
     after.
   - **Splice == oracle.** After the rename, assert `text.toString()` is
     byte-identical to `rewriteWikilinkReferences(before, "Old", "New")`.
   - **Multiple occurrences** in one doc all get rewritten in a single
     `"wikilink-rename"` transaction (assert one `update` fired, final
     text correct).
   - Existing tests keep passing unchanged: 405 non-POST, 403 non-editor,
     400 bad JSON / missing names, `changed:false` + no `update` when
     absent, `[[Old]]` inside a code span left alone.

Full `npm test` (both projects), `npm run typecheck`, `npm run build`,
`npm run format:check`, `npm run check:no-dev-login`.

## Versioning & docs

- Behind-the-scenes fix (a bug is gone, no new user-facing surface) →
  **patch** bump, `CHANGELOG.md` `### Fixed` only, **no**
  `whats-new-entries.ts` entry. Version bump is the last step before the
  PR.
- `docs/TEST-COVERAGE.md` COLLAB-38 row updated to note the targeted
  splice + anchor preservation.
- `ROADMAP.md` Group D "Security follow-ups" — mark the deferred wikilink
  wholesale-replace note as shipped.
