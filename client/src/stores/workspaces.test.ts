// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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

describe("workspaces store — first-run seeding", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it("starts with zero workspaces when mde:workspaces was never set, and persists that immediately", async () => {
    const { workspacesStore, activeWorkspaceIdStore } = await import("./workspaces");
    expect(get(workspacesStore)).toEqual([]);
    expect(get(activeWorkspaceIdStore)).toBeNull();
    expect(localStorage.getItem("mde:workspaces")).toBe("[]");
  });

  it("respects an explicitly empty array instead of re-seeding", async () => {
    localStorage.setItem("mde:workspaces", "[]");
    const { workspacesStore, activeWorkspaceIdStore } = await import("./workspaces");
    expect(get(workspacesStore)).toEqual([]);
    expect(get(activeWorkspaceIdStore)).toBeNull();
  });

  it("restores the previously active workspace id from storage", async () => {
    localStorage.setItem(
      "mde:workspaces",
      JSON.stringify([
        { id: "a", name: "A", createdAt: 1 },
        { id: "b", name: "B", createdAt: 2 },
      ]),
    );
    localStorage.setItem("mde:activeWorkspace", "b");
    const { activeWorkspaceIdStore } = await import("./workspaces");
    expect(get(activeWorkspaceIdStore)).toBe("b");
  });
});

