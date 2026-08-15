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
});
