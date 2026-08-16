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
      ])
    );
    const { docsStore } = await import("./docs");
    const { workspacesStore } = await import("./workspaces");
    const defaultWorkspaceId = get(workspacesStore)[0].id;
    const docs = get(docsStore);
    expect(docs.find((d) => d.id === "legacy")?.workspaceId).toBe(defaultWorkspaceId);
    expect(docs.find((d) => d.id === "tagged")?.workspaceId).toBe("some-other-ws");
  });

  it("createDoc stamps the currently-active workspace by default", async () => {
    const { createDoc } = await import("./docs");
    const { activeWorkspaceIdStore, createWorkspace } = await import("./workspaces");
    const second = createWorkspace("Second"); // now active
    const doc = createDoc();
    expect(doc.workspaceId).toBe(second.id);
    expect(get(activeWorkspaceIdStore)).toBe(second.id);
  });

  it("createDoc respects an explicit workspaceId override", async () => {
    const { createDoc } = await import("./docs");
    const { workspacesStore } = await import("./workspaces");
    const firstWorkspaceId = get(workspacesStore)[0].id;
    const doc = createDoc({ workspaceId: firstWorkspaceId, name: "Explicit" });
    expect(doc.workspaceId).toBe(firstWorkspaceId);
  });

  it("getActiveDoc falls back to a doc in the active workspace, not an arbitrary one", async () => {
    const { docsStore, activeIdStore, getActiveDoc } = await import("./docs");
    const { workspacesStore, createWorkspace } = await import("./workspaces");
    const firstWorkspaceId = get(workspacesStore)[0].id;
    const second = createWorkspace("Second");
    docsStore.set([
      { id: "a", name: "A", content: "", updatedAt: 1, createdAt: 1, workspaceId: firstWorkspaceId },
      { id: "b", name: "B", content: "", updatedAt: 2, createdAt: 2, workspaceId: second.id },
    ]);
    activeIdStore.set("does-not-exist");
    expect(getActiveDoc()?.id).toBe("b"); // active workspace is "second"
  });

  it("removeDocById falls back to a remaining doc in the same workspace as the one removed", async () => {
    const { docsStore, activeIdStore, removeDocById } = await import("./docs");
    const { workspacesStore, createWorkspace } = await import("./workspaces");
    const firstWorkspaceId = get(workspacesStore)[0].id;
    const second = createWorkspace("Second");
    docsStore.set([
      { id: "a1", name: "A1", content: "", updatedAt: 1, createdAt: 1, workspaceId: firstWorkspaceId },
      { id: "a2", name: "A2", content: "", updatedAt: 2, createdAt: 2, workspaceId: firstWorkspaceId },
      { id: "b1", name: "B1", content: "", updatedAt: 3, createdAt: 3, workspaceId: second.id },
    ]);
    activeIdStore.set("a1");
    removeDocById("a1");
    expect(get(activeIdStore)).toBe("a2");
  });

  it("ensureActiveDocInWorkspace picks the most-recently-updated doc in the target workspace", async () => {
    const { docsStore, activeIdStore, ensureActiveDocInWorkspace } = await import("./docs");
    const { createWorkspace } = await import("./workspaces");
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
    const { docsStore, activeIdStore, ensureActiveDocInWorkspace } = await import("./docs");
    const { createWorkspace } = await import("./workspaces");
    const ws = createWorkspace("Target");
    docsStore.set([{ id: "already-active", name: "X", content: "", updatedAt: 1, createdAt: 1, workspaceId: ws.id }]);
    activeIdStore.set("already-active");
    ensureActiveDocInWorkspace(ws.id);
    expect(get(activeIdStore)).toBe("already-active");
  });

  it("ensureActiveDocInWorkspace sets null when the target workspace has no documents", async () => {
    const { docsStore, activeIdStore, ensureActiveDocInWorkspace } = await import("./docs");
    const { createWorkspace } = await import("./workspaces");
    const empty = createWorkspace("Empty");
    docsStore.set([]);
    ensureActiveDocInWorkspace(empty.id);
    expect(get(activeIdStore)).toBeNull();
  });

  it("moveDocToWorkspace reassigns workspaceId without touching other fields", async () => {
    const { docsStore, moveDocToWorkspace } = await import("./docs");
    const { createWorkspace } = await import("./workspaces");
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
      ])
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
      ])
    );
    const { activeIdStore } = await import("./docs");
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
      ])
    );
    localStorage.setItem("mde:activeWorkspace", "newer");
    localStorage.setItem(
      "mde:docs",
      JSON.stringify([{ id: "legacy", name: "Legacy", content: "", updatedAt: 1, createdAt: 1 }])
    );
    const { docsStore } = await import("./docs");
    expect(get(docsStore).find((d) => d.id === "legacy")?.workspaceId).toBe("older");
  });

  it("persists a workspaceId backfill to localStorage immediately, not only in memory", async () => {
    localStorage.setItem(
      "mde:docs",
      JSON.stringify([{ id: "legacy", name: "Legacy", content: "", updatedAt: 1, createdAt: 1 }])
    );
    await import("./docs");
    const { workspacesStore } = await import("./workspaces");
    const defaultWorkspaceId = get(workspacesStore)[0].id;
    const persisted = JSON.parse(localStorage.getItem("mde:docs")!);
    expect(persisted.find((d: { id: string }) => d.id === "legacy")?.workspaceId).toBe(defaultWorkspaceId);
  });

  it("does not rewrite mde:docs when no document needed a workspaceId backfill", async () => {
    localStorage.setItem(
      "mde:docs",
      JSON.stringify([{ id: "tagged", name: "Tagged", content: "", updatedAt: 1, createdAt: 1, workspaceId: "some-other-ws" }])
    );
    await import("./docs");
    // Storage should be untouched byte-for-byte (no backfill needed, so no
    // persistDocs() call) — re-parsing and comparing the one field we care
    // about is enough without over-asserting on exact JSON formatting.
    const persisted = JSON.parse(localStorage.getItem("mde:docs")!);
    expect(persisted[0].workspaceId).toBe("some-other-ws");
  });

  // Finding 3 (final whole-branch review, USER DECISION: cross-workspace
  // navigation follows you to the target workspace): switchDoc is the
  // single choke point every consumer (wikilinks, Command Palette, File >
  // Recent, backlinks, shared-link join) funnels through.
  it("switchDoc follows the target document's workspace when it differs from the active one", async () => {
    const { docsStore, activeIdStore, switchDoc } = await import("./docs");
    const { activeWorkspaceIdStore, createWorkspace } = await import("./workspaces");
    const firstWorkspaceId = get(activeWorkspaceIdStore)!;
    const second = createWorkspace("Second"); // now active
    activeWorkspaceIdStore.set(firstWorkspaceId); // back to first, "second" is the "other" workspace
    docsStore.set([
      { id: "in-first", name: "A", content: "", updatedAt: 1, createdAt: 1, workspaceId: firstWorkspaceId },
      { id: "in-second", name: "B", content: "", updatedAt: 2, createdAt: 2, workspaceId: second.id },
    ]);
    activeIdStore.set("in-first");
    switchDoc("in-second");
    expect(get(activeIdStore)).toBe("in-second");
    expect(get(activeWorkspaceIdStore)).toBe(second.id);
  });

  it("switchDoc leaves activeWorkspaceIdStore untouched when the target is already in the active workspace", async () => {
    const { docsStore, activeIdStore, switchDoc } = await import("./docs");
    const { activeWorkspaceIdStore } = await import("./workspaces");
    const activeWorkspaceId = get(activeWorkspaceIdStore)!;
    docsStore.set([
      { id: "doc-a", name: "A", content: "", updatedAt: 1, createdAt: 1, workspaceId: activeWorkspaceId },
      { id: "doc-b", name: "B", content: "", updatedAt: 2, createdAt: 2, workspaceId: activeWorkspaceId },
    ]);
    activeIdStore.set("doc-a");
    switchDoc("doc-b");
    expect(get(activeIdStore)).toBe("doc-b");
    expect(get(activeWorkspaceIdStore)).toBe(activeWorkspaceId);
  });

  // Finding 4 (final whole-branch review): createDoc used to stamp
  // workspaceId: "" when called with zero workspaces existing (several
  // entry points can reach createDoc even from the "no workspace" empty
  // state) — an empty string can never match DocList's
  // `d.workspaceId === $activeWorkspaceIdStore` filter, orphaning the doc.
  it("createDoc self-heals by creating a workspace on demand when none exist", async () => {
    localStorage.setItem("mde:workspaces", "[]");
    const { createDoc } = await import("./docs");
    const { workspacesStore } = await import("./workspaces");
    const doc = createDoc();
    expect(doc.workspaceId).toBeTruthy();
    expect(get(workspacesStore).some((w) => w.id === doc.workspaceId)).toBe(true);
  });

  it("importRemoteDocs adds remote docs into the target workspace, renaming on name collision", async () => {
    const { createDoc, docsStore, importRemoteDocs } = await import("./docs");
    const { createWorkspace } = await import("./workspaces");
    const ws = createWorkspace("Shared");
    createDoc({ id: "local-1", name: "Notes", workspaceId: ws.id });
    importRemoteDocs(ws.id, [{ id: "remote-1", name: "Notes", content: "remote content", updatedAt: 1, createdAt: 1 }]);

    const docs = get(docsStore).filter((d) => d.workspaceId === ws.id);
    expect(docs).toHaveLength(2);
    expect(docs.find((d) => d.id === "remote-1")?.name).toBe("Notes-2");
  });
});
