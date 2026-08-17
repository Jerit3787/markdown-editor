// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { get } from "svelte/store";
import {
  slugifyDocName,
  dedupeRepoPath,
  rewriteImagesForPush,
  resolveImagesFromPull,
  planPull,
  planPush,
  planCreateWorkspaceFromRepo,
  linkWorkspaceAndSync,
  markerMatchesWorkspace,
  type TreeEntry,
} from "./repo-sync";
import { docsStore } from "./stores/docs";
import { createWorkspace } from "./stores/workspaces";
import { startFakeRepoBackend, type FakeRepoBackend } from "./test-support/fake-repo-backend";
import type { Doc, Workspace } from "./types";

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

describe("markerMatchesWorkspace", () => {
  it("returns true when the marker's workspaceId matches", () => {
    expect(markerMatchesWorkspace(JSON.stringify({ workspaceId: "w1", name: "Notes" }), "w1")).toBe(true);
  });

  it("returns false for a marker naming a different workspace", () => {
    expect(markerMatchesWorkspace(JSON.stringify({ workspaceId: "w2", name: "Other" }), "w1")).toBe(false);
  });

  it("returns false for malformed JSON", () => {
    expect(markerMatchesWorkspace("not json", "w1")).toBe(false);
  });

  it("returns false for null content", () => {
    expect(markerMatchesWorkspace(null, "w1")).toBe(false);
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

describe("planPush", () => {
  it("assigns a new repoPath to a doc that has never synced", async () => {
    const docs = [fakeDoc({ id: "d1", name: "My Notes", repoPath: undefined })];
    const plan = await planPush(docs, [], false);
    expect(plan.changes).toHaveLength(1);
    expect(plan.changes[0]!.repoPath).toBe("my-notes.md");
    expect(plan.conflicts).toEqual([]);
  });

  it("adopts an existing tree path instead of deduping when a doc with no repoPath matches by name, and content is identical", async () => {
    // git's blob sha of the empty string, per `git hash-object -t blob --stdin < /dev/null`
    const docs = [fakeDoc({ id: "d1", name: "Notes", repoPath: undefined, content: "" })];
    const entries: TreeEntry[] = [{ path: "notes.md", sha: "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391", type: "blob" }];
    // sameWorkspace: false — identical content adopts quietly regardless
    // of the marker, proving this branch doesn't depend on it.
    const plan = await planPush(docs, entries, false);
    expect(plan.changes).toEqual([]);
    expect(plan.conflicts).toEqual([]);
  });

  it("pushes directly to the matched tree path when content differs and sameWorkspace is true", async () => {
    const docs = [fakeDoc({ id: "d1", name: "Notes", repoPath: undefined, content: "new content" })];
    const entries: TreeEntry[] = [{ path: "notes.md", sha: "s1", type: "blob" }];
    const plan = await planPush(docs, entries, true);
    expect(plan.changes).toHaveLength(1);
    expect(plan.changes[0]!.repoPath).toBe("notes.md");
    expect(plan.conflicts).toEqual([]);
  });

  it("raises a conflict instead of overwriting when a matched tree path's content differs and sameWorkspace is false", async () => {
    const docs = [fakeDoc({ id: "d1", name: "Notes", repoPath: undefined, content: "new content" })];
    const entries: TreeEntry[] = [{ path: "notes.md", sha: "s1", type: "blob" }];
    const plan = await planPush(docs, entries, false);
    expect(plan.changes).toEqual([]);
    expect(plan.conflicts).toEqual([{ docId: "d1", repoPath: "notes.md", remoteSha: "s1" }]);
  });

  it("dedupes a second doc's repoPath when the first already claimed the matching tree path", async () => {
    const docs = [
      fakeDoc({ id: "d1", name: "Notes", repoPath: undefined, content: "" }), // identical to tree -> quietly adopts notes.md
      fakeDoc({ id: "d2", name: "Notes", repoPath: undefined, content: "different content" }),
    ];
    const entries: TreeEntry[] = [{ path: "notes.md", sha: "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391", type: "blob" }];
    const plan = await planPush(docs, entries, false);
    expect(plan.changes).toHaveLength(1);
    expect(plan.changes[0]!.docId).toBe("d2");
    expect(plan.changes[0]!.repoPath).toBe("notes-2.md");
  });

  it("skips a doc whose pushable content hashes to the tree's current blob sha", async () => {
    // git's blob sha of the empty string, per `git hash-object -t blob --stdin < /dev/null`
    const docs = [fakeDoc({ id: "d1", repoPath: "a.md", repoSha: "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391", content: "" })];
    const entries: TreeEntry[] = [{ path: "a.md", sha: "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391", type: "blob" }];
    const plan = await planPush(docs, entries, false);
    expect(plan.changes).toEqual([]);
  });

  it("pushes a doc whose content differs from the tree's current blob sha, even if repoSha still matches", async () => {
    const docs = [fakeDoc({ id: "d1", repoPath: "a.md", repoSha: "s1", content: "changed locally" })];
    const entries: TreeEntry[] = [{ path: "a.md", sha: "s1", type: "blob" }];
    const plan = await planPush(docs, entries, false);
    expect(plan.changes).toHaveLength(1);
  });

  it("queues a conflict when the tree's sha differs from the doc's last-known repoSha", async () => {
    const docs = [fakeDoc({ id: "d1", repoPath: "a.md", repoSha: "s1" })];
    const entries: TreeEntry[] = [{ path: "a.md", sha: "s2", type: "blob" }];
    const plan = await planPush(docs, entries, false);
    expect(plan.changes).toEqual([]);
    expect(plan.conflicts).toEqual([{ docId: "d1", repoPath: "a.md", remoteSha: "s2" }]);
  });

  it("pushes a doc whose repoPath is not in the tree at all yet (first push after linking)", async () => {
    const docs = [fakeDoc({ id: "d1", repoPath: "a.md", repoSha: "s1", content: "hi" })];
    const plan = await planPush(docs, [], false);
    expect(plan.changes).toHaveLength(1);
    expect(plan.changes[0]!.repoPath).toBe("a.md");
  });

  it("uses the final (deduped) repoPath's own stem as the images-folder slug, not doc.name's slug", async () => {
    // Regression coverage for a slug-consistency bug found during plan
    // review: if two docs both slugify to "notes" (and neither matches
    // anything already in the tree), the second one's repoPath becomes
    // notes-2.md via dedupeRepoPath. Its pushed images must land under
    // assets/notes-2/ (matching what pull-side docSlugFor("notes-2.md")
    // will later derive from that same final path) — not assets/notes/
    // (what slugifyDocName(doc.name) alone would give), which pull could
    // never resolve back correctly.
    const docs = [
      fakeDoc({ id: "d1", name: "Notes", repoPath: undefined, content: "first" }),
      fakeDoc({ id: "d2", name: "Notes", repoPath: undefined, content: "![x](img-1)", images: { "img-1": "data:image/png;base64,aGk=" } }),
    ];
    const plan = await planPush(docs, [], false);
    const second = plan.changes.find((c) => c.docId === "d2")!;
    expect(second.repoPath).toBe("notes-2.md");
    expect(second.assets).toEqual([{ path: "assets/notes-2/img-1.png", dataUrl: "data:image/png;base64,aGk=" }]);
    expect(second.content).toBe("![x](assets/notes-2/img-1.png)");
  });
});

describe("planCreateWorkspaceFromRepo", () => {
  it("plans to switch to an existing workspace already linked to the same owner/repo/branch", () => {
    const workspaces: Workspace[] = [{ id: "w1", name: "notes", createdAt: 0, repoLink: { owner: "octocat", repo: "notes", branch: "main" } }];
    const plan = planCreateWorkspaceFromRepo("octocat", "notes", "main", workspaces);
    expect(plan).toEqual({ action: "switch", workspaceId: "w1" });
  });

  it("does not match a workspace linked to a different branch", () => {
    const workspaces: Workspace[] = [{ id: "w1", name: "other", createdAt: 0, repoLink: { owner: "octocat", repo: "notes", branch: "dev" } }];
    const plan = planCreateWorkspaceFromRepo("octocat", "notes", "main", workspaces);
    expect(plan).toEqual({ action: "create", workspaceName: "notes" });
  });

  it("plans to create a new workspace named after the repo when nothing matches", () => {
    const plan = planCreateWorkspaceFromRepo("octocat", "notes", "main", []);
    expect(plan).toEqual({ action: "create", workspaceName: "notes" });
  });

  it("dedupes the new workspace name against existing workspace names", () => {
    const workspaces: Workspace[] = [{ id: "w1", name: "notes", createdAt: 0 }];
    const plan = planCreateWorkspaceFromRepo("octocat", "notes", "main", workspaces);
    expect(plan).toEqual({ action: "create", workspaceName: "notes-2" });
  });
});

describe("linkWorkspaceAndSync", () => {
  let backend: FakeRepoBackend;
  let realFetch: typeof fetch;

  beforeEach(async () => {
    backend = await startFakeRepoBackend();
    realFetch = globalThis.fetch.bind(globalThis);
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const rewritten = url.startsWith("/api/repo") ? `${backend.baseUrl}${url}` : url;
      return realFetch(rewritten, init);
    });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await backend.stop();
  });

  it("pushes local docs and pulls in the repo's pre-existing content, without touching it", async () => {
    backend.seedRepo("alice", "notes", "main", [{ path: "existing.md", content: "pre-existing" }]);
    const ws = createWorkspace("Test Workspace");
    docsStore.set([{ id: "local-1", name: "Local Doc", content: "my local content", updatedAt: 1, createdAt: 1, workspaceId: ws.id }]);

    const result = await linkWorkspaceAndSync(ws.id, { owner: "alice", repo: "notes", branch: "main" });
    expect(result.kind).toBe("pull-result");
    if (result.kind !== "pull-result") throw new Error("unreachable");
    expect(typeof result.progressToastId).toBe("number");

    const docs = get(docsStore).filter((d) => d.workspaceId === ws.id);
    expect(docs.length).toBe(2);

    const localDoc = docs.find((d) => d.id === "local-1")!;
    expect(localDoc.repoPath).toBeDefined();
    expect(localDoc.repoSha).toBeDefined();

    const pulledDoc = docs.find((d) => d.repoPath === "existing.md");
    expect(pulledDoc).toBeDefined();
    expect(pulledDoc!.content).toBe("pre-existing");
  });

  it("flags a push conflict instead of silently duplicating when relinking to a different repo with a same-named, differing-content file", async () => {
    backend.seedRepo("alice", "notes", "main", [{ path: "notes.md", content: "fresh content from the new repo" }]);
    const ws = createWorkspace("Test Workspace 2");
    docsStore.set([
      {
        id: "stale-doc",
        name: "Notes",
        content: "old content from a different repo",
        updatedAt: 1,
        createdAt: 1,
        workspaceId: ws.id,
        repoPath: "notes.md",
        repoSha: "stale-sha-from-a-different-repo",
      },
    ]);

    const result = await linkWorkspaceAndSync(ws.id, { owner: "alice", repo: "notes", branch: "main" });

    expect(result.kind).toBe("push-conflict");
    if (result.kind !== "push-conflict") throw new Error("unreachable");
    expect(result.pushPlan.conflicts).toHaveLength(1);
    expect(result.pushPlan.conflicts[0]!.docId).toBe("stale-doc");
    expect(result.pushPlan.conflicts[0]!.repoPath).toBe("notes.md");

    // Nothing pushed or pulled yet — the doc keeps its (now
    // stale-metadata-cleared) content, and the repo's own notes.md is
    // untouched, until the conflict is explicitly resolved.
    const docs = get(docsStore).filter((d) => d.workspaceId === ws.id);
    expect(docs.length).toBe(1);
    expect(docs[0]!.content).toBe("old content from a different repo");
  });

  it("pushes directly instead of conflicting when relinking to a repo this exact workspace already pushed to before", async () => {
    const ws = createWorkspace("Test Workspace 3");
    backend.seedRepo("alice", "notes", "main", [
      { path: "notes.md", content: "old content from before" },
      { path: ".mde/workspace.json", content: JSON.stringify({ workspaceId: ws.id, name: ws.name }) },
    ]);
    docsStore.set([{ id: "my-doc", name: "Notes", content: "updated local content", updatedAt: 1, createdAt: 1, workspaceId: ws.id }]);

    const result = await linkWorkspaceAndSync(ws.id, { owner: "alice", repo: "notes", branch: "main" });

    expect(result.kind).toBe("pull-result");
    const docs = get(docsStore).filter((d) => d.workspaceId === ws.id);
    const doc = docs.find((d) => d.id === "my-doc")!;
    expect(doc.repoPath).toBe("notes.md");
    expect(doc.content).toBe("updated local content");
  });
});
