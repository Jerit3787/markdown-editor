// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { get } from "svelte/store";

// Polyfill localStorage if not available (can happen in jsdom without proper URL setup)
if (typeof localStorage === "undefined") {
  // Create a mock localStorage implementation
  class MockLocalStorage {
    private data: Record<string, string> = {};

    setItem(key: string, value: string): void {
      this.data[key] = String(value);
    }

    getItem(key: string): string | null {
      return this.data[key] ?? null;
    }

    removeItem(key: string): void {
      delete this.data[key];
    }

    clear(): void {
      this.data = {};
    }

    key(index: number): string | null {
      const keys = Object.keys(this.data);
      return keys[index] ?? null;
    }

    get length(): number {
      return Object.keys(this.data).length;
    }
  }

  (globalThis as any).localStorage = new MockLocalStorage();
}

describe("docs store — workspace integration", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it("normalizeLoadedDocs backfills workspaceId onto legacy docs, leaves tagged ones alone", async () => {
    localStorage.setItem(
      "mde:docs",
      JSON.stringify([
        { id: "legacy", name: "Legacy", content: "", updatedAt: 1, createdAt: 1 },
        { id: "tagged", name: "Tagged", content: "", updatedAt: 1, createdAt: 1, workspaceId: "some-other-ws" },
      ]),
    );
    const { docsStore } = await import("../../../../client/src/stores/docs");
    const { workspacesStore } = await import("../../../../client/src/stores/workspaces");
    const defaultWorkspaceId = get(workspacesStore)[0].id;
    const docs = get(docsStore);
    expect(docs.find((d) => d.id === "legacy")?.workspaceId).toBe(defaultWorkspaceId);
    expect(docs.find((d) => d.id === "tagged")?.workspaceId).toBe("some-other-ws");
  });

  it("createDoc stamps the currently-active workspace by default", async () => {
    const { createDoc } = await import("../../../../client/src/stores/docs");
    const { activeWorkspaceIdStore, createWorkspace } = await import("../../../../client/src/stores/workspaces");
    const second = createWorkspace("Second"); // now active
    const doc = createDoc();
    expect(doc.workspaceId).toBe(second.id);
    expect(get(activeWorkspaceIdStore)).toBe(second.id);
  });

  it("createDoc respects an explicit workspaceId override", async () => {
    const { createDoc } = await import("../../../../client/src/stores/docs");
    const { createWorkspace } = await import("../../../../client/src/stores/workspaces");
    const first = createWorkspace("First");
    const doc = createDoc({ workspaceId: first.id, name: "Explicit" });
    expect(doc.workspaceId).toBe(first.id);
  });

  it("getActiveDoc falls back to a doc in the active workspace, not an arbitrary one", async () => {
    const { docsStore, activeIdStore, getActiveDoc } = await import("../../../../client/src/stores/docs");
    const { createWorkspace } = await import("../../../../client/src/stores/workspaces");
    const first = createWorkspace("First");
    const second = createWorkspace("Second");
    docsStore.set([
      { id: "a", name: "A", content: "", updatedAt: 1, createdAt: 1, workspaceId: first.id },
      { id: "b", name: "B", content: "", updatedAt: 2, createdAt: 2, workspaceId: second.id },
    ]);
    activeIdStore.set("does-not-exist");
    expect(getActiveDoc()?.id).toBe("b"); // active workspace is "second"
  });

  it("removeDocById falls back to a remaining doc in the same workspace as the one removed", async () => {
    const { docsStore, activeIdStore, removeDocById } = await import("../../../../client/src/stores/docs");
    const { createWorkspace } = await import("../../../../client/src/stores/workspaces");
    const first = createWorkspace("First");
    const second = createWorkspace("Second");
    docsStore.set([
      { id: "a1", name: "A1", content: "", updatedAt: 1, createdAt: 1, workspaceId: first.id },
      { id: "a2", name: "A2", content: "", updatedAt: 2, createdAt: 2, workspaceId: first.id },
      { id: "b1", name: "B1", content: "", updatedAt: 3, createdAt: 3, workspaceId: second.id },
    ]);
    activeIdStore.set("a1");
    removeDocById("a1");
    expect(get(activeIdStore)).toBe("a2");
  });

  it("removeDocById queues the doc's repoPath for deletion on the owning workspace, so a later push can propagate it", async () => {
    const { docsStore, removeDocById } = await import("../../../../client/src/stores/docs");
    const { createWorkspace, workspacesStore } = await import("../../../../client/src/stores/workspaces");
    const ws = createWorkspace("Linked");
    docsStore.set([{ id: "d1", name: "D1", content: "", updatedAt: 1, createdAt: 1, workspaceId: ws.id, repoPath: "d1.md", repoSha: "s1" }]);
    removeDocById("d1");
    expect(get(workspacesStore).find((w) => w.id === ws.id)?.pendingRepoDeletions).toEqual(["d1.md"]);
  });

  it("removeDocById queues nothing for a doc that was never synced to a repo", async () => {
    const { docsStore, removeDocById } = await import("../../../../client/src/stores/docs");
    const { createWorkspace, workspacesStore } = await import("../../../../client/src/stores/workspaces");
    const ws = createWorkspace("Unlinked");
    docsStore.set([{ id: "d1", name: "D1", content: "", updatedAt: 1, createdAt: 1, workspaceId: ws.id }]);
    removeDocById("d1");
    expect(get(workspacesStore).find((w) => w.id === ws.id)?.pendingRepoDeletions).toBeUndefined();
  });

  it("mergeDocNotes adds remote notes the doc doesn't have yet, by id", async () => {
    const { docsStore, mergeDocNotes } = await import("../../../../client/src/stores/docs");
    const { createWorkspace } = await import("../../../../client/src/stores/workspaces");
    const ws = createWorkspace("Linked");
    docsStore.set([
      {
        id: "d1",
        name: "D1",
        content: "hello world",
        updatedAt: 1,
        createdAt: 1,
        workspaceId: ws.id,
        repoPath: "d1.md",
        notes: [{ id: "local-1", from: 0, to: 5, quote: "hello", orphaned: false, body: "local note", createdAt: 1 }],
      },
    ]);
    mergeDocNotes("d1", [{ id: "remote-1", from: 6, to: 11, quote: "world", orphaned: false, body: "remote note", createdAt: 2 }]);
    const doc = get(docsStore).find((d) => d.id === "d1");
    expect(doc?.notes?.map((n) => n.id).sort()).toEqual(["local-1", "remote-1"]);
  });

  it("mergeDocNotes does not duplicate a remote note whose id already exists locally", async () => {
    const { docsStore, mergeDocNotes } = await import("../../../../client/src/stores/docs");
    const { createWorkspace } = await import("../../../../client/src/stores/workspaces");
    const ws = createWorkspace("Linked");
    const existing = { id: "n1", from: 0, to: 5, quote: "hello", orphaned: false, body: "note", createdAt: 1 };
    docsStore.set([{ id: "d1", name: "D1", content: "hello", updatedAt: 1, createdAt: 1, workspaceId: ws.id, repoPath: "d1.md", notes: [existing] }]);
    mergeDocNotes("d1", [existing]);
    const doc = get(docsStore).find((d) => d.id === "d1");
    expect(doc?.notes).toHaveLength(1);
  });

  it("ensureActiveDocInWorkspace picks the most-recently-updated doc in the target workspace", async () => {
    const { docsStore, activeIdStore, ensureActiveDocInWorkspace } = await import("../../../../client/src/stores/docs");
    const { createWorkspace } = await import("../../../../client/src/stores/workspaces");
    const ws = createWorkspace("Target");
    docsStore.set([
      { id: "old", name: "Old", content: "", updatedAt: 1, createdAt: 1, workspaceId: ws.id },
      { id: "new", name: "New", content: "", updatedAt: 5, createdAt: 5, workspaceId: ws.id },
    ]);
    activeIdStore.set("unrelated");
    ensureActiveDocInWorkspace(ws.id);
    expect(get(activeIdStore)).toBe("new");
  });

  it("ensureActiveDocInWorkspace is a no-op when the active doc already belongs to the target workspace", async () => {
    const { docsStore, activeIdStore, ensureActiveDocInWorkspace } = await import("../../../../client/src/stores/docs");
    const { createWorkspace } = await import("../../../../client/src/stores/workspaces");
    const ws = createWorkspace("Target");
    docsStore.set([{ id: "already-active", name: "X", content: "", updatedAt: 1, createdAt: 1, workspaceId: ws.id }]);
    activeIdStore.set("already-active");
    ensureActiveDocInWorkspace(ws.id);
    expect(get(activeIdStore)).toBe("already-active");
  });

  it("ensureActiveDocInWorkspace sets null when the target workspace has no documents", async () => {
    const { docsStore, activeIdStore, ensureActiveDocInWorkspace } = await import("../../../../client/src/stores/docs");
    const { createWorkspace } = await import("../../../../client/src/stores/workspaces");
    const empty = createWorkspace("Empty");
    docsStore.set([]);
    ensureActiveDocInWorkspace(empty.id);
    expect(get(activeIdStore)).toBeNull();
  });

  it("moveDocToWorkspace reassigns workspaceId without touching other fields", async () => {
    const { docsStore, moveDocToWorkspace } = await import("../../../../client/src/stores/docs");
    const { createWorkspace } = await import("../../../../client/src/stores/workspaces");
    const target = createWorkspace("Target");
    docsStore.set([{ id: "x", name: "X", content: "hello", updatedAt: 1, createdAt: 1, workspaceId: "orig" }]);
    moveDocToWorkspace("x", target.id);
    const doc = get(docsStore).find((d) => d.id === "x");
    expect(doc?.workspaceId).toBe(target.id);
    expect(doc?.content).toBe("hello");
  });

  // Finding 1 (final whole-branch review): initialActiveId used to fall
  // back to docs[0] (array-order-first, i.e. newest) regardless of
  // workspace — repro is switching to an empty workspace (which removes
  // mde:active entirely, see setActiveId), then reloading while another
  // workspace still has documents.
  it("initial load resolves activeIdStore to a doc in the active workspace, not the array-order-first doc from a different workspace", async () => {
    localStorage.setItem(
      "mde:workspaces",
      JSON.stringify([
        { id: "ws-a", name: "A", createdAt: 1 },
        { id: "ws-b", name: "B", createdAt: 2 },
      ]),
    );
    localStorage.setItem("mde:activeWorkspace", "ws-a");
    // No mde:active stored — matches the finding's repro (setActiveId(null)
    // removes the key when the active workspace has no documents).
    localStorage.setItem(
      "mde:docs",
      JSON.stringify([
        // Newest / array-order-first, but belongs to the OTHER workspace.
        { id: "b-doc", name: "B Doc", content: "", updatedAt: 2, createdAt: 2, workspaceId: "ws-b" },
        { id: "a-doc", name: "A Doc", content: "", updatedAt: 1, createdAt: 1, workspaceId: "ws-a" },
      ]),
    );
    const { activeIdStore } = await import("../../../../client/src/stores/docs");
    expect(get(activeIdStore)).toBe("a-doc");
  });

  // Finding 2 (final whole-branch review): normalizeLoadedDocs's fallback
  // used to be workspacesStore[0], which is the NEWEST workspace
  // (createWorkspace prepends) rather than the original default one.
  it("normalizeLoadedDocs backfill fallback is the OLDEST workspace by createdAt, not workspacesStore[0]", async () => {
    localStorage.setItem(
      "mde:workspaces",
      JSON.stringify([
        { id: "newer", name: "Newer", createdAt: 200 },
        { id: "older", name: "Older", createdAt: 100 },
      ]),
    );
    localStorage.setItem("mde:activeWorkspace", "newer");
    localStorage.setItem("mde:docs", JSON.stringify([{ id: "legacy", name: "Legacy", content: "", updatedAt: 1, createdAt: 1 }]));
    const { docsStore } = await import("../../../../client/src/stores/docs");
    expect(get(docsStore).find((d) => d.id === "legacy")?.workspaceId).toBe("older");
  });

  it("persists a workspaceId backfill to localStorage immediately, not only in memory", async () => {
    localStorage.setItem("mde:docs", JSON.stringify([{ id: "legacy", name: "Legacy", content: "", updatedAt: 1, createdAt: 1 }]));
    await import("../../../../client/src/stores/docs");
    const { workspacesStore } = await import("../../../../client/src/stores/workspaces");
    const defaultWorkspaceId = get(workspacesStore)[0].id;
    const persisted = JSON.parse(localStorage.getItem("mde:docs")!);
    expect(persisted.find((d: { id: string }) => d.id === "legacy")?.workspaceId).toBe(defaultWorkspaceId);
  });

  it("does not rewrite mde:docs when no document needed a workspaceId backfill", async () => {
    localStorage.setItem("mde:docs", JSON.stringify([{ id: "tagged", name: "Tagged", content: "", updatedAt: 1, createdAt: 1, workspaceId: "some-other-ws" }]));
    await import("../../../../client/src/stores/docs");
    // Storage should be untouched byte-for-byte (no backfill needed, so no
    // persistDocs() call) — re-parsing and comparing the one field we care
    // about is enough without over-asserting on exact JSON formatting.
    const persisted = JSON.parse(localStorage.getItem("mde:docs")!);
    expect(persisted[0].workspaceId).toBe("some-other-ws");
  });

  it("persistDocs merges with what another tab already saved instead of overwriting it", async () => {
    localStorage.setItem("mde:docs", JSON.stringify([{ id: "doc-a", name: "A", content: "original", updatedAt: 1, createdAt: 1, workspaceId: "ws1" }]));
    const { docsStore, persistDocs } = await import("../../../../client/src/stores/docs");

    // Simulate another tab having since created doc-b and saved it.
    localStorage.setItem(
      "mde:docs",
      JSON.stringify([
        { id: "doc-a", name: "A", content: "original", updatedAt: 1, createdAt: 1, workspaceId: "ws1" },
        { id: "doc-b", name: "B", content: "from another tab", updatedAt: 2, createdAt: 2, workspaceId: "ws1" },
      ]),
    );

    // This tab, unaware of doc-b, edits doc-a and saves.
    docsStore.set([{ id: "doc-a", name: "A", content: "edited here", updatedAt: 3, createdAt: 1, workspaceId: "ws1" }]);
    persistDocs();

    const persisted = JSON.parse(localStorage.getItem("mde:docs")!);
    expect(persisted).toHaveLength(2);
    expect(persisted.find((d: any) => d.id === "doc-a").content).toBe("edited here");
    expect(persisted.find((d: any) => d.id === "doc-b").content).toBe("from another tab");
    expect(get(docsStore)).toHaveLength(2);
  });

  it("persistDocs keeps another tab's newer edit to a document this tab hasn't touched", async () => {
    localStorage.setItem("mde:docs", JSON.stringify([{ id: "doc-a", name: "A", content: "v1", updatedAt: 1, createdAt: 1, workspaceId: "ws1" }]));
    const { docsStore, persistDocs } = await import("../../../../client/src/stores/docs");

    // Another tab edited doc-a (newer updatedAt) after this tab loaded its own stale copy.
    localStorage.setItem(
      "mde:docs",
      JSON.stringify([{ id: "doc-a", name: "A", content: "v2 from another tab", updatedAt: 5, createdAt: 1, workspaceId: "ws1" }]),
    );

    persistDocs();

    const persisted = JSON.parse(localStorage.getItem("mde:docs")!);
    expect(persisted.find((d: any) => d.id === "doc-a").content).toBe("v2 from another tab");
    expect(get(docsStore).find((d) => d.id === "doc-a")?.content).toBe("v2 from another tab");
  });

  it("removeDocById's own save doesn't resurrect the doc from the pre-deletion snapshot still in localStorage", async () => {
    localStorage.setItem("mde:docs", JSON.stringify([{ id: "doc-a", name: "A", content: "gone soon", updatedAt: 1, createdAt: 1, workspaceId: "ws1" }]));
    const { docsStore, removeDocById } = await import("../../../../client/src/stores/docs");

    removeDocById("doc-a");

    const persisted = JSON.parse(localStorage.getItem("mde:docs")!);
    expect(persisted.find((d: any) => d.id === "doc-a")).toBeUndefined();
    expect(get(docsStore).find((d) => d.id === "doc-a")).toBeUndefined();
  });

  // Finding 3 (final whole-branch review, USER DECISION: cross-workspace
  // navigation follows you to the target workspace): switchDoc is the
  // single choke point every consumer (wikilinks, Command Palette, File >
  // Recent, backlinks, shared-link join) funnels through.
  it("switchDoc follows the target document's workspace when it differs from the active one", async () => {
    const { docsStore, activeIdStore, switchDoc } = await import("../../../../client/src/stores/docs");
    const { activeWorkspaceIdStore, createWorkspace } = await import("../../../../client/src/stores/workspaces");
    const first = createWorkspace("First");
    const second = createWorkspace("Second"); // now active
    activeWorkspaceIdStore.set(first.id); // back to first, "second" is the "other" workspace
    docsStore.set([
      { id: "in-first", name: "A", content: "", updatedAt: 1, createdAt: 1, workspaceId: first.id },
      { id: "in-second", name: "B", content: "", updatedAt: 2, createdAt: 2, workspaceId: second.id },
    ]);
    activeIdStore.set("in-first");
    switchDoc("in-second");
    expect(get(activeIdStore)).toBe("in-second");
    expect(get(activeWorkspaceIdStore)).toBe(second.id);
  });

  it("switchDoc leaves activeWorkspaceIdStore untouched when the target is already in the active workspace", async () => {
    const { docsStore, activeIdStore, switchDoc } = await import("../../../../client/src/stores/docs");
    const { activeWorkspaceIdStore, createWorkspace } = await import("../../../../client/src/stores/workspaces");
    const ws = createWorkspace("Only");
    docsStore.set([
      { id: "doc-a", name: "A", content: "", updatedAt: 1, createdAt: 1, workspaceId: ws.id },
      { id: "doc-b", name: "B", content: "", updatedAt: 2, createdAt: 2, workspaceId: ws.id },
    ]);
    activeIdStore.set("doc-a");
    switchDoc("doc-b");
    expect(get(activeIdStore)).toBe("doc-b");
    expect(get(activeWorkspaceIdStore)).toBe(ws.id);
  });

  // Finding 4 (final whole-branch review): createDoc used to stamp
  // workspaceId: "" when called with zero workspaces existing (several
  // entry points can reach createDoc even from the "no workspace" empty
  // state) — an empty string can never match DocList's
  // `d.workspaceId === $activeWorkspaceIdStore` filter, orphaning the doc.
  it("createDoc self-heals by creating a workspace on demand when none exist", async () => {
    localStorage.setItem("mde:workspaces", "[]");
    const { createDoc } = await import("../../../../client/src/stores/docs");
    const { workspacesStore } = await import("../../../../client/src/stores/workspaces");
    const doc = createDoc();
    expect(doc.workspaceId).toBeTruthy();
    expect(get(workspacesStore).some((w) => w.id === doc.workspaceId)).toBe(true);
  });

  it("importRemoteDocs adds remote docs into the target workspace, renaming on name collision", async () => {
    const { createDoc, docsStore, importRemoteDocs } = await import("../../../../client/src/stores/docs");
    const { createWorkspace } = await import("../../../../client/src/stores/workspaces");
    const ws = createWorkspace("Shared");
    createDoc({ id: "local-1", name: "Notes", workspaceId: ws.id });
    importRemoteDocs(ws.id, [{ id: "remote-1", name: "Notes", content: "remote content", updatedAt: 1, createdAt: 1 }]);

    const docs = get(docsStore).filter((d) => d.workspaceId === ws.id);
    expect(docs).toHaveLength(2);
    expect(docs.find((d) => d.id === "remote-1")?.name).toBe("Notes-2");
  });

  it("docsInWorkspace returns only docs belonging to the given workspace", async () => {
    const { createDoc, docsInWorkspace } = await import("../../../../client/src/stores/docs");
    const { createWorkspace } = await import("../../../../client/src/stores/workspaces");
    const wsA = createWorkspace("A");
    const docA = createDoc({ workspaceId: wsA.id, name: "a" });
    const wsB = createWorkspace("B");
    createDoc({ workspaceId: wsB.id, name: "b" });
    expect(docsInWorkspace(wsA.id).map((d) => d.id)).toEqual([docA.id]);
  });

  it("upsertDocFromRepo creates a new doc when no doc in the workspace has this repoPath", async () => {
    const { upsertDocFromRepo, docsInWorkspace } = await import("../../../../client/src/stores/docs");
    const { createWorkspace } = await import("../../../../client/src/stores/workspaces");
    const ws = createWorkspace("Notes");
    upsertDocFromRepo(ws.id, "notes.md", { name: "notes", content: "hello", repoSha: "sha1" });
    const docs = docsInWorkspace(ws.id);
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ name: "notes", content: "hello", repoPath: "notes.md", repoSha: "sha1", workspaceId: ws.id });
  });

  it("upsertDocFromRepo updates the existing doc in place when repoPath already matches", async () => {
    const { upsertDocFromRepo, docsInWorkspace } = await import("../../../../client/src/stores/docs");
    const { createWorkspace } = await import("../../../../client/src/stores/workspaces");
    const ws = createWorkspace("Notes");
    upsertDocFromRepo(ws.id, "notes.md", { name: "notes", content: "v1", repoSha: "sha1" });
    const firstId = docsInWorkspace(ws.id)[0]!.id;
    upsertDocFromRepo(ws.id, "notes.md", { name: "notes", content: "v2", repoSha: "sha2" });
    const docs = docsInWorkspace(ws.id);
    expect(docs).toHaveLength(1);
    expect(docs[0]!.id).toBe(firstId);
    expect(docs[0]!.content).toBe("v2");
    expect(docs[0]!.repoSha).toBe("sha2");
  });

  it("removeDocsByRepoPaths removes every doc in the workspace matching one of the given paths", async () => {
    const { upsertDocFromRepo, removeDocsByRepoPaths, docsInWorkspace } = await import("../../../../client/src/stores/docs");
    const { createWorkspace } = await import("../../../../client/src/stores/workspaces");
    const ws = createWorkspace("Notes");
    upsertDocFromRepo(ws.id, "a.md", { name: "a", content: "", repoSha: "s1" });
    upsertDocFromRepo(ws.id, "b.md", { name: "b", content: "", repoSha: "s2" });
    removeDocsByRepoPaths(ws.id, ["a.md"]);
    const docs = docsInWorkspace(ws.id);
    expect(docs.map((d) => d.repoPath)).toEqual(["b.md"]);
  });

  it("setDocRepoLinkById sets repoPath/repoSha/repoImageShas on the given doc id", async () => {
    const { createDoc, setDocRepoLinkById, docsInWorkspace } = await import("../../../../client/src/stores/docs");
    const { createWorkspace } = await import("../../../../client/src/stores/workspaces");
    const ws = createWorkspace("Notes");
    const doc = createDoc({ workspaceId: ws.id, name: "a" });
    setDocRepoLinkById(doc.id, "a.md", "sha1", { "img-1": "imgsha1" });
    const found = docsInWorkspace(ws.id).find((d) => d.id === doc.id);
    expect(found).toMatchObject({ repoPath: "a.md", repoSha: "sha1", repoImageShas: { "img-1": "imgsha1" } });
  });

  it("clearRepoSyncMetadata strips repoPath/repoSha/repoImageShas from every doc in the workspace, leaves other workspaces untouched", async () => {
    const { docsStore, clearRepoSyncMetadata } = await import("../../../../client/src/stores/docs");
    const { createWorkspace } = await import("../../../../client/src/stores/workspaces");
    const firstWorkspaceId = createWorkspace("First").id;
    const other = createWorkspace("Other");
    docsStore.set([
      {
        id: "a",
        name: "A",
        content: "",
        updatedAt: 1,
        createdAt: 1,
        workspaceId: firstWorkspaceId,
        repoPath: "a.md",
        repoSha: "sha-a",
        repoImageShas: { "img-1": "sha-img" },
      },
      { id: "b", name: "B", content: "", updatedAt: 2, createdAt: 2, workspaceId: other.id, repoPath: "b.md", repoSha: "sha-b" },
    ]);
    clearRepoSyncMetadata(firstWorkspaceId);
    const docs = get(docsStore);
    const a = docs.find((d) => d.id === "a")!;
    expect(a.repoPath).toBeUndefined();
    expect(a.repoSha).toBeUndefined();
    expect(a.repoImageShas).toBeUndefined();
    const b = docs.find((d) => d.id === "b")!;
    expect(b.repoPath).toBe("b.md");
    expect(b.repoSha).toBe("sha-b");
  });

  it("syncRemoteDocContent writes new content and bumps updatedAt when content differs", async () => {
    const { createDoc, syncRemoteDocContent, findDocById } = await import("../../../../client/src/stores/docs");
    const { createWorkspace } = await import("../../../../client/src/stores/workspaces");
    const ws = createWorkspace("Notes");
    const doc = createDoc({ workspaceId: ws.id, name: "a" });
    const before = findDocById(doc.id)!.updatedAt;
    const wrote = syncRemoteDocContent(doc.id, "new content", undefined);
    expect(wrote).toBe(true);
    const after = findDocById(doc.id)!;
    expect(after.content).toBe("new content");
    expect(after.updatedAt).toBeGreaterThanOrEqual(before);
  });

  it("createDoc splits a leading metadata block out of imported content", async () => {
    const { createDoc } = await import("../../../../client/src/stores/docs");
    const { createWorkspace } = await import("../../../../client/src/stores/workspaces");
    const ws = createWorkspace("Notes");
    const doc = createDoc({ workspaceId: ws.id, content: "Title: Imported Doc\nAuthor: Jane\n\n# Real content\n" });
    expect(doc.metadata).toEqual([
      { key: "Title", value: "Imported Doc" },
      { key: "Author", value: "Jane" },
    ]);
    expect(doc.content).toBe("# Real content\n");
  });

  it("createDoc never re-parses content when metadata is already provided (duplicate case)", async () => {
    const { createDoc } = await import("../../../../client/src/stores/docs");
    const { createWorkspace } = await import("../../../../client/src/stores/workspaces");
    const ws = createWorkspace("Notes");
    const doc = createDoc({ workspaceId: ws.id, content: "Title: Not Metadata\n\nJust content.", metadata: [{ key: "Custom", value: "value" }] });
    expect(doc.metadata).toEqual([{ key: "Custom", value: "value" }]);
    expect(doc.content).toBe("Title: Not Metadata\n\nJust content.");
  });

  it("setActiveDocMetadata updates and persists the active doc's metadata", async () => {
    const { createDoc, setActiveDocMetadata, findDocById } = await import("../../../../client/src/stores/docs");
    const { createWorkspace } = await import("../../../../client/src/stores/workspaces");
    const ws = createWorkspace("Notes");
    const doc = createDoc({ workspaceId: ws.id, name: "Test" });
    setActiveDocMetadata([{ key: "Title", value: "Set via UI" }]);
    expect(findDocById(doc.id)?.metadata).toEqual([{ key: "Title", value: "Set via UI" }]);
  });

  it("syncRemoteDocContent writes new images and bumps updatedAt when images differ", async () => {
    const { createDoc, syncRemoteDocContent, findDocById } = await import("../../../../client/src/stores/docs");
    const { createWorkspace } = await import("../../../../client/src/stores/workspaces");
    const ws = createWorkspace("Notes");
    const doc = createDoc({ workspaceId: ws.id, name: "a", content: "same" });
    const wrote = syncRemoteDocContent(doc.id, "same", { "img-1": "data-a" });
    expect(wrote).toBe(true);
    expect(findDocById(doc.id)!.images).toEqual({ "img-1": "data-a" });
  });

  it("syncRemoteDocContent is a no-op when content and images are unchanged, even with images in a different key order", async () => {
    const { createDoc, syncRemoteDocContent, findDocById } = await import("../../../../client/src/stores/docs");
    const { createWorkspace } = await import("../../../../client/src/stores/workspaces");
    const ws = createWorkspace("Notes");
    const doc = createDoc({ workspaceId: ws.id, name: "a", content: "same" });
    syncRemoteDocContent(doc.id, "same", { "img-1": "data-a", "img-2": "data-b" });
    const before = findDocById(doc.id)!.updatedAt;
    const wrote = syncRemoteDocContent(doc.id, "same", { "img-2": "data-b", "img-1": "data-a" });
    expect(wrote).toBe(false);
    expect(findDocById(doc.id)!.updatedAt).toBe(before);
  });

  it("syncRemoteDocContent returns false when the doc id doesn't exist", async () => {
    const { syncRemoteDocContent } = await import("../../../../client/src/stores/docs");
    expect(syncRemoteDocContent("does-not-exist", "content", undefined)).toBe(false);
  });

  it("syncRemoteDocContent writes a collaborator's rename and bumps updatedAt when the name differs", async () => {
    const { createDoc, syncRemoteDocContent, findDocById } = await import("../../../../client/src/stores/docs");
    const { createWorkspace } = await import("../../../../client/src/stores/workspaces");
    const ws = createWorkspace("Notes");
    const doc = createDoc({ workspaceId: ws.id, name: "a", content: "same" });
    const before = findDocById(doc.id)!.updatedAt;
    const wrote = syncRemoteDocContent(doc.id, "same", undefined, "renamed by collaborator");
    expect(wrote).toBe(true);
    const after = findDocById(doc.id)!;
    expect(after.name).toBe("renamed by collaborator");
    expect(after.updatedAt).toBeGreaterThanOrEqual(before);
  });

  it("syncRemoteDocContent is a no-op when only an unchanged name is passed", async () => {
    const { createDoc, syncRemoteDocContent, findDocById } = await import("../../../../client/src/stores/docs");
    const { createWorkspace } = await import("../../../../client/src/stores/workspaces");
    const ws = createWorkspace("Notes");
    const doc = createDoc({ workspaceId: ws.id, name: "a", content: "same" });
    const before = findDocById(doc.id)!.updatedAt;
    const wrote = syncRemoteDocContent(doc.id, "same", undefined, "a");
    expect(wrote).toBe(false);
    expect(findDocById(doc.id)!.updatedAt).toBe(before);
  });

  it("syncRemoteDocContent silently suffixes a collaborator's rename that collides with another local document's name", async () => {
    const { createDoc, syncRemoteDocContent, findDocById } = await import("../../../../client/src/stores/docs");
    const { createWorkspace } = await import("../../../../client/src/stores/workspaces");
    const ws = createWorkspace("Notes");
    createDoc({ workspaceId: ws.id, name: "Taken" });
    const doc = createDoc({ workspaceId: ws.id, name: "a", content: "same" });
    const wrote = syncRemoteDocContent(doc.id, "same", undefined, "Taken");
    expect(wrote).toBe(true);
    expect(findDocById(doc.id)!.name).toBe("Taken-2");
  });

  it("replaceDocImages fully replaces a doc's image map, not merges into it", async () => {
    const { docsStore, replaceDocImages } = await import("../../../../client/src/stores/docs");
    const { createWorkspace } = await import("../../../../client/src/stores/workspaces");
    const ws = createWorkspace("Images");
    docsStore.set([{ id: "d1", name: "D1", content: "", updatedAt: 1, createdAt: 1, workspaceId: ws.id, images: { old: "data:old" } }]);
    replaceDocImages("d1", { new: "data:new" });
    const doc = get(docsStore).find((d) => d.id === "d1")!;
    expect(doc.images).toEqual({ new: "data:new" });
  });
});
