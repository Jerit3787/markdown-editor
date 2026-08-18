# Image Rendering in Diffs — Phase 4 (Repo-Commit Diffs) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make images render in the diff view when comparing against a repo commit — the last of the four phases from `docs/superpowers/specs/2026-08-18-diff-view-image-rendering-design.md`.

**Architecture:** Entirely separate from Phases 1-3 — a repo commit's raw text uses `assets/<slug>/...`-style path refs (not the app's internal `img-key` format), and its images live in that commit's own blob tree, not `doc.images`/any snapshot storage. When a commit is selected, scan its fetched text for asset refs and fetch each one via the same `/api/repo/{owner}/{repo}/contents/{path}?ref={sha}` endpoint already used for the file itself (called again per asset path, at the same commit sha) — no server-side changes needed.

**Tech Stack:** Svelte 5, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-18-diff-view-image-rendering-design.md`

## Global Constraints

- `selectedImages` starts `undefined` when a commit is selected (before the asset scan/fetch resolves) — `DiffView` (already built in Phase 1) shows loading spinners for any image-only lines during this window, then the resolved map replaces them once ready. This is the only phase where the `undefined` (loading) vs `{}` (loaded, nothing found) distinction in `DiffView`'s `beforeImages`/`afterImages` props actually matters — Phases 1-3 always resolve synchronously.
- Asset image data must **not** be run through `atob()` — GitHub's contents API returns binary files as base64, and the existing convention (`client/src/repo-sync.ts`'s `fetchAndApply`) keeps that base64 string as-is inside a `data:image/*;base64,...` URL. Only the *text* file content (markdown) gets `atob`'d into a JS string — an image blob must not be.
- `afterImages` for a repo-commit diff is unchanged from every other phase — `getActiveDoc()?.images`, no fetch needed (it's the current local doc).
- No server-side changes — the `/contents/{path}?ref={sha}` endpoint already accepts an arbitrary path and ref; this phase only adds client-side calls to it.

---

### Task 1: `extractAssetImageRefs` — pure asset-ref scan

**Files:**
- Modify: `client/src/diff-image-row.ts`
- Test: `client/src/diff-image-row.test.ts`

**Interfaces:**
- Produces: `extractAssetImageRefs(content: string): string[]`.

- [ ] **Step 1: Write the failing tests**

Append to `client/src/diff-image-row.test.ts`:

```ts
describe("extractAssetImageRefs", () => {
  it("finds a single assets-path image reference", () => {
    expect(extractAssetImageRefs("# Notes\n\n![a photo](assets/my-notes/foo.png)\n")).toEqual(["assets/my-notes/foo.png"]);
  });

  it("finds multiple assets-path references in one document", () => {
    const content = "![a](assets/notes/a.png)\n\ntext\n\n![b](assets/notes/b.png)\n";
    expect(extractAssetImageRefs(content)).toEqual(["assets/notes/a.png", "assets/notes/b.png"]);
  });

  it("ignores refs that aren't under assets/", () => {
    expect(extractAssetImageRefs("![internal](img-key)\n![external](https://example.com/x.png)\n")).toEqual([]);
  });

  it("returns an empty array for content with no images", () => {
    expect(extractAssetImageRefs("just some text\n")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run client/src/diff-image-row.test.ts`
Expected: FAIL — `extractAssetImageRefs` is not exported yet.

- [ ] **Step 3: Implement `extractAssetImageRefs`**

Append to `client/src/diff-image-row.ts`:

```ts
// Same pattern repo-sync.ts's pullFromRepo/fetchAndApply already uses to
// find asset references inside a repo file's raw text — kept as its own
// copy here rather than importing that one, since this call site (a repo
// COMMIT's text, not a doc mid-pull) has no docSlug/entries/blobs context
// to share with it.
export function extractAssetImageRefs(content: string): string[] {
  return [...content.matchAll(/!\[[^\]]*\]\((assets\/[^)]+)\)/g)].map((m) => m[1]!);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run client/src/diff-image-row.test.ts`
Expected: PASS (all tests, including the 4 new ones and Task 1's existing `parseImageOnlyLine` ones from Phase 1)

- [ ] **Step 5: Commit**

```bash
git add client/src/diff-image-row.ts client/src/diff-image-row.test.ts
git commit -m "feat: add asset image ref extraction for repo-commit diffs"
```

---

### Task 2: Fetch and wire repo-commit images into the diff view

**Files:**
- Modify: `client/src/components/VersionHistory.svelte`

**Interfaces:**
- Consumes: `extractAssetImageRefs` from Task 1.

- [ ] **Step 1: Import `extractAssetImageRefs`**

Add to `VersionHistory.svelte`'s existing `../diff-image-row` import (if the import doesn't exist yet, add it) — check the top of the file first: there is currently no import from `../diff-image-row` in this component (only `DiffView.svelte` imports from it). Add a new import line near the other local imports:

```ts
  import { extractAssetImageRefs } from "../diff-image-row";
```

- [ ] **Step 2: Add `fetchCommitImages`**

Add this function right after `fetchCommitContent` in `VersionHistory.svelte`:

```ts
  async function fetchCommitImages(doc: ReturnType<typeof getActiveDoc>, sha: string, content: string): Promise<Record<string, string>> {
    if (!doc?.repoPath) return {};
    const ws = get(workspacesStore).find((w) => w.id === doc.workspaceId);
    const repoLink = ws?.repoLink;
    if (!repoLink) return {};
    const assetRefs = extractAssetImageRefs(content);
    const images: Record<string, string> = {};
    for (const assetPath of assetRefs) {
      const encodedPath = assetPath.split("/").map(encodeURIComponent).join("/");
      const res = await fetch(`/api/repo/${repoLink.owner}/${repoLink.repo}/contents/${encodedPath}?ref=${encodeURIComponent(sha)}`);
      if (!res.ok) continue;
      const data = (await res.json()) as { content: string; encoding: string };
      // Never atob() this — it's binary image data, not text. Keeping the
      // base64 string as-is matches repo-sync.ts's own fetchAndApply
      // convention for the exact same kind of asset fetch during a pull.
      images[assetPath] = `data:image/*;base64,${data.content.replace(/\n/g, "")}`;
    }
    return images;
  }
```

- [ ] **Step 3: Call it from `selectVersion`'s commit branch**

Replace the `else` branch (the `entry.kind === "commit"` case) inside `selectVersion`:

```ts
    } else {
      const content = await fetchCommitContent(doc, entry.id);
      if (content === undefined) {
        showToast("Couldn't load this version's content", "error");
        return;
      }
      selectedContent = content;
      selectedImages = await fetchCommitImages(doc, entry.id, content);
    }
```

(`selectedImages` is already reset to `undefined` at the top of `selectVersion` before this branch runs — that's the loading state `DiffView` shows spinners for, between `selectedContent` being set and this `await fetchCommitImages(...)` resolving.)

- [ ] **Step 4: Run the full test suite, typecheck, and build**

Run: `npm test && npx tsc --noEmit -p client/tsconfig.json && npm run build`
Expected: all tests pass, no type errors, clean build. (No new automated test for the wiring itself — `fetchCommitImages` is a thin fetch-driven function with no existing test coverage to extend, matching this file's established convention for `fetchCommitContent`/`loadCommitEntries`; the pure ref-extraction logic it depends on is fully covered by Task 1.)

- [ ] **Step 5: Live verification (best-effort)**

Live-testing this end-to-end requires a real GitHub-authenticated session with a repo-linked workspace whose repo has a commit containing an image — not practically automatable in this environment (no headless OAuth). If a repo-linked workspace with image history is available in a real browser session, verify: selecting a commit whose text includes an `assets/...` image reference briefly shows a loading spinner (per Task 2's `DiffView` wiring) then the actual image; selecting a commit that predates the image being added shows no before-thumbnail for that line (correctly falls back to plain text, since `extractAssetImageRefs` finds nothing in that commit's own text). If no such environment is available, rely on Task 1's test coverage plus the clean typecheck/build from Step 4.

- [ ] **Step 6: Commit**

```bash
git add client/src/components/VersionHistory.svelte
git commit -m "feat: fetch and render repo-commit images in the diff view"
```

---

## Self-Review Notes

**Spec coverage:** Asset-ref scanning via the same pattern as `pullFromRepo` ✓ Task 1. Fetching each asset via the existing `/contents/{path}?ref={sha}` endpoint (no server changes) ✓ Task 2. Loading-state semantics (`undefined` while fetching, resolved map after) ✓ Task 2 Step 3's comment. `afterImages` unchanged (still `getActiveDoc()?.images`) — already true from Phase 1's Task 6, not touched by this phase.

**Type consistency:** `extractAssetImageRefs`'s signature and `fetchCommitImages`'s return shape (`Record<string, string>`, never `undefined` — an empty object when there's nothing to fetch, matching `DiffView`'s existing "map present but ref missing" broken-image fallback rather than a perpetual loading spinner) are consistent between the two tasks.

**Placeholder scan:** No TBD/TODO; every step carries complete, exact code. Step 5's live-verification limitation is stated plainly rather than glossed over.
