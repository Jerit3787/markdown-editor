# Repo Push Content Fidelity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pushing a document to a linked GitHub repo faithfully reproduces its content — a mermaid diagram's real source ends up in the pushed file (not its internal reference key), and a document's actual name/casing is preserved in its repo filename.

**Architecture:** Two small, independent pure-function fixes in `client/src/repo-sync.ts`: `rewriteImagesForPush` gains a call to the already-existing `resolveDiagramRefs` helper before its image-ref rewriting runs, and `slugifyDocName` drops its forced lowercasing.

**Tech Stack:** TypeScript, Vitest.

## Global Constraints

- Diagrams are inlined as real mermaid source directly in the pushed markdown, never pushed as separate asset files (unlike images).
- `slugifyDocName`'s lowercase removal and its character-allowlist widening (`[^a-z0-9]+` → `[^a-zA-Z0-9]+`) must ship together — dropping only the lowercase call would hyphenate away every uppercase letter.
- No retroactive rename/re-push of already-linked documents — both changes only affect a document's *first* push (see spec's Non-goals).

---

### Task 1: Resolve diagram refs before pushing

**Files:**
- Modify: `client/src/repo-sync.ts`
- Test: `client/src/repo-sync.test.ts`

**Interfaces:**
- Consumes: `resolveDiagramRefs(text: string, diagrams: Record<string, string> | undefined): string` (already exported from `./diagram-refs`, unchanged).
- Produces: `rewriteImagesForPush`'s existing exported signature is unchanged — only its internal behavior changes (it now actually uses the `diagrams` parameter it already accepted).

- [ ] **Step 1: Write the failing tests**

In `client/src/repo-sync.test.ts`, find:

```ts
describe("rewriteImagesForPush", () => {
  it("rewrites an image ref to a relative assets path and returns it as an asset to push", () => {
    const result = rewriteImagesForPush("![a photo](img-1)", "my-notes", { "img-1": "data:image/png;base64,aGVsbG8=" }, undefined);
    expect(result.content).toBe("![a photo](assets/my-notes/img-1.png)");
    expect(result.assets).toEqual([{ path: "assets/my-notes/img-1.png", dataUrl: "data:image/png;base64,aGVsbG8=" }]);
  });

  it("leaves refs with no matching image/diagram untouched", () => {
    const result = rewriteImagesForPush("![x](https://example.com/x.png)", "my-notes", {}, undefined);
    expect(result.content).toBe("![x](https://example.com/x.png)");
    expect(result.assets).toEqual([]);
  });
```

Change to:

```ts
describe("rewriteImagesForPush", () => {
  it("rewrites an image ref to a relative assets path and returns it as an asset to push", () => {
    const result = rewriteImagesForPush("![a photo](img-1)", "my-notes", { "img-1": "data:image/png;base64,aGVsbG8=" }, undefined);
    expect(result.content).toBe("![a photo](assets/my-notes/img-1.png)");
    expect(result.assets).toEqual([{ path: "assets/my-notes/img-1.png", dataUrl: "data:image/png;base64,aGVsbG8=" }]);
  });

  it("leaves refs with no matching image/diagram untouched", () => {
    const result = rewriteImagesForPush("![x](https://example.com/x.png)", "my-notes", {}, undefined);
    expect(result.content).toBe("![x](https://example.com/x.png)");
    expect(result.assets).toEqual([]);
  });

  it("resolves a mermaid diagram ref to its real source before pushing", () => {
    const content = "Some text\n\n```mermaid\ndiagram\n```\n\nMore text";
    const result = rewriteImagesForPush(content, "my-notes", undefined, { diagram: "graph TD\n  A --> B" });
    expect(result.content).toBe("Some text\n\n```mermaid\ngraph TD\n  A --> B\n```\n\nMore text");
    expect(result.assets).toEqual([]);
  });

  it("leaves a mermaid fence unchanged when its ref has no matching diagram", () => {
    const content = "```mermaid\nunknown-ref\n```";
    const result = rewriteImagesForPush(content, "my-notes", undefined, { diagram: "graph TD\n  A --> B" });
    expect(result.content).toBe(content);
    expect(result.assets).toEqual([]);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run client/src/repo-sync.test.ts`
