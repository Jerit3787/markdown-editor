# Preview links & wikilinks — design

**Status:** draft for review
**Date:** 2026-09-08
**Related backlog:** `ROADMAP.md` → Active → "Preview links & wikilinks" — items **G1** (non-URL markdown links) and **G2** (wikilink syntax leaking into rendered code / no unresolved state).

## Goal

Make the preview treat inter-document references as first-class, whichever syntax produced them, and stop wikilink rewriting from corrupting code:

1. **G1** — a markdown link `[text](target)` whose `target` is a bare document name / relative path resolves to the matching document (and navigates in-app), or renders as an explicit "unresolved" affordance — never a dead `…/d/<target>` page navigation.
2. **G2** — `[[Name]]` inside an inline code span or fenced code block is left verbatim (today it is rewritten to `[Name](wikilink:Name)` and rendered literally), and the same code-awareness applies to the rename cascade and backlink scans.

## Non-goals / deferred

- **Wiki-style `[[Name|alias]]` / `[[Name#heading]]`.** Out of scope; `[[Name]]` stays the only supported form.
- **Auto-linking bare URLs** that are not already in `[...](...)` or `[[...]]` syntax (e.g. a raw `https://example.com` in prose). GFM autolink behaviour is unchanged.
- **`../` path traversal across workspaces**, or resolving a repo path against a repo subtree the workspace doesn't mirror. Resolution is within the active workspace's document list only.
- **Indented (4-space) code blocks** in the code-skip helper. Matches `math-preview.ts`'s existing `CODE_SEGMENT_RE` scope (fenced ```` ``` ```` and inline `` ` `` only). Noted as a shared limitation.
- **A general "broken link" report / lint panel.** The affordance is per-link in the preview only.
- **Changing `[[wikilink]]` click behaviour.** An unresolved `[[Name]]` still offers create-on-click, unchanged.

## Background — current state

### G2: `transformWikilinks` runs before the parser, over everything

`client/src/wikilinks.ts`:

```ts
const WIKILINK_RE = /\[\[([^[\]\n]+)\]\]/g;
export function transformWikilinks(content: string): string {
  return content.replace(WIKILINK_RE, (_m, name) => `[${name}](wikilink:${encodeURIComponent(name)})`);
}
```

`Preview.svelte`'s `updatePreview()` calls `extractMathSpans(transformWikilinks(raw))` — so the `[[…]]` → `[…](wikilink:…)` rewrite happens on the **raw string, before `marked.parse()`**. Confirmed with marked 18.0.11:

| Source | Rendered |
|---|---|
| `` `[[Secret]]` `` | `<code>[Secret](wikilink:Secret)</code>` — **leak** |
| ` ```\n[[InFence]]\n``` ` | code block containing `[InFence](wikilink:InFence)` — **leak** |
| `[[Ghost]]` (Ghost doc missing) | `<a href="#" class="wikilink wikilink-missing" data-doc-name="Ghost">Ghost</a>` — already correct |

So the "unresolved wikilink leaks `wikilink:` syntax" half of G2 is **only** the code-span/fence case. `renderer.link` (`Preview.svelte:77`) already renders a real unresolved state for a genuine `[[Name]]` outside code.

`math-preview.ts` already solved the identical "don't touch code" problem:

```ts
const CODE_SEGMENT_RE = /(```[\s\S]*?```|`[^`\n]*`)/g;
// split on it, only scan the odd (non-code) segments
```

### G2: the same blind spot in the rename cascade and backlink scans

- `rewriteWikilinkReferences(content, oldName, newName)` — `client/src/wikilink-rewrite.ts` **and its hand-synced Worker copy `src/wikilink-rewrite.ts`** (called by `workspace-room.ts`'s `handleWikilinkRenameRequest`, which does a whole-string replace into the doc's `Y.Text`). A rename today rewrites `[[oldName]]` even inside a fenced code block — silently editing what a reader sees as literal sample text.
- `findWikilinkOccurrences(content, name)` — `client/src/wikilink-rewrite.ts`, returns character ranges for the live CodeMirror rename (`app.ts:1236`). Includes in-code matches.
- `findBacklinks(targetName, docs)` — `client/src/wikilinks.ts`, a `d.content.includes("[[target]]")` substring test (used by `wikilink-rename-cascade.ts` and `DocInfoPanel.svelte`'s backlinks list). A doc that only mentions `[[X]]` in a code sample counts as a backlink.

### G1: non-URL markdown links dead-navigate

`Preview.svelte`'s `renderer.link`:

```ts
renderer.link = ({ href, title, text, tokens }) => {
  if (!href.startsWith("wikilink:")) return defaultLinkRenderer({ ... }); // <-- everything non-wikilink
  // ...wikilink: handling...
};
```

marked 18 output for non-URL targets:

| Source | marked output | In the app |
|---|---|---|
| `[Plain](PlainNote)` | `<a href="PlainNote">Plain</a>` | click → browser navigates page to `https://<host>/d/PlainNote` → dead (the "…/d/\<file name\>" in G1) |
| `[notes](./docs/notes.md)` | `<a href="./docs/notes.md">notes</a>` | click → `https://<host>/docs/notes.md` → dead |
| `[My Note](My Note)` | literal text `[My Note](My Note)` | marked rejects a destination with an unescaped space — not even a link |
| `[site](https://x.com)` | `<a href="https://x.com">site</a>` | works, but opens in the same tab (replaces the app) |

