# Image Rendering in Diffs — Phase 1 (Local Docs) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make images actually render in the Version History diff view for local (never-shared) documents, with per-snapshot image accuracy — a historical version shows the images it actually had, not whatever the current doc happens to have now.

**Architecture:** A new pure helper (`parseImageOnlyLine`) detects lines that are *only* an image reference; `DiffView.svelte` renders those as before/after thumbnails per-cell instead of text, using two new optional image-map props. `history.ts`'s local IndexedDB snapshots gain an `images` field captured alongside content. `VersionHistory.svelte` wires the selected snapshot's images (before) and the live doc's images (after) into `DiffView`.

**Tech Stack:** Svelte 5 (runes), IndexedDB (via `fake-indexeddb` in tests), Vitest.

**Spec:** `docs/superpowers/specs/2026-08-18-diff-view-image-rendering-design.md`

## Global Constraints

- Only a line that, trimmed, is *exactly* one image reference (`^!\[alt\]\(ref\)$`) gets image treatment — mixed text+image lines and multi-image lines keep today's plain-text rendering.
- `"same"` rows/lines never get image treatment — only `"changed"`/`"removed"`/`"added"`.
- New parameters append at the **end** of existing function signatures, never inserted before an existing positional parameter — `history.test.ts` has 9 existing tests calling `maybeSnapshotVersion(docId, content, now)` positionally; breaking that ordering silently breaks all of them.
- Missing `images` on an old stored `Snapshot` record must read back as `undefined` without throwing — no IndexedDB schema migration.
- No component-test infrastructure exists for `.svelte` files in this codebase — `DiffView.svelte`/`VersionHistory.svelte` changes are verified live in the browser.

---

### Task 1: `parseImageOnlyLine` — image-only line detection

**Files:**
- Create: `client/src/diff-image-row.ts`
- Test: `client/src/diff-image-row.test.ts`

**Interfaces:**
- Produces: `parseImageOnlyLine(text: string | null): { alt: string; ref: string } | null`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from "vitest";
import { parseImageOnlyLine } from "./diff-image-row";