Expected: FAIL — the two new tests fail because `rewriteImagesForPush` never resolves diagram refs yet (the fence's body is currently left as the literal ref key).

- [ ] **Step 3: Implement the fix**

In `client/src/repo-sync.ts`, find:

```ts
export function rewriteImagesForPush(
  content: string,
  docSlug: string,
  images: Record<string, string> | undefined,
  diagrams: Record<string, string> | undefined
): { content: string; assets: ImageAsset[] } {
  const assets: ImageAsset[] = [];
  const seenRefs = new Map<string, string>(); // ref -> assigned assets path, so repeats reuse the same path
  const newContent = content.replace(MARKDOWN_IMAGE_RE, (match, alt, ref) => {
    const dataUrl = (images && images[ref]) || (diagrams && diagrams[ref]);
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

Change to:

```ts
export function rewriteImagesForPush(
  content: string,
  docSlug: string,
  images: Record<string, string> | undefined,
  diagrams: Record<string, string> | undefined
): { content: string; assets: ImageAsset[] } {
  // A mermaid diagram's fence body is just a short reference key (see
  // diagram-refs.ts) — resolve it back to real source BEFORE the image
  // regex below runs, matching exportAs("md") and getResolvedContent()'s
  // (Gist publish) own established pattern. Diagrams are inlined as text
  // directly in the pushed markdown, not pushed as separate asset files
  // the way images are — GitHub renders ```mermaid fences natively.
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

Now add the import. Find:

```ts
import { workspacesStore, createWorkspace, setWorkspaceRepoLink, switchWorkspace } from "./stores/workspaces";
```

Change to:

```ts
import { workspacesStore, createWorkspace, setWorkspaceRepoLink, switchWorkspace } from "./stores/workspaces";
import { resolveDiagramRefs } from "./diagram-refs";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run client/src/repo-sync.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit -p client/tsconfig.json`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add client/src/repo-sync.ts client/src/repo-sync.test.ts
git commit -m "fix: resolve mermaid diagram refs to real source before pushing to a repo"
```

---

### Task 2: Preserve filename casing

**Files:**
- Modify: `client/src/repo-sync.ts`
- Test: `client/src/repo-sync.test.ts`

**Interfaces:**
- Produces: `slugifyDocName(name: string): string` (existing exported signature unchanged — only its output changes: case-preserving instead of forced-lowercase).

- [ ] **Step 1: Write the failing tests**

In `client/src/repo-sync.test.ts`, find:

```ts
describe("slugifyDocName", () => {
  it("lowercases, replaces spaces and punctuation with hyphens", () => {
    expect(slugifyDocName("My Notes!")).toBe("my-notes");
  });
  it("falls back to untitled for empty or all-punctuation names", () => {
    expect(slugifyDocName("")).toBe("untitled");
    expect(slugifyDocName("!!!")).toBe("untitled");
  });
});
```

Change to:

```ts
describe("slugifyDocName", () => {
  it("preserves case while replacing spaces and punctuation with hyphens", () => {
    expect(slugifyDocName("My Notes!")).toBe("My-Notes");
  });
  it("falls back to untitled for empty or all-punctuation names", () => {
    expect(slugifyDocName("")).toBe("untitled");
    expect(slugifyDocName("!!!")).toBe("untitled");
  });
  it("passes digits and existing hyphens through unchanged", () => {
    expect(slugifyDocName("Q3-2026 Report")).toBe("Q3-2026-Report");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run client/src/repo-sync.test.ts`
Expected: FAIL — `slugifyDocName("My Notes!")` still returns `"my-notes"`, not `"My-Notes"`.

- [ ] **Step 3: Implement the fix**

In `client/src/repo-sync.ts`, find:

```ts
export function slugifyDocName(name: string): string {
  const slug = (name || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "untitled";
}
```

Change to:

```ts
export function slugifyDocName(name: string): string {
  const slug = (name || "")
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "untitled";
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run client/src/repo-sync.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit -p client/tsconfig.json`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add client/src/repo-sync.ts client/src/repo-sync.test.ts
git commit -m "fix: preserve document name casing in repo filenames instead of forcing lowercase"
```

---

### Task 3: Final verification

**Files:** None (verification only).

- [ ] **Step 1: Full test suite**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 2: Both typechecks**

Run:
```bash
npx tsc --noEmit -p tsconfig.json
npx tsc --noEmit -p client/tsconfig.json
```
Expected: both clean.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: succeeds (pre-existing chunk-size warnings are fine and unrelated).

- [ ] **Step 4: Manual verification**

Both fixes are pure functions with full automated coverage from Tasks 1
and 2 — no manual verification is strictly required. If you want to see
it live anyway: link a workspace containing a document with a mermaid
diagram and a document named with mixed case (e.g. "My Project Notes")
to a repo, push, and check the repo on GitHub — the diagram's file should
contain real mermaid source (rendered inline by GitHub), and the second
document's filename should read `My-Project-Notes.md`, not
`my-project-notes.md`.