describe("workspaces store — mutations", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it("createWorkspace adds and activates a new workspace", async () => {
    const { workspacesStore, activeWorkspaceIdStore, createWorkspace } = await import("./workspaces");
    const ws = createWorkspace("Second");
    expect(get(workspacesStore).map((w) => w.name)).toContain("Second");
    expect(get(activeWorkspaceIdStore)).toBe(ws.id);
  });

  it("renameWorkspace updates only the name", async () => {
    const { workspacesStore, createWorkspace, renameWorkspace } = await import("./workspaces");
    const original = createWorkspace("Original");
    renameWorkspace(original.id, "Renamed");
    expect(get(workspacesStore).find((w) => w.id === original.id)?.name).toBe("Renamed");
  });

  it("switchWorkspace returns false when already active, true when it actually switches", async () => {
    const { activeWorkspaceIdStore, createWorkspace, switchWorkspace } = await import("./workspaces");
    const first = createWorkspace("First");
    const second = createWorkspace("Second"); // now active
    expect(switchWorkspace(second.id)).toBe(false);
    expect(switchWorkspace(first.id)).toBe(true);
    expect(get(activeWorkspaceIdStore)).toBe(first.id);
  });

  it("deleteWorkspaceRecord falls back to the oldest remaining workspace when the active one is deleted", async () => {
    const { workspacesStore, activeWorkspaceIdStore, createWorkspace, deleteWorkspaceRecord } = await import("./workspaces");
    const first = createWorkspace("First");
    const second = createWorkspace("Second"); // now active
    deleteWorkspaceRecord(second.id);
    expect(get(activeWorkspaceIdStore)).toBe(first.id);
    expect(get(workspacesStore).map((w) => w.id)).not.toContain(second.id);
  });

  it("deleteWorkspaceRecord sets active to null when the last workspace is deleted", async () => {
    const { workspacesStore, activeWorkspaceIdStore, createWorkspace, deleteWorkspaceRecord } = await import("./workspaces");
    const only = createWorkspace("Only");
    deleteWorkspaceRecord(only.id);
    expect(get(activeWorkspaceIdStore)).toBeNull();
    expect(get(workspacesStore)).toEqual([]);
  });

  it("deleteWorkspaceRecord leaves the active workspace alone when deleting a different one", async () => {
    const { workspacesStore, activeWorkspaceIdStore, createWorkspace, deleteWorkspaceRecord } = await import("./workspaces");
    const first = createWorkspace("First");
    const second = createWorkspace("Second");
    deleteWorkspaceRecord(first.id);
    expect(get(activeWorkspaceIdStore)).toBe(second.id);
    expect(get(workspacesStore).map((w) => w.id)).toEqual([second.id]);
  });

  it("persists shared and remoteId through createWorkspace + reload", async () => {
    const { workspacesStore, createWorkspace, persistWorkspaces } = await import("./workspaces");
    const ws = createWorkspace("Team Docs");
    workspacesStore.update((all) => all.map((w) => (w.id === ws.id ? { ...w, shared: true, remoteId: "room-abc" } : w)));
    persistWorkspaces();

    const stored = JSON.parse(localStorage.getItem("mde:workspaces")!);
    const found = stored.find((w: { id: string }) => w.id === ws.id);
    expect(found.shared).toBe(true);
    expect(found.remoteId).toBe("room-abc");
  });

  it("adoptSharedWorkspace creates a new local workspace tagged shared+remoteId", async () => {
    const { workspacesStore, adoptSharedWorkspace } = await import("./workspaces");
    const ws = adoptSharedWorkspace("room-xyz", "Team Docs");
    expect(ws.shared).toBe(true);
    expect(ws.remoteId).toBe("room-xyz");
    expect(ws.name).toBe("Team Docs");
    expect(get(workspacesStore).find((w) => w.id === ws.id)).toBeTruthy();
  });

  it("mergeSharedWorkspaceInto tags an existing workspace with shared+remoteId", async () => {
    const { workspacesStore, createWorkspace, mergeSharedWorkspaceInto } = await import("./workspaces");
    const existing = createWorkspace("My Notes");
    mergeSharedWorkspaceInto(existing.id, "room-xyz");
    const updated = get(workspacesStore).find((w) => w.id === existing.id);
    expect(updated?.shared).toBe(true);
    expect(updated?.remoteId).toBe("room-xyz");
  });

  it("setWorkspaceRepoLink sets repoLink on the matching workspace, leaves others untouched", async () => {
    const { workspacesStore, createWorkspace, setWorkspaceRepoLink } = await import("./workspaces");
    const ws = createWorkspace("Notes");
    const other = createWorkspace("Other");
    setWorkspaceRepoLink(ws.id, { owner: "alice", repo: "notes", branch: "main" });
    const all = get(workspacesStore);
    expect(all.find((w) => w.id === ws.id)?.repoLink).toEqual({ owner: "alice", repo: "notes", branch: "main" });
    expect(all.find((w) => w.id === other.id)?.repoLink).toBeUndefined();
  });

  it("clearWorkspaceRepoLink removes repoLink from the matching workspace", async () => {
    const { workspacesStore, createWorkspace, setWorkspaceRepoLink, clearWorkspaceRepoLink } = await import("./workspaces");
    const ws = createWorkspace("Notes");
    setWorkspaceRepoLink(ws.id, { owner: "alice", repo: "notes", branch: "main" });
    clearWorkspaceRepoLink(ws.id);
    expect(get(workspacesStore).find((w) => w.id === ws.id)?.repoLink).toBeUndefined();
  });

  it("setWorkspaceLastSynced sets repoLastSyncedAt on the matching workspace, leaves others untouched", async () => {
    const { workspacesStore, createWorkspace, setWorkspaceLastSynced } = await import("./workspaces");
    const ws = createWorkspace("Notes");
    const other = createWorkspace("Other");
    setWorkspaceLastSynced(ws.id, 12345);
    const all = get(workspacesStore);
    expect(all.find((w) => w.id === ws.id)?.repoLastSyncedAt).toBe(12345);
    expect(all.find((w) => w.id === other.id)?.repoLastSyncedAt).toBeUndefined();
  });

  it("clearWorkspaceRepoLink also clears repoLastSyncedAt", async () => {
    const { workspacesStore, createWorkspace, setWorkspaceRepoLink, setWorkspaceLastSynced, clearWorkspaceRepoLink } = await import("./workspaces");
    const ws = createWorkspace("Notes");
    setWorkspaceRepoLink(ws.id, { owner: "alice", repo: "notes", branch: "main" });
    setWorkspaceLastSynced(ws.id, 12345);
    clearWorkspaceRepoLink(ws.id);
    expect(get(workspacesStore).find((w) => w.id === ws.id)?.repoLastSyncedAt).toBeUndefined();
  });
});

