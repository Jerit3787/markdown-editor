// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { slugifyDocName, dedupeRepoPath, rewriteImagesForPush, resolveImagesFromPull, planPull, type TreeEntry } from "./repo-sync";
import type { Doc } from "./types";

function fakeDoc(overrides: Partial<Doc>): Doc {
  return { id: "d1", name: "a", content: "", updatedAt: 0, createdAt: 0, workspaceId: "w1", ...overrides };
}

describe("slugifyDocName", () => {
  it("lowercases, replaces spaces and punctuation with hyphens", () => {
    expect(slugifyDocName("My Notes!")).toBe("my-notes");
  });
  it("falls back to untitled for empty or all-punctuation names", () => {
    expect(slugifyDocName("")).toBe("untitled");
    expect(slugifyDocName("!!!")).toBe("untitled");
  });
});

describe("dedupeRepoPath", () => {
  it("returns the base path unchanged when not taken", () => {
    expect(dedupeRepoPath("notes.md", new Set())).toBe("notes.md");
  });
  it("appends -2, -3... before the extension until free", () => {
    expect(dedupeRepoPath("notes.md", new Set(["notes.md"]))).toBe("notes-2.md");
    expect(dedupeRepoPath("notes.md", new Set(["notes.md", "notes-2.md"]))).toBe("notes-3.md");
  });
});

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
});

describe("resolveImagesFromPull", () => {
  it("resolves an assets-relative link back to an internal ref and an images entry", () => {
    const result = resolveImagesFromPull("![a photo](assets/my-notes/img-1.png)", "my-notes", {
      "assets/my-notes/img-1.png": "data:image/png;base64,aGVsbG8=",
    });
    expect(result.content).toMatch(/^!\[a photo\]\(img-[a-z0-9]+-\d+\)$/);
    const ref = result.content.match(/\(([^)]+)\)/)![1]!;
    expect(result.images[ref]).toBe("data:image/png;base64,aGVsbG8=");
  });

  it("leaves links with no matching blob untouched", () => {
    const result = resolveImagesFromPull("![x](https://example.com/x.png)", "my-notes", {});
    expect(result.content).toBe("![x](https://example.com/x.png)");
    expect(result.images).toEqual({});
  });
});

describe("planPull", () => {
  it("creates a new doc for a tree entry with no matching repoPath", () => {
    const entries: TreeEntry[] = [{ path: "a.md", sha: "s1", type: "blob" }];
    const plan = planPull(entries, [], new Set());
    expect(plan.creates).toEqual([{ repoPath: "a.md", sha: "s1" }]);
    expect(plan.updates).toEqual([]);
    expect(plan.conflicts).toEqual([]);
    expect(plan.deletions).toEqual([]);
  });

  it("skips a doc whose SHA already matches", () => {
    const entries: TreeEntry[] = [{ path: "a.md", sha: "s1", type: "blob" }];
    const docs = [fakeDoc({ repoPath: "a.md", repoSha: "s1" })];
    const plan = planPull(entries, docs, new Set());
    expect(plan.creates).toEqual([]);
    expect(plan.updates).toEqual([]);
    expect(plan.conflicts).toEqual([]);
  });

  it("queues an update when the SHA differs and the doc has no local edits since last sync", () => {
    const entries: TreeEntry[] = [{ path: "a.md", sha: "s2", type: "blob" }];
    const docs = [fakeDoc({ id: "d1", repoPath: "a.md", repoSha: "s1" })];
    const plan = planPull(entries, docs, new Set());
    expect(plan.updates).toEqual([{ docId: "d1", repoPath: "a.md", sha: "s2" }]);
    expect(plan.conflicts).toEqual([]);
  });

  it("queues a conflict when the SHA differs and the doc has local edits since last sync", () => {
    const entries: TreeEntry[] = [{ path: "a.md", sha: "s2", type: "blob" }];
    const docs = [fakeDoc({ id: "d1", repoPath: "a.md", repoSha: "s1", content: "local edit" })];
    const plan = planPull(entries, docs, new Set(["d1"]));
    expect(plan.updates).toEqual([]);
    expect(plan.conflicts).toEqual([{ docId: "d1", repoPath: "a.md", localContent: "local edit", remoteSha: "s2" }]);
  });

  it("queues a deletion for a doc whose repoPath is no longer in the tree", () => {
    const docs = [fakeDoc({ id: "d1", repoPath: "gone.md", repoSha: "s1" })];
    const plan = planPull([], docs, new Set());
    expect(plan.deletions).toEqual([{ docId: "d1", repoPath: "gone.md" }]);
  });

  it("ignores docs with no repoPath (never synced) entirely", () => {
    const docs = [fakeDoc({ id: "d1" })];
    const plan = planPull([], docs, new Set());
    expect(plan.deletions).toEqual([]);
  });
});
