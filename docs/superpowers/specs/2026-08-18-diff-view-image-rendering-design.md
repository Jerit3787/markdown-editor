# Image Rendering in Diffs — Design

**TODO item:** New Bugs — "Image is not loaded properly in the diffs preview." Deferred out of `docs/superpowers/specs/2026-08-18-github-style-diff-view-design.md` because it needs per-snapshot image storage across three separate backends, not just a `DiffView.svelte` rendering change.

## Problem

`DiffView.svelte` renders diff rows as plain text — an image reference like `![alt](img-key)` or `![alt](assets/slug/foo.png)` shows as literal text, never as an actual image. Separately, even once resolved, a historical version's own image state was never stored — only the current doc's live image map exists, which may not match what a given historical version actually looked like (an image could have been replaced or deleted since).

## Scope

Four phases, each an independent spec→plan→implement→merge cycle sharing one rendering foundation (built in Phase 1):

1. Local (never-shared) docs — `history.ts`'s IndexedDB snapshots.
2. Shared docs — `workspace-room.ts`'s server-side snapshots.
3. Legacy single-doc rooms — `collab-room.ts`'s snapshots (docs not yet migrated to the workspace model).
4. Repo-commit diffs — a separate mechanism entirely (blob fetch from that commit's tree), independent of the other three.

**Out of scope:** collapsing unchanged regions, editing images from within the diff view, anything already covered by the GitHub-style-diff-view spec (line numbers, intraline text highlighting, Split/Unified toggle — already shipped).

## Shared rendering design (built in Phase 1, reused by Phases 2-4)

**Detection — image-only lines, not inline images.** `DiffView` renders a per-line grid; an actual `<img>` doesn't fit inline with text the way GitHub's own line diffs don't try to render images either. A line only gets image treatment when, trimmed, it matches **exactly** one image reference and nothing else:

```ts
const IMAGE_ONLY_LINE_RE = /^!\[([^\]]*)\]\(([^)\s]+)\)$/;

export function parseImageOnlyLine(text: string | null): { alt: string; ref: string } | null {
  if (text === null) return null;
  const match = text.trim().match(IMAGE_ONLY_LINE_RE);
  return match ? { alt: match[1]!, ref: match[2]! } : null;
}
```

New file: `client/src/diff-image-row.ts` (pure, Vitest-covered — same pattern as `diff-lines.ts`). A line mixing prose and an image reference (`"See: ![x](y)"`), or with multiple image refs, does **not** match — falls back to today's plain-text rendering. `"same"` rows never get image treatment either — nothing changed, no diff signal to show; only `"changed"`/`"removed"`/`"added"` rows (in split mode) and `"removed"`/`"added"` unified lines are eligible.

**Rendering — per-cell, not a new row type.** Split mode's left/right cells are already side-by-side grid columns, so a "before/after thumbnail comparison" falls out of teaching each *cell* to render a thumbnail instead of text when its own line is image-only — no new row template needed. Same logic applies to unified mode's already-stacked removed/added lines.

**`DiffView.svelte` gains two new optional props:**

```ts
interface Props {
  before: string;
  after: string;
  beforeImages?: Record<string, string>; // undefined = still loading (Phase 4); {} = loaded, ref may still 404
  afterImages?: Record<string, string>;
}
```

For a cell whose line is image-only:
- Its images map is `undefined` → still loading (Phase 4 only — local/shared/legacy snapshots resolve synchronously, no loading state) → render a small spinner placeholder.
- Map present, `map[ref]` found → `<img src={dataUrl} class="diff-image-thumb" alt={alt}>`.
- Map present, `map[ref]` missing → `<img src={ref} class="diff-image-thumb" alt={alt}>` — `ref` isn't a valid URL, so the browser shows its native broken-image icon. Matches `version-preview.ts`'s existing fallback convention (`doc.images[href] ? doc.images[href] : href`) — no new custom broken-image UI.

CSS: `.diff-image-thumb { max-height: 120px; max-width: 100%; object-fit: contain; display: block; }`. No existing spinner/loading-indicator CSS class exists anywhere in this codebase to reuse (`.cm-image-uploading` is an opacity+italic text treatment, not a spinner) — add a minimal new one:

```css
.diff-image-loading { width: 24px; height: 24px; border: 2px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: diff-image-spin 0.6s linear infinite; }
@keyframes diff-image-spin { to { transform: rotate(360deg); } }
```

## Phase 1 — local docs

**Files:** `client/src/history.ts`, `client/src/app.ts`, `client/src/components/VersionHistory.svelte`, `client/src/diff-image-row.ts` (new), `client/src/components/DiffView.svelte`, `client/src/style.css`.

- `Snapshot` gains `images?: Record<string, string>`. `appendSnapshot(docId, content, now, images?)` and `maybeSnapshotVersion(docId, content, now?, images?)` append the new parameter at the **end**, after `now` — not before it. `history.test.ts`'s 9 existing tests all call `maybeSnapshotVersion(docId, content, now)` positionally; inserting `images` before `now` would silently break every one of them (each `now` argument would land in the new `images` slot instead). Appending at the end means those 9 calls keep working unchanged (`images` defaults to `undefined`) — only `app.ts`'s one call site needs updating. Old stored records simply lack the field (no migration needed — `IDBObjectStore` has no schema to migrate, missing keys just read as `undefined`).
- `app.ts:1307`'s call site becomes `maybeSnapshotVersion(doc.id, doc.content, doc.images)`.
- `getVersionContent` (returns just content today) is joined by a new `getVersionImages(docId, versionId): Promise<Record<string, string> | undefined>` — kept as a separate function rather than changing `getVersionContent`'s return shape, since every existing caller of `getVersionContent` (restore flows) only wants content; `VersionHistory.svelte`'s `selectVersion` is the only caller that needs both, and can call both.
- `restoreLocalVersion(docId, versionId, now?)` internally calls `getVersionContent` then `appendSnapshot(docId, content, now)` to force a new forward-snapshot (undo-safety) before returning the restored content. It now also calls `getVersionImages(docId, versionId)` alongside `getVersionContent`, passes that same `images` value into its own `appendSnapshot(docId, content, now, images)` call (so the forward-snapshot is accurate too), and returns `{ content, images }` instead of just `content` — its one caller (`VersionHistory.svelte`'s `restore()`) uses the returned `images` to call the new `replaceDocImages`.
- `restoreLocalVersionContent(docId, content, now?)` (used for repo-commit restores, where there's no existing local snapshot to look up) gains an `images` parameter appended at the end, same reasoning as above — `restoreLocalVersionContent(docId, content, now?, images?)` — passed straight through to its own internal `appendSnapshot` call. `VersionHistory.svelte`'s `restore()` passes `undefined` for `now` (to keep its default) and `selectedImages` for `images` in the repo-commit branch.
- New `replaceDocImages(docId: string, images: Record<string, string> | undefined)` in `client/src/stores/docs.ts` — `updateDoc(id, { images }); persistDocs();`. A full *replace*, not a per-key merge (`setDocImage`'s existing behavior merges one key into the current map, which would leave behind images that belonged only to the pre-restore content). Both `restore()` branches above call it with the restored version's images. Closes a pre-existing gap: restoring an old version today never restored its images either, silently leaving the restored markdown referencing keys that may no longer resolve. Same data this phase adds; near-zero marginal cost to fix alongside it.
- `VersionHistory.svelte`: new `selectedImages = $state<Record<string, string> | undefined>(undefined)`. `selectVersion` resets it to `undefined` at the top alongside its existing `selectedContent = undefined` reset (so switching versions doesn't show the previous version's images while the new one loads), then populates it in the local-unshared branch via `getVersionImages`. `<DiffView before={selectedContent ?? ""} after={$activeDocContent} beforeImages={selectedImages} afterImages={getActiveDoc()?.images} />`.
- `restore()`'s local (`entry.kind === "local"`) branch changes from `const restoredContent = await restoreLocalVersion(doc.id, entry.id); if (restoredContent !== undefined) { ...insert: restoredContent... }` to destructuring the new `{ content, images }` return shape, calling `replaceDocImages(doc.id, images)` alongside the existing `cm.dispatch({ ...insert: content })`. The repo-commit (`else`) branch's `restoreLocalVersionContent(doc.id, content)` call becomes `restoreLocalVersionContent(doc.id, content, selectedImages)`, followed by the same `replaceDocImages(doc.id, selectedImages)` call.

**Testing:** `client/src/history.test.ts` (already exists) covers `appendSnapshot`/`maybeSnapshotVersion` storing and round-tripping `images`, and that an old record with no `images` field reads back as `undefined` without throwing. `diff-image-row.test.ts` covers `parseImageOnlyLine`: exact single-image line matches, mixed text+image doesn't match, multiple images on one line doesn't match, `null` input returns `null`, surrounding whitespace is trimmed. `DiffView.svelte` verified live (no component-test infra in this codebase, consistent with the GitHub-style-diff-view work) — a version with a changed image, one with an added/removed image, one with a broken/missing ref, one still-loading state faked via a delayed prop.

## Phase 2 — shared docs

**Files:** `src/workspace-room.ts`, its test file, `client/src/history.ts` (the shared-doc HTTP wrapper functions), `client/src/components/VersionHistory.svelte`.

- `Snapshot` interface (server-side) gains `images?: Record<string, string>`.
- `maybeSnapshot`/`forceSnapshot` extract `docRoom.doc.getMap<string>("images")` into a plain object (`Object.fromEntries(map.entries())`, `undefined` when the map is empty) at snapshot time — the data is already present via normal Yjs sync (`client/src/collab.ts`'s `createDocBinding` creates this same `images` Y.Map client-side and it replicates like any other Yjs type); this is a read of already-synced state, not new sync plumbing.
- `handleVersionContentRequest` already returns the whole `Snapshot` object as JSON (`Response.json(snap)`) — once the interface gains `images`, that field appears in the response automatically, no handler code change needed there.
- **Not mirroring Phase 1's `getVersionContent`/`getVersionImages` split.** Phase 1 splits them because both reads pull from the same already-in-memory IndexedDB result at zero extra cost. Here, content and images arrive together in **one** HTTP response (`handleVersionContentRequest`'s `Snapshot` JSON) — a second `getSharedVersionImages` fetch would be a genuinely wasted network round trip for data already in hand. Instead, `getSharedVersionContent` is replaced outright by `getSharedVersionSnapshot(workspaceId: string, docId: string, versionId: string): Promise<{ content: string; images: Record<string, string> | undefined } | undefined>` — it has exactly one caller (`VersionHistory.svelte`'s `selectVersion`), so changing its shape is a clean, contained change.
- `restoreSharedVersion` (restoring one of the shared doc's own tracked snapshots) — already propagates through the normal Yjs sync channel (per `history.ts`'s existing comment); the server-side `handleVersionRestoreRequest` needs to also write the snapshot's `images` back into the `images` Y.Map, inside the same `doc.transact(...)` block that already restores the text — a full replace (delete every existing key, then set each of the snapshot's), mirroring Phase 1's `replaceDocImages` semantics, not a merge. **`restoreSharedVersionContent`/`handleVersionRestoreContentRequest` (restoring a repo-commit's content into a shared doc) are explicitly out of scope for Phase 2** — repo-commit images don't exist anywhere yet (that's Phase 4); wiring images through this path belongs there, where it's actually exercised end-to-end, not here as unused plumbing.
- `VersionHistory.svelte`: `selectVersion`'s shared branch calls `getSharedVersionSnapshot` and sets both `selectedContent` and `selectedImages` from its single result.

**Testing:** `src/workspace-room.test.ts` (already exists) — a snapshot taken while the doc's `images` Y.Map has entries includes them in the stored `Snapshot`; a restore writes `images` back into the Y.Map, observable via `docRoom.doc.getMap("images").toJSON()`.

## Phase 3 — legacy `collab-room.ts`

**Files:** `src/collab-room.ts`, its test file.

Identical pattern to Phase 2, applied to the single-document room still used for docs that haven't gone through `migrateLegacyDoc` yet (see `client/src/collab.ts`'s `migrateLegacyDoc`). Same `Snapshot.images` field, same `getMap("images")` extraction at snapshot time, same restore-writes-images-back behavior. `client/src/history.ts`'s shared-doc wrapper functions are shared between the workspace-room and collab-room server paths already (same HTTP shape), so no additional client-side wiring beyond Phase 2's.

**Testing:** `src/collab-room.test.ts` (already exists), mirroring Phase 2's two new tests.

## Phase 4 — repo-commit diffs

**Files:** `client/src/components/VersionHistory.svelte`.

- When a commit entry is selected, after `fetchCommitContent` resolves, scan the raw content for asset refs: `[...content.matchAll(/!\[[^\]]*\]\((assets\/[^)]+)\)/g)].map(m => m[1])` (same pattern `repo-sync.ts`'s `pullFromRepo`/`fetchAndApply` already uses for the equivalent scan during a real pull).
- Fetch each asset path via the **same** `/api/repo/{owner}/{repo}/contents/{path}?ref={sha}` endpoint `fetchCommitContent` itself already uses for the file — called again per asset path, at the same commit `sha`. No server-side changes needed; this endpoint already accepts an arbitrary path + ref.
- `selectedImages` starts `undefined` when a commit is selected (before the asset scan/fetch resolves) — `DiffView` shows loading spinners for any image-only lines during this window — then becomes the resolved `{ [assetPath]: dataUrl }` map once all fetches settle. Keyed by the **raw** `assets/slug/...` path exactly as it appears in the commit text (not rewritten to the internal `img-key` format — that rewrite is pull-specific, per `resolveImagesFromPull`, and never applies to a commit's own raw text).
- `afterImages` for a repo-commit diff is still just `getActiveDoc()?.images` (the current local doc, no fetch needed) — same as every other phase.

**Testing:** a pure helper for the asset-ref-scan (extracted so it's Vitest-testable without mocking `fetch`), plus live verification: select a commit whose content includes an image, confirm the before-thumbnail loads (and shows a spinner briefly first), confirm a commit predating an image add correctly shows no before-thumbnail for that line.

## Execution order

Phase 1 first (builds the shared rendering foundation used by all others, ships the visible feature for the most common case). Phases 2-4 are independent of each other once Phase 1 lands — any order after that.