Only `.wikilink` clicks are intercepted (`Preview.svelte:386` — one delegated listener on `hostEl`). A plain `<a>` is a full navigation.

`Doc` has `name`, and for repo-synced docs `repoPath` (e.g. `"docs/notes.md"`).

## Design

### 1. Shared code-segment helper — `markdown-code.ts`

New `client/src/markdown-code.ts`, dependency-free, hand-mirrored as `src/markdown-code.ts` for the Worker (same convention as `wikilink-rewrite.ts` / `version-grouping.ts` — a header comment on each points at the other):

```ts
// A fenced code block (```…``` across lines) or an inline code span
// (`…` on one line). Same scope as math-preview.ts's CODE_SEGMENT_RE
// (which now re-exports this) — indented 4-space code blocks are not
// covered, a known shared limitation.
export const CODE_SEGMENT_RE = /(```[\s\S]*?```|`[^`\n]*`)/g;

// Runs `replacer` (identical signature to String.prototype.replace's
// function form) over `text` but only outside code segments. Splitting
// on a capturing regex keeps the code segments in the array at odd
// indices, verbatim.
export function replaceOutsideCode(
  text: string,
  pattern: RegExp,
  replacer: (match: string, ...groups: string[]) => string,
): string;

// Absolute [start, end) ranges of every code segment in `text`, in
// order. For callers that need offsets rather than a rewrite
// (findWikilinkOccurrences, findBacklinks).
export function codeSegmentRanges(text: string): Array<{ from: number; to: number }>;

// True if [from, to) overlaps any code segment range.
export function isInsideCode(ranges: Array<{ from: number; to: number }>, from: number, to: number): boolean;
```

`math-preview.ts` drops its local `CODE_SEGMENT_RE` and imports it from here (behaviour identical — it is the same regex).

### 2. G2 — wikilink handling skips code

| Function | Change |
|---|---|
| `transformWikilinks(content)` | `replaceOutsideCode(content, WIKILINK_RE, …)` instead of `content.replace(WIKILINK_RE, …)`. |
| `rewriteWikilinkReferences(content, old, new)` — **both copies** | same swap to `replaceOutsideCode`. Import `replaceOutsideCode` from the local `markdown-code` (client copy) / `./markdown-code` (Worker copy). |
| `findWikilinkOccurrences(content, name)` | compute `codeSegmentRanges(content)` once; skip any match where `isInsideCode(ranges, m.index, m.index + m[0].length)`. |
| `findBacklinks(targetName, docs)` | replace the `d.content.includes(needle)` test with "the needle occurs outside code" — a small local `hasWikilinkOutsideCode(content, name)` (reuse `codeSegmentRanges` + a scan), so a code-only mention is not a backlink. |

`wikilink-rewrite.ts`'s Worker copy currently has no imports; it gains `import { replaceOutsideCode } from "./markdown-code";`. The Worker copy of `markdown-code.ts` must therefore exist and be bundled — it is (Worker bundles from `src/`).

### 3. G1 — document-aware link resolution — `doc-link.ts`

New `client/src/doc-link.ts`:

```ts
export type LinkHrefKind = "external" | "anchor" | "absolute" | "doc-ref";

// external: has a scheme (`foo:` where foo is a URL scheme — http, https,
//   mailto, tel, ftp, …) OR is protocol-relative (`//host`).
// anchor: starts with `#`.
// absolute: starts with a single `/`.
// doc-ref: everything else — a bare name or a relative path.
export function classifyLinkHref(href: string): LinkHrefKind;

// Resolve a doc-ref href to a document. Decodes %-escapes, strips a
// leading `./`. Tries, in order:
//   1. exact  d.name === ref
//   2. exact  d.name === ref without a trailing `.md`
//   3. exact  d.repoPath === ref
//   4. exact  d.repoPath === (ref without `./`, and with `.md` appended if absent)
//   5. basename: the last `/`-segment of ref (sans `.md`) === d.name
// First match wins; ties (multiple docs same name) resolve to the first
// in `docs` order, same as resolveWikilinkTarget.
export function resolveDocRef(href: string, docs: Doc[]): Doc | undefined;

