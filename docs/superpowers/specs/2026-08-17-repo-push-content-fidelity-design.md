# Repo Push Content Fidelity — Design Spec

**TODO item 12, plus a related user-reported bug found in the same code.**
Two independent bugs in `client/src/repo-sync.ts`'s push path, fixed
together since they're small and live in the same function/file. Both
root causes confirmed via `superpowers:systematic-debugging` (item 12)
and direct code reading (the casing bug).

## Goal

Pushing a document to a linked GitHub repo faithfully reproduces its
content: a mermaid diagram's real source ends up in the pushed file (not
its internal reference key), and a document's actual name/casing is
preserved in its repo filename (not forced to lowercase).

## Root causes

**Mermaid diagrams (item 12).** A diagram in a document's content isn't
`![alt](ref)` image syntax — it's a `` ```mermaid `` fence whose body is
just a short reference key (e.g. `diagram-2`), with the real mermaid
source stored separately in `doc.diagrams[ref]`
(`client/src/diagram-refs.ts`'s `diagramKey`/`resolveDiagramRefs`). Two
existing paths already resolve this correctly before content leaves the
app: `app.ts`'s `exportAs("md")` and `window.MDE.getResolvedContent()`
(Gist publish) both call `resolveDiagramRefs(resolveImageRefs(content,
doc), doc.diagrams)` first. `repo-sync.ts`'s `rewriteImagesForPush` never
does — its own regex (`MARKDOWN_IMAGE_RE`, matching `![alt](ref)`) can
never match a mermaid fence, so its `diagrams` parameter and the
`diagrams && diagrams[ref]` branch inside its match callback have always
been dead code. A pushed document's diagram fence still contains the bare
reference key instead of real source.

**Forced lowercase filenames.** `slugifyDocName` calls `.toLowerCase()`
unconditionally, so `"My Notes"` always becomes `my-notes.md` regardless
of the document's actual casing. Pull's own path-to-name derivation
(`docSlugFor`, in `pullFromRepo`) does no lowercasing at all — it already
round-trips whatever case a repo file happens to have. Only push forces
lowercase.

## Behavior

### 1. Resolve diagram refs before pushing

`rewriteImagesForPush` gains a call to `resolveDiagramRefs` as its first
step, and its match callback drops the now-genuinely-dead diagrams
branch:

```ts
export function rewriteImagesForPush(
  content: string,
  docSlug: string,
  images: Record<string, string> | undefined,
  diagrams: Record<string, string> | undefined
): { content: string; assets: ImageAsset[] } {
  const resolvedContent = resolveDiagramRefs(content, diagrams);
  const assets: ImageAsset[] = [];
  const seenRefs = new Map<string, string>(); // ref -> assigned assets path, so repeats reuse the same path
  const newContent = resolvedContent.replace(MARKDOWN_IMAGE_RE, (match, alt, ref) => {
    const dataUrl = images && images[ref];
    if (!dataUrl) return match;
    let assetPath = seenRefs.get(ref);
    if (!assetPath) {
      const hasExt = /\.[a-zA-Z0-9]+$/.test(ref);
      assetPath = `assets/${docSlug}/${hasExt ? ref : `${ref}.${extFromDataUrl(dataUrl)}`}`;
      seenRefs.set(ref, assetPath);
      assets.push({ path: assetPath, dataUrl });
    }
    return `![${alt}](${assetPath})`;
  });
  return { content: newContent, assets };
}
```

`resolveDiagramRefs` is imported from `./diagram-refs` (a dependency-free
leaf module — no circular-import risk). Diagrams are inlined as real
mermaid source directly in the pushed markdown, matching Export's
approach — not pushed as separate asset files the way images are, since
diagram source is small text and GitHub natively renders `` ```mermaid ``
fences in its own file preview. `resolveDiagramRefs` is already a no-op
for any one-line mermaid fence that doesn't correspond to a tracked ref
(returns the fence unchanged), so this can't corrupt a fence a user typed
by hand that happens to look similar.

### 2. Preserve filename casing

`slugifyDocName` drops the lowercase step and widens its character
allowlist to include uppercase letters (the two changes are coupled — the
old regex only worked because everything was already lowercased first;
dropping just `.toLowerCase()` would otherwise make the punctuation-collapse
regex treat every uppercase letter as "not a slug character" and hyphenate
it away):

```ts
export function slugifyDocName(name: string): string {
  const slug = (name || "")
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "untitled";
}
```

`"My Notes!"` → `"My-Notes"` (pushed as `My-Notes.md`), not `"my-notes"`.

## Non-goals (deferred)

- **Retroactively renaming already-linked/already-pushed documents.**
  `planPush`'s "already has a `repoPath`" branch never recomputes
  `slugifyDocName` — it only runs for brand-new (never-pushed) docs, so
  this only changes what a document's path looks like on its *first*
  push. A document already synced under its old lowercase path keeps
  that path; nothing renames or re-pushes it.
- **Fixing a diagram that was already pushed with its ref key still
  literal in a past commit.** This only fixes future pushes going
  forward — an already-pushed file with a bare ref key in it gets fixed
  the next time that document is genuinely re-pushed (content changed),
  not retroactively.

## Error handling

No new error paths — both changes are pure content transforms with no
new failure modes. `resolveDiagramRefs` already handles a missing/
mismatched ref by leaving the fence unchanged (existing, proven
behavior); `slugifyDocName` already falls back to `"untitled"` for an
empty/all-punctuation name, unaffected by this change.

## Testing

- `repo-sync.test.ts`'s `rewriteImagesForPush` describe block: a new test
  confirming a `` ```mermaid `` fence containing a tracked ref key gets
  replaced with the real diagram source from the `diagrams` map; a test
  confirming a fence with no matching ref (or `diagrams` undefined) is
  left unchanged; the two existing tests (image ref rewriting, untouched
  refs) continue to pass unmodified since they don't involve diagrams.
- `repo-sync.test.ts`'s `slugifyDocName` describe block: its existing
  test asserting lowercase output (`"My Notes!"` → `"my-notes"`) is
  rewritten to assert case-preserving output (`"My Notes!"` →
  `"My-Notes"`); a new test confirming digits and existing hyphens still
  pass through unchanged (case has no bearing on the punctuation-collapse
  logic).
- No manual verification needed beyond what the automated tests already
  cover — both changes are pure functions with existing direct unit-test
  coverage in this file, unlike the WebSocket/DOM-heavy parts of this
  codebase.