describe("workspaces store — updatedAt", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(1000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("backfills updatedAt from createdAt for a workspace stored before this field existed", async () => {
    localStorage.setItem("mde:workspaces", JSON.stringify([{ id: "a", name: "A", createdAt: 42 }]));
    const { workspacesStore } = await import("./workspaces");
    expect(get(workspacesStore).find((w) => w.id === "a")?.updatedAt).toBe(42);
  });

  it("createWorkspace stamps updatedAt at creation", async () => {
    const { createWorkspace } = await import("./workspaces");
    const ws = createWorkspace("New");
    expect(ws.updatedAt).toBe(1000);
  });

  it("adoptSharedWorkspace stamps updatedAt at creation", async () => {
    const { adoptSharedWorkspace } = await import("./workspaces");
    const ws = adoptSharedWorkspace("remote-1", "Shared");
    expect(ws.updatedAt).toBe(1000);
  });

  it("renameWorkspace bumps updatedAt", async () => {
    const { workspacesStore, createWorkspace, renameWorkspace } = await import("./workspaces");
    const original = createWorkspace("Original");
    vi.setSystemTime(2000);
    renameWorkspace(original.id, "Renamed");
    expect(get(workspacesStore).find((w) => w.id === original.id)?.updatedAt).toBe(2000);
  });

  it("mergeSharedWorkspaceInto bumps updatedAt", async () => {
    const { workspacesStore, createWorkspace, mergeSharedWorkspaceInto } = await import("./workspaces");
    const original = createWorkspace("Original");
    vi.setSystemTime(2000);
    mergeSharedWorkspaceInto(original.id, "remote-1");
    expect(get(workspacesStore).find((w) => w.id === original.id)?.updatedAt).toBe(2000);
  });

  it("setWorkspaceRepoLink bumps updatedAt", async () => {
    const { workspacesStore, createWorkspace, setWorkspaceRepoLink } = await import("./workspaces");
    const original = createWorkspace("Original");
    vi.setSystemTime(2000);
    setWorkspaceRepoLink(original.id, { owner: "alice", repo: "notes", branch: "main" });
    expect(get(workspacesStore).find((w) => w.id === original.id)?.updatedAt).toBe(2000);
  });

  it("clearWorkspaceRepoLink bumps updatedAt", async () => {
    const { workspacesStore, createWorkspace, setWorkspaceRepoLink, clearWorkspaceRepoLink } = await import("./workspaces");
    const original = createWorkspace("Original");
    setWorkspaceRepoLink(original.id, { owner: "alice", repo: "notes", branch: "main" });
    vi.setSystemTime(2000);
    clearWorkspaceRepoLink(original.id);
    expect(get(workspacesStore).find((w) => w.id === original.id)?.updatedAt).toBe(2000);
  });

  it("setWorkspaceLastSynced bumps updatedAt", async () => {
    const { workspacesStore, createWorkspace, setWorkspaceLastSynced } = await import("./workspaces");
    const original = createWorkspace("Original");
    vi.setSystemTime(2000);
    setWorkspaceLastSynced(original.id, 2000);
    expect(get(workspacesStore).find((w) => w.id === original.id)?.updatedAt).toBe(2000);
  });

  it("persistWorkspaces merges with what another tab already saved instead of overwriting it", async () => {
    localStorage.setItem("mde:workspaces", JSON.stringify([{ id: "ws-a", name: "A", createdAt: 1, updatedAt: 1 }]));
    const { workspacesStore, persistWorkspaces } = await import("./workspaces");

    // Simulate another tab having since created ws-b and saved it.
    localStorage.setItem(
      "mde:workspaces",
      JSON.stringify([
        { id: "ws-a", name: "A", createdAt: 1, updatedAt: 1 },
        { id: "ws-b", name: "B from another tab", createdAt: 2, updatedAt: 2 },
      ]),
    );

    // This tab, unaware of ws-b, renames ws-a and saves.
    workspacesStore.set([{ id: "ws-a", name: "A renamed here", createdAt: 1, updatedAt: 3 }]);
    persistWorkspaces();

    const persisted = JSON.parse(localStorage.getItem("mde:workspaces")!);
    expect(persisted).toHaveLength(2);
    expect(persisted.find((w: any) => w.id === "ws-a").name).toBe("A renamed here");
    expect(persisted.find((w: any) => w.id === "ws-b").name).toBe("B from another tab");
    expect(get(workspacesStore)).toHaveLength(2);
  });

  it("deleteWorkspaceRecord's own save doesn't resurrect the workspace from the pre-deletion snapshot still in localStorage", async () => {
    localStorage.setItem("mde:workspaces", JSON.stringify([{ id: "ws-a", name: "A", createdAt: 1, updatedAt: 1 }]));
    const { workspacesStore, deleteWorkspaceRecord } = await import("./workspaces");

    deleteWorkspaceRecord("ws-a");

    const persisted = JSON.parse(localStorage.getItem("mde:workspaces")!);
    expect(persisted.find((w: any) => w.id === "ws-a")).toBeUndefined();
    expect(get(workspacesStore).find((w) => w.id === "ws-a")).toBeUndefined();
  });
});