// A doc-ref that resolved to nothing: does it look like a bare external
// domain the user meant as a website? — contains a `.`, no whitespace,
// no `/` before the first `.`, the final path-free segment's TLD is
// 2+ ASCII letters, and the ref does NOT end in a document-ish
// extension (`.md`, `.markdown`, `.txt`). e.g. `example.com`,
// `docs.example.com/page` → true; `notes.md`, `My Note` → false.
export function looksLikeExternalDomain(ref: string): boolean;
```

### 4. `renderer.link` rewrite (`Preview.svelte`)

Extract the whole link-rendering decision into a pure, unit-testable function — new `client/src/preview-link-render.ts`:

```ts
export interface RenderLinkDeps {
  docs: Doc[];
  // marked's own renderer for the fall-through cases, already bound.
  renderDefault: (href: string, title: string | null, text: string, tokens: unknown[]) => string;
  escapeHtml: (s: string) => string;
}
export function renderLink(
  href: string, title: string | null, text: string, tokens: unknown[],
  deps: RenderLinkDeps,
): string;
```

Decision order:

1. **`href` starts `wikilink:`** — unchanged from today: decode, `resolveWikilinkTarget`, emit `<a href="#" class="wikilink[ wikilink-missing]" data-doc-name="…">`.
2. **`classifyLinkHref(href)` is `doc-ref`:**
   - `resolveDocRef` hits → `<a href="#" class="wikilink" data-doc-name="<resolved doc.name>">text</a>` — routes through the existing click handler, navigates in-app. (Uses the *resolved* name so the handler's own `resolveWikilinkTarget` succeeds even when the ref was a path or `.md` form.) `text` here is the raw link text; nested inline formatting in a doc-ref's link text is not preserved (parity with how `wikilink:` links already render their text via `escapeHtml`).
   - no doc, `looksLikeExternalDomain(ref)` → `withBlankTarget(renderDefault("https://" + ref, title, text, tokens))` — delegate to marked's renderer with the href swapped to an absolute `https://` URL, then inject the target/rel (below). Preserves nested link-text formatting.
   - no doc, not domain-like → `<a href="#" class="wikilink wikilink-missing doc-ref-missing" data-doc-ref="<ref>" title="No document named &quot;<ref>&quot;">text</a>`. **No `data-doc-name`** — the click handler must not treat it like a wikilink miss.
3. **`external`** — `withBlankTarget(renderDefault(href, title, text, tokens))`. Applies to all real external links — a deliberate, changelog-worthy UX change (external links no longer replace the app).
4. **`anchor` / `absolute`** — `renderDefault` unchanged.

`withBlankTarget(html)` inserts `target="_blank" rel="noopener noreferrer"` immediately after the opening `<a ` of marked's output when no `target=` is already present. marked's default link renderer emits a single, predictable `<a href="…"[ title="…"]>` opening tag, so a targeted string insertion (not a full HTML parse) is sufficient and is covered by a `renderLink` test.

`Preview.svelte` keeps a thin `renderer.link = ({href,title,text,tokens}) => renderLink(href, title ?? null, text, tokens ?? [], { docs: get(docsStore), renderDefault: defaultLinkRenderer-adapter, escapeHtml })`.

### 5. Click handler (`Preview.svelte` `initWikilinkNavigation`, ~line 386)

Currently: `closest(".wikilink")` → `data-doc-name` → `resolveWikilinkTarget` → `storeSwitchDoc` or `createDoc({ name })`.

Change: also match `.doc-ref-missing`.

```ts
const el = target.closest<HTMLElement>(".wikilink, .doc-ref-missing");
if (!el) return;
e.preventDefault();
if (el.classList.contains("doc-ref-missing")) {
  const ref = el.getAttribute("data-doc-ref") ?? "";
  // A clean bare name → offer to create (parity with a [[wikilink]] miss).
  // A path / filename form → no-op (creating a doc literally named
  // "docs/notes.md" is never what was meant).
  if (ref && !ref.includes("/") && !/\.[a-z0-9]+$/i.test(ref)) createDoc({ name: ref });
  return;
}
// ...existing .wikilink path unchanged...
```

### 6. Styling

`doc-ref-missing` reuses `.wikilink-missing`'s existing look (`_editor-preview.scss` — dashed underline, `--text-dim`). It carries both classes, so no new CSS beyond making sure `.wikilink-missing` styling isn't `[data-doc-name]`-dependent (it isn't — it's a plain class rule). External-link `target=_blank` needs no style change.

