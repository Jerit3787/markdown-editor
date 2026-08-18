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
  decodeBase64Text,
  type TreeEntry,
} from "./repo-sync";
import { docsStore } from "./stores/docs";
import { createWorkspace, workspacesStore } from "./stores/workspaces";
import { startFakeRepoBackend, type FakeRepoBackend } from "./test-support/fake-repo-backend";
import type { Doc, Workspace } from "./types";

function fakeDoc(overrides: Partial<Doc>): Doc {
  return { id: "d1", name: "a", content: "", updatedAt: 0, createdAt: 0, workspaceId: "w1", ...overrides };
}

describe("slugifyDocName", () => {
  it("preserves case and spacing while replacing other punctuation with hyphens", () => {
    expect(slugifyDocName("My Notes!")).toBe("My Notes");
  });
  it("falls back to untitled for empty or all-punctuation names", () => {
    expect(slugifyDocName("")).toBe("untitled");
    expect(slugifyDocName("!!!")).toBe("untitled");
  });
  it("passes digits and existing hyphens through unchanged", () => {
    expect(slugifyDocName("Q3-2026 Report")).toBe("Q3-2026 Report");
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

describe("decodeBase64Text", () => {
  it("round-trips ASCII text unchanged", () => {
    const b64 = Buffer.from("hello world", "utf-8").toString("base64");
    expect(decodeBase64Text(b64)).toBe("hello world");
  });

  it("correctly decodes multi-byte UTF-8 characters — em dash, curly quotes, accented letters", () => {
    // Regression coverage: plain atob() decodes base64 byte-for-byte as
    // Latin-1, which mangles any multi-byte UTF-8 character (GitHub's API
    // always returns file content as UTF-8-encoded base64, regardless of
    // the file's actual script/punctuation). "— café's "quote"" exercises
    // an em dash, an accented letter, and curly quotes in one string.
    const original = "— café's “quote”";
    const b64 = Buffer.from(original, "utf-8").toString("base64");
    expect(decodeBase64Text(b64)).toBe(original);
  });

  it("strips embedded newlines before decoding, matching GitHub's line-wrapped base64 responses", () => {
    const original = "line one\nline two";
    const rawB64 = Buffer.from(original, "utf-8").toString("base64");
    // GitHub's contents/blob APIs wrap base64 payloads at 60 chars with
    // literal newlines — insert one mid-string to simulate that.
    const wrapped = rawB64.slice(0, 4) + "\n" + rawB64.slice(4);
    expect(decodeBase64Text(wrapped)).toBe(original);
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
});

describe("resolveImagesFromPull", () => {
  it("resolves an assets-relative link back to its bare filename as the internal ref", () => {
    const result = resolveImagesFromPull("![a photo](assets/my-notes/foo.png)", "my-notes", {
      "assets/my-notes/foo.png": "data:image/png;base64,aGVsbG8=",
    });
    expect(result.content).toBe("![a photo](foo.png)");
    expect(result.images["foo.png"]).toBe("data:image/png;base64,aGVsbG8=");
  });

  it("leaves links with no matching blob untouched", () => {
    const result = resolveImagesFromPull("![x](https://example.com/x.png)", "my-notes", {});
    expect(result.content).toBe("![x](https://example.com/x.png)");
    expect(result.images).toEqual({});
  });

  // Regression coverage for TODO's "changing an image reference into the
  // locally established format counts as a diff": the old scheme minted a
  // fresh img-<timestamp>-N ref on every pull, even for byte-identical
  // image content, so re-pulling (e.g. after an unrelated file in the same
  // repo changed) turned an untouched image line into a spurious diff, and
  // pushing it back out renamed the asset in the repo on every round trip
  // even with zero real edits (rewriteImagesForPush appends the pushed
  // ref's own name under assets/<slug>/, so a fresh ref each pull meant a
  // fresh asset path each push).
  it("produces the same ref for the same pull, byte-identical or not — deterministic, not timestamp-based", () => {
    const blobs = { "assets/my-notes/foo.png": "data:image/png;base64,aGVsbG8=" };
    const first = resolveImagesFromPull("![a](assets/my-notes/foo.png)", "my-notes", blobs);
    const second = resolveImagesFromPull("![a](assets/my-notes/foo.png)", "my-notes", blobs);
    expect(first.content).toBe(second.content);
  });

  it("round-trips back through rewriteImagesForPush to the exact original asset path", () => {
    const original = "![a photo](assets/my-notes/foo.png)";
    const dataUrl = "data:image/png;base64,aGVsbG8=";
    const pulled = resolveImagesFromPull(original, "my-notes", { "assets/my-notes/foo.png": dataUrl });
    const pushed = rewriteImagesForPush(pulled.content, "my-notes", pulled.images, undefined);
    expect(pushed.content).toBe(original);
    expect(pushed.assets).toEqual([{ path: "assets/my-notes/foo.png", dataUrl }]);
  });

  it("reuses the same internal ref for the same image referenced twice in one doc — mirrors rewriteImagesForPush's own reuse", () => {
    const result = resolveImagesFromPull(
      "![a](assets/notes/foo.png) and again ![b](assets/notes/foo.png)",
      "notes",
      { "assets/notes/foo.png": "data:image/png;base64,aGVsbG8=" }
    );
    expect(result.content).toBe("![a](foo.png) and again ![b](foo.png)");
    expect(Object.keys(result.images)).toEqual(["foo.png"]);
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
    expect(plan.changes[0]!.repoPath).toBe("My Notes.md");
    expect(plan.conflicts).toEqual([]);
  });

  it("adopts an existing tree path instead of deduping when a doc with no repoPath matches by name, and content is identical", async () => {
    // git's blob sha of the empty string, per `git hash-object -t blob --stdin < /dev/null`
    const docs = [fakeDoc({ id: "d1", name: "Notes", repoPath: undefined, content: "" })];
    const entries: TreeEntry[] = [{ path: "Notes.md", sha: "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391", type: "blob" }];
    // sameWorkspace: false — identical content adopts quietly regardless
    // of the marker, proving this branch doesn't depend on it.
    const plan = await planPush(docs, entries, false);
    expect(plan.changes).toEqual([]);
    expect(plan.conflicts).toEqual([]);
  });

  it("pushes directly to the matched tree path when content differs and sameWorkspace is true", async () => {
    const docs = [fakeDoc({ id: "d1", name: "Notes", repoPath: undefined, content: "new content" })];
    const entries: TreeEntry[] = [{ path: "Notes.md", sha: "s1", type: "blob" }];
    const plan = await planPush(docs, entries, true);
    expect(plan.changes).toHaveLength(1);
    expect(plan.changes[0]!.repoPath).toBe("Notes.md");
    expect(plan.conflicts).toEqual([]);
  });

  it("raises a conflict instead of overwriting when a matched tree path's content differs and sameWorkspace is false", async () => {
    const docs = [fakeDoc({ id: "d1", name: "Notes", repoPath: undefined, content: "new content" })];
    const entries: TreeEntry[] = [{ path: "Notes.md", sha: "s1", type: "blob" }];
    const plan = await planPush(docs, entries, false);
    expect(plan.changes).toEqual([]);
    expect(plan.conflicts).toEqual([{ docId: "d1", repoPath: "Notes.md", remoteSha: "s1" }]);
  });

  it("dedupes a second doc's repoPath when the first already claimed the matching tree path", async () => {
    const docs = [
      fakeDoc({ id: "d1", name: "Notes", repoPath: undefined, content: "" }), // identical to tree -> quietly adopts Notes.md
      fakeDoc({ id: "d2", name: "Notes", repoPath: undefined, content: "different content" }),
    ];
    const entries: TreeEntry[] = [{ path: "Notes.md", sha: "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391", type: "blob" }];
    const plan = await planPush(docs, entries, false);
    expect(plan.changes).toHaveLength(1);
    expect(plan.changes[0]!.docId).toBe("d2");
    expect(plan.changes[0]!.repoPath).toBe("Notes-2.md");
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
    expect(second.repoPath).toBe("Notes-2.md");
    expect(second.assets).toEqual([{ path: "assets/Notes-2/img-1.png", dataUrl: "data:image/png;base64,aGk=" }]);
    expect(second.content).toBe("![x](assets/Notes-2/img-1.png)");
  });

  it("queues a deletion for a repo markdown file whose doc was deleted locally", async () => {
    const entries: TreeEntry[] = [{ path: "gone.md", sha: "s1", type: "blob" }];
    const plan = await planPush([], entries, false, ["gone.md"]);
    expect(plan.deletions).toEqual(["gone.md"]);
    expect(plan.changes).toEqual([]);
  });

  it("does not delete a repo markdown file that was simply never pulled in as a doc yet", async () => {
    // Regression coverage: a naive "any tree path with no matching doc"
    // scan would wrongly delete pre-existing repo content on first push
    // to a freshly-linked repo, before anyone ever pulled it in — see
    // linkWorkspaceAndSync's own test for the end-to-end version of this.
    const entries: TreeEntry[] = [{ path: "pre-existing.md", sha: "s1", type: "blob" }];
    const plan = await planPush([], entries, false); // pendingRepoDeletions omitted — nothing was ever locally deleted
    expect(plan.deletions).toEqual([]);
  });

  it("does not delete a repo path a live doc still owns, even if queued", async () => {
    const docs = [fakeDoc({ id: "d1", repoPath: "a.md", repoSha: "s1", content: "" })];
    const entries: TreeEntry[] = [{ path: "a.md", sha: "s1", type: "blob" }];
    // A different doc's earlier deletion happened to queue this exact
    // path (e.g. deleted then a new doc reused the name) — this doc has
    // since reclaimed it, so it must not be deleted out from under it.
    const plan = await planPush(docs, entries, false, ["a.md"]);
    expect(plan.deletions).toEqual([]);
  });

  it("does not orphan-delete a path still claimed by a doc awaiting conflict resolution, even if queued", async () => {
    const docs = [fakeDoc({ id: "d1", repoPath: "a.md", repoSha: "s1" })];
    const entries: TreeEntry[] = [{ path: "a.md", sha: "s2", type: "blob" }]; // remote moved -> conflict
    const plan = await planPush(docs, entries, false, ["a.md"]);
    expect(plan.conflicts).toEqual([{ docId: "d1", repoPath: "a.md", remoteSha: "s2" }]);
    expect(plan.deletions).toEqual([]);
  });

  it("moves a renamed doc to a new repo path and deletes the old one", async () => {
    const docs = [fakeDoc({ id: "d1", name: "New Name", repoPath: "old-name.md", repoSha: "s1", content: "hi" })];
    const entries: TreeEntry[] = [{ path: "old-name.md", sha: "s1", type: "blob" }];
    const plan = await planPush(docs, entries, false);
    expect(plan.changes).toHaveLength(1);
    expect(plan.changes[0]!.repoPath).toBe("New Name.md");
    expect(plan.deletions).toEqual(["old-name.md"]);
  });

  it("uses the renamed doc's new path (not its old one) as the images-folder slug", async () => {
    const docs = [
      fakeDoc({ id: "d1", name: "New Name", repoPath: "old-name.md", repoSha: "s1", content: "![x](img-1)", images: { "img-1": "data:image/png;base64,aGk=" } }),
    ];
    const entries: TreeEntry[] = [{ path: "old-name.md", sha: "s1", type: "blob" }];
    const plan = await planPush(docs, entries, false);
    expect(plan.changes[0]!.content).toBe("![x](assets/New Name/img-1.png)");
  });

  it("skips the rename when the target path already belongs to a real tree file (falls back to the old path)", async () => {
    const docs = [fakeDoc({ id: "d1", name: "Taken", repoPath: "old-name.md", repoSha: "s1", content: "hi" })];
    const entries: TreeEntry[] = [
      { path: "old-name.md", sha: "s1", type: "blob" },
      { path: "Taken.md", sha: "other-sha", type: "blob" },
    ];
    const plan = await planPush(docs, entries, false);
    expect(plan.changes).toHaveLength(1);
    expect(plan.changes[0]!.repoPath).toBe("old-name.md");
    expect(plan.deletions).toEqual([]);
  });

  it("includes a historyChanges entry for a doc with local snapshots to push", async () => {
    const docs = [fakeDoc({ id: "d1", name: "notes", repoPath: "notes.md", repoSha: "s1", content: "hi" })];
    const entries: TreeEntry[] = [{ path: "notes.md", sha: "s1", type: "blob" }];
    const localHistory = new Map([["d1", { snapshots: [{ id: "snap-1", timestamp: 1, content: "old" }], notes: [] }]]);
    const plan = await planPush(docs, entries, false, [], localHistory);
    expect(plan.historyChanges).toHaveLength(1);
    expect(plan.historyChanges[0]!.historyPath).toBe(".mde/history/notes.json");
    expect(JSON.parse(plan.historyChanges[0]!.content)).toEqual({ snapshots: [{ id: "snap-1", timestamp: 1, content: "old" }], notes: [] });
  });

  it("emits historyChanges even when the doc's own content is unchanged", async () => {
    const bytes = new TextEncoder().encode("hi");
    const header = new TextEncoder().encode(`blob ${bytes.length}\0`);
    const combined = new Uint8Array(header.length + bytes.length);
    combined.set(header);
    combined.set(bytes, header.length);
    const digest = await crypto.subtle.digest("SHA-1", combined);
    const contentSha = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
    const docs = [fakeDoc({ id: "d1", name: "notes", repoPath: "notes.md", repoSha: contentSha, content: "hi" })];
    const entries: TreeEntry[] = [{ path: "notes.md", sha: contentSha, type: "blob" }];
    const localHistory = new Map([["d1", { snapshots: [], notes: [{ id: "n1", from: 0, to: 2, quote: "hi", orphaned: false, body: "b", createdAt: 1 }] }]]);
    const plan = await planPush(docs, entries, false, [], localHistory);
    expect(plan.changes).toEqual([]); // content itself unchanged — confirms this isn't just "content also happened to push"
    expect(plan.historyChanges).toHaveLength(1);
    expect(plan.historyChanges[0]!.historyPath).toBe(".mde/history/notes.json");
  });

  it("omits historyChanges for a doc with no local snapshots or notes", async () => {
    const docs = [fakeDoc({ id: "d1", name: "notes", repoPath: "notes.md", repoSha: "s1", content: "hi" })];
    const entries: TreeEntry[] = [{ path: "notes.md", sha: "s1", type: "blob" }];
    const plan = await planPush(docs, entries, false, [], new Map([["d1", { snapshots: [], notes: [] }]]));
    expect(plan.historyChanges).toEqual([]);
  });

  it("skips historyChanges when the pushed content matches the tree exactly", async () => {
    const docs = [fakeDoc({ id: "d1", name: "notes", repoPath: "notes.md", repoSha: "s1", content: "hi" })];
    const snapshots = [{ id: "snap-1", timestamp: 1, content: "old" }];
    const historyContent = JSON.stringify({ snapshots, notes: [] });
    const bytes = new TextEncoder().encode(historyContent);
    const header = new TextEncoder().encode(`blob ${bytes.length}\0`);
    const combined = new Uint8Array(header.length + bytes.length);
    combined.set(header);
    combined.set(bytes, header.length);
    const digest = await crypto.subtle.digest("SHA-1", combined);
    const sha = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
    const entries: TreeEntry[] = [
      { path: "notes.md", sha: "s1", type: "blob" },
      { path: ".mde/history/notes.json", sha, type: "blob" },
    ];
    const plan = await planPush(docs, entries, false, [], new Map([["d1", { snapshots, notes: [] }]]));
    expect(plan.historyChanges).toEqual([]);
  });

  it("deletes a renamed doc's old history file alongside its old content path", async () => {
    const docs = [fakeDoc({ id: "d1", name: "New Name", repoPath: "old-name.md", repoSha: "s1", content: "hi" })];
    const entries: TreeEntry[] = [
      { path: "old-name.md", sha: "s1", type: "blob" },
      { path: ".mde/history/old-name.json", sha: "hist-sha", type: "blob" },
    ];
    const plan = await planPush(docs, entries, false);
    expect(plan.deletions).toEqual(expect.arrayContaining(["old-name.md", ".mde/history/old-name.json"]));
  });

  it("deletes a removed doc's history file via pendingRepoDeletions, same as its content path", async () => {
    const entries: TreeEntry[] = [
      { path: "gone.md", sha: "s1", type: "blob" },
      { path: ".mde/history/gone.json", sha: "hist-sha", type: "blob" },
    ];
    const plan = await planPush([], entries, false, ["gone.md"]);
    expect(plan.deletions).toEqual(expect.arrayContaining(["gone.md", ".mde/history/gone.json"]));
  });
});

describe("planCreateWorkspaceFromRepo", () => {
  it("plans to switch to an existing workspace already linked to the same owner/repo/branch", () => {
    const workspaces: Workspace[] = [{ id: "w1", name: "notes", createdAt: 0, updatedAt: 0, repoLink: { owner: "octocat", repo: "notes", branch: "main" } }];
    const plan = planCreateWorkspaceFromRepo("octocat", "notes", "main", workspaces);
    expect(plan).toEqual({ action: "switch", workspaceId: "w1" });
  });

  it("does not match a workspace linked to a different branch", () => {
    const workspaces: Workspace[] = [{ id: "w1", name: "other", createdAt: 0, updatedAt: 0, repoLink: { owner: "octocat", repo: "notes", branch: "dev" } }];
    const plan = planCreateWorkspaceFromRepo("octocat", "notes", "main", workspaces);
    expect(plan).toEqual({ action: "create", workspaceName: "notes" });
  });

  it("plans to create a new workspace named after the repo when nothing matches", () => {
    const plan = planCreateWorkspaceFromRepo("octocat", "notes", "main", []);
    expect(plan).toEqual({ action: "create", workspaceName: "notes" });
  });

  it("dedupes the new workspace name against existing workspace names", () => {
    const workspaces: Workspace[] = [{ id: "w1", name: "notes", createdAt: 0, updatedAt: 0 }];
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
    backend.seedRepo("alice", "notes", "main", [{ path: "Notes.md", content: "fresh content from the new repo" }]);
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
    expect(result.pushPlan.conflicts[0]!.repoPath).toBe("Notes.md");

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
      { path: "Notes.md", content: "old content from before" },
      { path: ".mde/workspace.json", content: JSON.stringify({ workspaceId: ws.id, name: ws.name }) },
    ]);
    docsStore.set([{ id: "my-doc", name: "Notes", content: "updated local content", updatedAt: 1, createdAt: 1, workspaceId: ws.id }]);

    const result = await linkWorkspaceAndSync(ws.id, { owner: "alice", repo: "notes", branch: "main" });

    expect(result.kind).toBe("pull-result");
    const docs = get(docsStore).filter((d) => d.workspaceId === ws.id);
    const doc = docs.find((d) => d.id === "my-doc")!;
    expect(doc.repoPath).toBe("Notes.md");
    expect(doc.content).toBe("updated local content");
  });

  it("renames a still-default-named workspace to the repo's name when linking", async () => {
    const ws = createWorkspace("New workspace");
    backend.seedRepo("alice", "my-blog", "main", []);

    await linkWorkspaceAndSync(ws.id, { owner: "alice", repo: "my-blog", branch: "main" });

    expect(get(workspacesStore).find((w) => w.id === ws.id)?.name).toBe("my-blog");
  });

  it("leaves a custom-named workspace's name untouched when linking", async () => {
    const ws = createWorkspace("Personal Notes");
    backend.seedRepo("alice", "my-blog", "main", []);

    await linkWorkspaceAndSync(ws.id, { owner: "alice", repo: "my-blog", branch: "main" });

    expect(get(workspacesStore).find((w) => w.id === ws.id)?.name).toBe("Personal Notes");
  });

  it("sets repoLastSyncedAt after a successful push+pull", async () => {
    const ws = createWorkspace("Test Workspace 4");
    backend.seedRepo("alice", "notes", "main", []);
    const before = Date.now();

    await linkWorkspaceAndSync(ws.id, { owner: "alice", repo: "notes", branch: "main" });

    const synced = get(workspacesStore).find((w) => w.id === ws.id)?.repoLastSyncedAt;
    expect(synced).toBeDefined();
    expect(synced!).toBeGreaterThanOrEqual(before);
  });
});