describe("parseImageOnlyLine", () => {
  it("matches a line that is exactly one image reference", () => {
    expect(parseImageOnlyLine("![a photo](img-key)")).toEqual({ alt: "a photo", ref: "img-key" });
  });

  it("matches with an empty alt text", () => {
    expect(parseImageOnlyLine("![](img-key)")).toEqual({ alt: "", ref: "img-key" });
  });

  it("trims surrounding whitespace before matching", () => {
    expect(parseImageOnlyLine("  ![a](img-key)  ")).toEqual({ alt: "a", ref: "img-key" });
  });

  it("returns null for null input", () => {
    expect(parseImageOnlyLine(null)).toBeNull();
  });

  it("returns null for a line mixing text and an image reference", () => {
    expect(parseImageOnlyLine("See this: ![a](img-key)")).toBeNull();
  });

  it("returns null for a line with two image references", () => {
    expect(parseImageOnlyLine("![a](img-1) ![b](img-2)")).toBeNull();
  });

  it("returns null for plain text with no image reference", () => {
    expect(parseImageOnlyLine("just a normal line")).toBeNull();
  });

  it("returns null for an empty line", () => {
    expect(parseImageOnlyLine("")).toBeNull();
  });

  it("matches a repo-style assets path ref", () => {
    expect(parseImageOnlyLine("![alt text](assets/my-notes/foo.png)")).toEqual({ alt: "alt text", ref: "assets/my-notes/foo.png" });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run client/src/diff-image-row.test.ts`
Expected: FAIL — `client/src/diff-image-row.ts` doesn't exist yet.

- [ ] **Step 3: Implement `parseImageOnlyLine`**

```ts
// Detects a diff line that IS an image reference and nothing else — the
// only shape DiffView.svelte renders as a thumbnail instead of text. A
// line diff can't sensibly show an inline <img> the way markdown prose
// can (no way to "diff" pixels line-by-line, and an inline image would
// blow out row height), so this deliberately does NOT match a line that
// mixes text with an image ref, or has more than one — those keep
// rendering as plain text, same as before this feature existed.
const IMAGE_ONLY_LINE_RE = /^!\[([^\]]*)\]\(([^)\s]+)\)$/;

export function parseImageOnlyLine(text: string | null): { alt: string; ref: string } | null {
  if (text === null) return null;
  const match = text.trim().match(IMAGE_ONLY_LINE_RE);
  return match ? { alt: match[1]!, ref: match[2]! } : null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run client/src/diff-image-row.test.ts`
Expected: PASS (9/9)

- [ ] **Step 5: Commit**

```bash
git add client/src/diff-image-row.ts client/src/diff-image-row.test.ts
git commit -m "feat: add image-only diff line detection"
```

---

### Task 2: `history.ts` — per-snapshot image storage

**Files:**
- Modify: `client/src/history.ts`
- Test: `client/src/history.test.ts`

**Interfaces:**
- Produces: `Snapshot.images?: Record<string, string>`. `maybeSnapshotVersion(docId: string, content: string, now?: number, images?: Record<string, string>): Promise<void>` (images appended last). `getVersionImages(docId: string, versionId: string): Promise<Record<string, string> | undefined>`.

- [ ] **Step 1: Write the failing tests**

Add to `client/src/history.test.ts` (update the import line and append a new describe block):

```ts
import { maybeSnapshotVersion, listVersions, getVersionContent, getVersionImages, restoreLocalVersion, deleteHistory } from "./history";
```

```ts
describe("local version history — images", () => {
  it("stores images alongside content and getVersionImages returns them", async () => {
    await maybeSnapshotVersion("doc-images", "hello", 1_000, { "img-1": "data:image/png;base64,aGk=" });
    const [v] = await listVersions("doc-images");
    expect(await getVersionImages("doc-images", v!.id)).toEqual({ "img-1": "data:image/png;base64,aGk=" });
  });

  it("getVersionImages returns undefined for a snapshot taken with no images argument", async () => {
    await maybeSnapshotVersion("doc-no-images", "hello", 1_000);
    const [v] = await listVersions("doc-no-images");
    expect(await getVersionImages("doc-no-images", v!.id)).toBeUndefined();
  });

  it("getVersionImages returns undefined for an unknown version id", async () => {
    expect(await getVersionImages("doc-images-unknown", "nonexistent")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run client/src/history.test.ts`
Expected: FAIL — `getVersionImages` isn't exported yet, and `maybeSnapshotVersion` doesn't accept a 4th argument.

- [ ] **Step 3: Add `images` to `Snapshot` and thread it through storage**

In `client/src/history.ts`, update the `Snapshot` interface:

```ts
export interface Snapshot {
  id: string;
  timestamp: number;
  content: string;
  images?: Record<string, string>;
}
```

Update `appendSnapshot` (append `images` as a new last parameter):

```ts
async function appendSnapshot(docId: string, content: string, now: number, images?: Record<string, string>): Promise<void> {
  const snapshots = await getHistory(docId);
  snapshots.push({ id: uid(), timestamp: now, content, images });
  while (snapshots.length > MAX_SNAPSHOTS) snapshots.shift();
  await putHistory(docId, snapshots);
}
```

Update `maybeSnapshotVersion` (append `images` as a new last parameter, after `now`):

```ts
export async function maybeSnapshotVersion(docId: string, content: string, now: number = Date.now(), images?: Record<string, string>): Promise<void> {
  try {
    const snapshots = await getHistory(docId);
    const last = snapshots[snapshots.length - 1];
    if (last) {
      if (now - last.timestamp < SNAPSHOT_INTERVAL_MS) return;
      if (last.content === content) return;
    }
    await appendSnapshot(docId, content, now, images);
  } catch (err) {
    // best-effort — see comment above
  }
}
```

Add `getVersionImages` right after `getVersionContent`:

```ts
export async function getVersionImages(docId: string, versionId: string): Promise<Record<string, string> | undefined> {
  const snapshots = await getHistory(docId);
  return snapshots.find((s) => s.id === versionId)?.images;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run client/src/history.test.ts`
Expected: PASS (all tests, including the 3 new ones and the 9 pre-existing ones unmodified)

- [ ] **Step 5: Commit**

```bash
git add client/src/history.ts client/src/history.test.ts
git commit -m "feat: store images alongside local version history snapshots"
```

---

### Task 3: `history.ts` — restore flow returns and accepts images

**Files:**
- Modify: `client/src/history.ts`
- Test: `client/src/history.test.ts`

**Interfaces:**
- Consumes: `getVersionImages`, `appendSnapshot(docId, content, now, images?)` from Task 2.
- Produces: `restoreLocalVersion(docId: string, versionId: string, now?: number): Promise<{ content: string; images: Record<string, string> | undefined } | undefined>` (return type changed from `string | undefined`). `restoreLocalVersionContent(docId: string, content: string, now?: number, images?: Record<string, string>): Promise<void>` (images appended last).

- [ ] **Step 1: Write the failing test**

The existing test `"restoreLocalVersion returns the content and force-appends a new snapshot"` in `client/src/history.test.ts` currently asserts `expect(content).toBe("v1")` against the old string return. Replace that whole test with:

```ts
  it("restoreLocalVersion returns the content and images, and force-appends a new snapshot", async () => {
    await maybeSnapshotVersion("doc-restore", "v1", 1_000, { "img-1": "data:image/png;base64,aGk=" });
    await maybeSnapshotVersion("doc-restore", "v2", 1_000 + 6 * 60 * 1000);
    const [v1] = (await listVersions("doc-restore")).slice(-1);
    const result = await restoreLocalVersion("doc-restore", v1!.id, 1_000 + 6.1 * 60 * 1000);
    expect(result).toEqual({ content: "v1", images: { "img-1": "data:image/png;base64,aGk=" } });
    const versions = await listVersions("doc-restore");
    expect(versions).toHaveLength(3);
    expect(await getVersionContent("doc-restore", versions[0]!.id)).toBe("v1");
    expect(await getVersionImages("doc-restore", versions[0]!.id)).toEqual({ "img-1": "data:image/png;base64,aGk=" });
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run client/src/history.test.ts`
Expected: FAIL — `restoreLocalVersion` still returns a plain string.

- [ ] **Step 3: Update `restoreLocalVersion` and `restoreLocalVersionContent`**

```ts
export async function restoreLocalVersion(
  docId: string,
  versionId: string,
  now: number = Date.now()
): Promise<{ content: string; images: Record<string, string> | undefined } | undefined> {
  const content = await getVersionContent(docId, versionId);
  if (content === undefined) return undefined;
  const images = await getVersionImages(docId, versionId);
  await appendSnapshot(docId, content, now, images);
  return { content, images };
}
```

```ts
export async function restoreLocalVersionContent(docId: string, content: string, now: number = Date.now(), images?: Record<string, string>): Promise<void> {
  await appendSnapshot(docId, content, now, images);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run client/src/history.test.ts`
Expected: PASS (all tests)

- [ ] **Step 5: Commit**

```bash
git add client/src/history.ts client/src/history.test.ts
git commit -m "feat: restore local versions' images alongside their content"
```

---

### Task 4: `docs.ts` — `replaceDocImages` and the `app.ts` snapshot call site

**Files:**
- Modify: `client/src/stores/docs.ts`
- Modify: `client/src/app.ts:1307`
- Test: `client/src/stores/docs.test.ts`

**Interfaces:**
- Produces: `replaceDocImages(docId: string, images: Record<string, string> | undefined): void`.

- [ ] **Step 1: Write the failing test**

Add to `client/src/stores/docs.test.ts` (inside the existing `describe("docs store — workspace integration", ...)` block, following that file's established `await import("./docs")` pattern seen elsewhere in the same file):

```ts
  it("replaceDocImages fully replaces a doc's image map, not merges into it", async () => {
    const { docsStore, replaceDocImages } = await import("./docs");
    const { createWorkspace } = await import("./workspaces");
    const ws = createWorkspace("Images");
    docsStore.set([{ id: "d1", name: "D1", content: "", updatedAt: 1, createdAt: 1, workspaceId: ws.id, images: { old: "data:old" } }]);
    replaceDocImages("d1", { new: "data:new" });
    const doc = get(docsStore).find((d) => d.id === "d1")!;
    expect(doc.images).toEqual({ new: "data:new" });
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run client/src/stores/docs.test.ts`
Expected: FAIL — `replaceDocImages` isn't exported yet.

- [ ] **Step 3: Add `replaceDocImages` next to `setDocImage`**

In `client/src/stores/docs.ts`, add right after `setDocImage`'s definition:

```ts
// Full replace, not a per-key merge (setDocImage's behavior) — used when
// restoring a historical version, which must leave the doc's images
// looking exactly like that version did, not layer its images on top of
// whatever the doc currently has.
export function replaceDocImages(docId: string, images: Record<string, string> | undefined) {
  updateDoc(docId, { images });
  persistDocs();
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run client/src/stores/docs.test.ts`
Expected: PASS

- [ ] **Step 5: Update `app.ts`'s snapshot call site**

In `client/src/app.ts`, `saveNow()` (around line 1307):

```ts
      void maybeSnapshotVersion(doc.id, doc.content, undefined, doc.images);
```

replacing the current `void maybeSnapshotVersion(doc.id, doc.content);`. (`undefined` for `now` keeps its `Date.now()` default — a positional argument can't be skipped without it.)

- [ ] **Step 6: Run the full test suite and typecheck**

Run: `npm test && npx tsc --noEmit -p client/tsconfig.json`
Expected: all tests pass, no type errors.

- [ ] **Step 7: Commit**

```bash
git add client/src/stores/docs.ts client/src/stores/docs.test.ts client/src/app.ts
git commit -m "feat: add replaceDocImages and snapshot doc images on save"
```

---

### Task 5: `DiffView.svelte` — render image-only lines as thumbnails

**Files:**
- Modify: `client/src/components/DiffView.svelte`
- Modify: `client/src/style.css`

**Interfaces:**
- Consumes: `parseImageOnlyLine` from Task 1.
- Produces: `DiffView` gains two new optional props, `beforeImages?: Record<string, string>` and `afterImages?: Record<string, string>`.

- [ ] **Step 1: Replace `DiffView.svelte` in full**

```svelte
<script lang="ts">
  import { computeDiffRows, toUnifiedLines } from "../diff-lines";
  import { parseImageOnlyLine } from "../diff-image-row";

  interface Props {
    before: string;
    after: string;
    beforeImages?: Record<string, string>;
    afterImages?: Record<string, string>;
  }
  const { before, after, beforeImages, afterImages }: Props = $props();

  const rows = $derived(computeDiffRows(before, after));
  const unifiedLines = $derived(toUnifiedLines(rows));

  let mode = $state<"split" | "unified">("split");

  // images: undefined map = still loading (only ever true for repo-commit
  // diffs, a later phase) -> show a spinner. Map present but the specific
  // ref missing -> render <img src={ref}> anyway, which isn't a valid URL
  // so the browser shows its own broken-image icon (same fallback
  // convention version-preview.ts already uses).
  function resolvedSrc(ref: string, images: Record<string, string> | undefined): string | undefined {
    if (!images) return undefined;
    return images[ref] ?? ref;
  }
</script>

<div class="diff-view-mode-toggle">
  <button type="button" class:active={mode === "split"} onclick={() => (mode = "split")}>Split</button>
  <button type="button" class:active={mode === "unified"} onclick={() => (mode = "unified")}>Unified</button>
</div>

{#if mode === "split"}
  <div class="diff-view">
    {#each rows as row, i (i)}
      {@const leftImage = row.type !== "same" ? parseImageOnlyLine(row.leftText) : null}
      {@const rightImage = row.type !== "same" ? parseImageOnlyLine(row.rightText) : null}
      <div class="diff-view-row">
        <div class="diff-view-gutter">{row.leftLine ?? ""}</div>
        <div class="diff-view-cell" class:diff-removed={row.type === "changed" || row.type === "removed"}>
          {#if leftImage}
            {#if beforeImages}
              <img class="diff-image-thumb" src={resolvedSrc(leftImage.ref, beforeImages)} alt={leftImage.alt} />
            {:else}
              <div class="diff-image-loading"></div>
            {/if}
          {:else if row.leftSegments}
            {#each row.leftSegments as seg, j (j)}<span class:diff-segment-changed={seg.changed}>{seg.text}</span>{/each}
          {:else}
            {row.leftText ?? ""}
          {/if}
        </div>
        <div class="diff-view-gutter">{row.rightLine ?? ""}</div>
        <div class="diff-view-cell" class:diff-added={row.type === "changed" || row.type === "added"}>
          {#if rightImage}
            {#if afterImages}
              <img class="diff-image-thumb" src={resolvedSrc(rightImage.ref, afterImages)} alt={rightImage.alt} />
            {:else}
              <div class="diff-image-loading"></div>
            {/if}
          {:else if row.rightSegments}
            {#each row.rightSegments as seg, j (j)}<span class:diff-segment-changed={seg.changed}>{seg.text}</span>{/each}
          {:else}
            {row.rightText ?? ""}
          {/if}
        </div>
      </div>
    {/each}
  </div>
{:else}
  <div class="diff-view diff-view-unified">
    {#each unifiedLines as line, i (i)}
      {@const lineImage = line.type !== "same" ? parseImageOnlyLine(line.text) : null}
      {@const images = line.type === "removed" ? beforeImages : line.type === "added" ? afterImages : undefined}
      <div class="diff-view-row">
        <div class="diff-view-gutter">{line.leftLine ?? ""}</div>
        <div class="diff-view-gutter">{line.rightLine ?? ""}</div>
        <div class="diff-view-cell" class:diff-removed={line.type === "removed"} class:diff-added={line.type === "added"}>
          {#if lineImage}
            {#if images}
              <img class="diff-image-thumb" src={resolvedSrc(lineImage.ref, images)} alt={lineImage.alt} />
            {:else}
              <div class="diff-image-loading"></div>
            {/if}
          {:else if line.segments}
            {#each line.segments as seg, j (j)}<span class:diff-segment-changed={seg.changed}>{seg.text}</span>{/each}
          {:else}
            {line.text}
          {/if}
        </div>
      </div>
    {/each}
  </div>
{/if}
```

- [ ] **Step 2: Add image-thumbnail and loading-spinner CSS**

In `client/src/style.css`, append after the existing `.diff-view-unified .diff-view-row` rule:

```css
.diff-image-thumb { max-height: 120px; max-width: 100%; object-fit: contain; display: block; }
.diff-image-loading { width: 24px; height: 24px; border: 2px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: diff-image-spin 0.6s linear infinite; }
@keyframes diff-image-spin { to { transform: rotate(360deg); } }
```

- [ ] **Step 3: Run the full test suite and typecheck**

Run: `npm test && npx tsc --noEmit -p client/tsconfig.json`
Expected: all tests pass, no type errors. (No new automated tests in this task — `DiffView.svelte` has no component-test infrastructure; verified live in Task 6.)

- [ ] **Step 4: Commit**

```bash
git add client/src/components/DiffView.svelte client/src/style.css
git commit -m "feat: render image-only diff lines as before/after thumbnails"
```

---

### Task 6: `VersionHistory.svelte` — wire selected-version images through

**Files:**
- Modify: `client/src/components/VersionHistory.svelte`

**Interfaces:**
- Consumes: `getVersionImages`, `restoreLocalVersion`'s new return shape, `restoreLocalVersionContent`'s new `images` parameter (Tasks 2-3), `replaceDocImages` (Task 4), `DiffView`'s new `beforeImages`/`afterImages` props (Task 5).

- [ ] **Step 1: Import the new functions**

In `client/src/components/VersionHistory.svelte`, update the `../history` import:

```ts
  import {
    listVersions,
    getVersionContent,
    getVersionImages,
    restoreLocalVersion,
    restoreLocalVersionContent,
    listSharedVersions,
    getSharedVersionContent,
    restoreSharedVersion,
    restoreSharedVersionContent,
  } from "../history";
```

Update the `../stores/docs` import to include `replaceDocImages`:

```ts
  import { getActiveDoc, activeDocContent, replaceDocImages } from "../stores/docs";
```

- [ ] **Step 2: Add `selectedImages` state and populate it in `selectVersion`**

Add alongside the existing `let selectedContent = $state<string | undefined>(undefined);`:

```ts
  let selectedImages = $state<Record<string, string> | undefined>(undefined);
```

Replace `selectVersion` in full:

```ts
  async function selectVersion(doc: ReturnType<typeof getActiveDoc>, isShared: boolean, entry: HistoryEntry) {
    selectedId = entry.id;
    selectedEntry = entry;
    selectedContent = undefined;
    selectedImages = undefined;
    if (!doc) return;
    if (entry.kind === "local") {
      if (isShared) {
        const content = await getSharedVersionContent(doc.workspaceId, doc.id, entry.id);
        if (content === undefined) {
          showToast("Couldn't load this version's content", "error");
          return;
        }
        selectedContent = content;
      } else {
        const content = await getVersionContent(doc.id, entry.id);
        if (content === undefined) {
          showToast("Couldn't load this version's content", "error");
          return;
        }
        selectedContent = content;
        selectedImages = await getVersionImages(doc.id, entry.id);
      }
    } else {
      const content = await fetchCommitContent(doc, entry.id);
      if (content === undefined) {
        showToast("Couldn't load this version's content", "error");
        return;
      }
      selectedContent = content;
    }
  }
```

- [ ] **Step 3: Update `restore()`'s local-unshared branch**

Replace the `entry.kind === "local"` branch inside `restore()`:

```ts
    } else if (entry.kind === "local") {
      const restored = await restoreLocalVersion(doc.id, entry.id);
      if (restored !== undefined) {
        const cm = window.MDE.getEditor();
        cm.dispatch({ changes: { from: 0, to: cm.state.doc.length, insert: restored.content } });
        replaceDocImages(doc.id, restored.images);
        showToast("Version restored", "success");
        close();
      } else {
        showToast("Couldn't restore this version", "error");
      }
    } else {
```

And the final `else` branch (repo-commit restore):

```ts
    } else {
      await restoreLocalVersionContent(doc.id, content, undefined, selectedImages);
      const cm = window.MDE.getEditor();
      cm.dispatch({ changes: { from: 0, to: cm.state.doc.length, insert: content } });
      replaceDocImages(doc.id, selectedImages);
      showToast("Version restored", "success");
      close();
    }
```

- [ ] **Step 4: Pass the new props to `DiffView`**

Replace the diff-mode `DiffView` usage:

```svelte
            <DiffView before={selectedContent ?? ""} after={$activeDocContent} beforeImages={selectedImages} afterImages={getActiveDoc()?.images} />
```

- [ ] **Step 5: Run the full test suite and typecheck**

Run: `npm test && npx tsc --noEmit -p client/tsconfig.json`
Expected: all tests pass, no type errors.

- [ ] **Step 6: Commit**

```bash
git add client/src/components/VersionHistory.svelte
git commit -m "feat: wire per-snapshot images into the diff view and restore flow"
```

---

### Task 7: Live browser verification

**Files:** none (verification only).

- [ ] **Step 1: Start the dev server and seed a demo document**

Run `npm run dev:client -- --port 5220` (or the project's usual command), open the app, and seed via the browser console or `javascript_tool`: a document whose content includes an image line (`![a photo](img-1)`) with `doc.images = { "img-1": <a real data URL> }`, plus a local IndexedDB snapshot (`mde-history` DB, `docHistory` store) for the same doc with a *different* image at the same key, and a snapshot with no `images` field at all (to check the pre-existing-record fallback).

- [ ] **Step 2: Verify split mode**

Open File > Version History > Diff, select the older snapshot. Confirm:
- The image-only line renders as a before/after thumbnail pair, not raw ref text.
- Changing only the image (not surrounding text) shows both thumbnails clearly, side by side.
- The snapshot with no stored `images` shows a broken-image icon on its side (no throw, no blank crash).

- [ ] **Step 3: Verify unified mode**

Toggle to Unified. Confirm the before thumbnail and after thumbnail appear as two separate stacked rows (removed line then added line), each showing its own thumbnail, matching the same visual language as text-only changed lines already do.

- [ ] **Step 4: Verify restore brings images back**

Restore the older snapshot. Confirm the editor's image now matches what that snapshot had (open the image, or check the sidebar/File > Document Info if it surfaces image count) — not the pre-restore image.

- [ ] **Step 5: Clean up**

Stop the dev server, close any browser tabs opened for verification.

---

## Self-Review Notes

**Spec coverage:** Shared rendering design (image-only detection, per-cell thumbnails, loading/broken fallback, CSS) ✓ Tasks 1 & 5. Local per-snapshot storage (`Snapshot.images`, `appendSnapshot`/`maybeSnapshotVersion`) ✓ Task 2. Restore-images-back (`restoreLocalVersion`/`restoreLocalVersionContent`/`replaceDocImages`) ✓ Tasks 3 & 4. `app.ts` snapshot call site ✓ Task 4. `VersionHistory.svelte` wiring (`selectedImages` reset-on-switch, both restore branches, `DiffView` props) ✓ Task 6.

**Type consistency:** `parseImageOnlyLine`'s return shape (`{ alt, ref } | null`), `Snapshot.images`, `beforeImages`/`afterImages` prop names, and `replaceDocImages`'s signature are identical everywhere they're referenced across all 7 tasks.

**Placeholder scan:** No TBD/TODO; every step carries complete, exact code, including the full replaced `selectVersion` and `restore()` bodies (not diffs against code the implementer would have to reconstruct from memory).