### 7. DOMPurify

`ADD_ATTR` already includes `target`. `rel` is in DOMPurify's default allowlist for `<a>` — verify in a test (`DOMPurify.sanitize('<a rel="noopener noreferrer">x</a>')` keeps `rel`). No config change expected; if `rel` is stripped, add it to `ADD_ATTR`.

## Data flow

```
raw markdown
  └─ transformWikilinks           ── replaceOutsideCode ──▶ [[X]] → [X](wikilink:X)  (code spans untouched)
  └─ extractMathSpans / … (unchanged)
  └─ marked.parse(renderer)
        renderer.link ─▶ renderLink(href,…, {docs})
              wikilink:  → resolve → <a class=wikilink|wikilink-missing data-doc-name>
              doc-ref    → resolveDocRef → <a class=wikilink data-doc-name>          (hit)
                         → looksLikeExternalDomain → <a href=https:// target=_blank> (miss, domain)
                         → <a class="wikilink-missing doc-ref-missing" data-doc-ref> (miss, name)
              external   → default + target=_blank rel=noopener
              anchor/abs → default
  └─ DOMPurify.sanitize
  └─ hostEl.innerHTML
        click (delegated) ─▶ .wikilink        → switchDoc / createDoc(name)   (unchanged)
                          ─▶ .doc-ref-missing  → createDoc(name) iff clean bare name, else no-op
```

Rename cascade (unchanged control flow, now code-aware):

```
rename doc  ─▶ planWikilinkRenameCascade(findBacklinks — code-aware)
            ─▶ local buffer:  findWikilinkOccurrences (code-aware) → CM edits
            ─▶ other local:   rewriteWikilinkReferences (code-aware)
            ─▶ shared:        POST /wikilink-rename ─▶ Worker rewriteWikilinkReferences (code-aware)
```

## Testing

| Area | Test | File |
|---|---|---|
| `markdown-code` | `replaceOutsideCode` skips inline `` ` ``/fenced; `codeSegmentRanges`/`isInsideCode` offsets; nested/adjacent fences; unterminated fence | `tests/client/src/markdown-code.test.ts` (+ `tests/src/` mirror if logic diverges — it shouldn't) |
| `math-preview` | still green after the `CODE_SEGMENT_RE` re-export | existing `tests/client/src/math-preview.test.ts` |
| `transformWikilinks` | `` `[[X]]` `` and fenced `[[X]]` pass through; outside-code still rewritten; mixed line | `tests/client/src/wikilinks.test.ts` (extend) |
| `rewriteWikilinkReferences` | in-code `[[old]]` not renamed, both copies | `tests/client/src/wikilink-rewrite.test.ts`, `tests/src/wikilink-rewrite.test.ts` |
| `findWikilinkOccurrences` | in-code match excluded, offsets of the kept ones correct | `tests/client/src/wikilink-rewrite.test.ts` |
| `findBacklinks` | code-only mention ⇒ not a backlink | `tests/client/src/wikilinks.test.ts` |
| `classifyLinkHref` / `resolveDocRef` / `looksLikeExternalDomain` | every branch incl. `.md`, `repoPath`, `%20`, `./`, basename; domain vs `notes.md` vs `My Note` | `tests/client/src/doc-link.test.ts` |
| `renderLink` | all six outcomes; `escapeHtml` on text and ref; existing `wikilink:` path unchanged | `tests/client/src/preview-link-render.test.ts` |
| Worker rename | in-code `[[old]]` survives a `/wikilink-rename` call | `tests/src/workspace-room.test.ts` (extend) |
| e2e | `[x](DocName)` in the preview → click → editor switches to that doc; `` `[[X]]` `` renders as literal code; an unresolved `[Broken](Nope)` shows the dashed affordance and does not navigate | `tests/e2e/local/preview-links.spec.ts` (new) |

## Rollout

User-facing → **minor bump**. `CHANGELOG.md` `### Fixed` (wikilink-in-code leak; dead inter-doc links) + `### Changed` (external links open in a new tab). One `whats-new-entries.ts` entry ("Links Between Documents, and Safer Code Samples" — category "Organization & Navigation") with a real screenshot: a preview showing a working `[Design Notes](design-notes.md)` link next to a `` `[[literal]]` `` code span. `docs/TEST-COVERAGE.md` rows under §2 (Preview) and §3 (Markdown dialects). `ROADMAP.md` — move G1/G2 out of Active into a "shipped" note, carry the Non-goals into the deferred list.

## Open questions

None — the four design decisions (resolution scope, unresolved affordance, bare-domain handling, code-skip scope) were settled in the brainstorm.
