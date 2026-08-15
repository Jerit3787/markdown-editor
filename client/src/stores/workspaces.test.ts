// @vitest-environment jsdom
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

describe("workspaces store — first-run seeding", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it("seeds exactly one default workspace when mde:workspaces was never set", async () => {
    const { workspacesStore, activeWorkspaceIdStore } = await import("./workspaces");
    const workspaces = get(workspacesStore);
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0].name).toBe("My Workspace");
    expect(get(activeWorkspaceIdStore)).toBe(workspaces[0].id);
    expect(localStorage.getItem("mde:workspaces")).not.toBeNull();
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
      ])
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
    const { workspacesStore, renameWorkspace } = await import("./workspaces");
    const originalId = get(workspacesStore)[0].id;
    renameWorkspace(originalId, "Renamed");
    expect(get(workspacesStore).find((w) => w.id === originalId)?.name).toBe("Renamed");
  });

  it("switchWorkspace returns false when already active, true when it actually switches", async () => {
    const { activeWorkspaceIdStore, createWorkspace, switchWorkspace } = await import("./workspaces");
    const firstId = get(activeWorkspaceIdStore)!;
    const second = createWorkspace("Second"); // now active
    expect(switchWorkspace(second.id)).toBe(false);
    expect(switchWorkspace(firstId)).toBe(true);
    expect(get(activeWorkspaceIdStore)).toBe(firstId);
  });

  it("deleteWorkspaceRecord falls back to the oldest remaining workspace when the active one is deleted", async () => {
    const { workspacesStore, activeWorkspaceIdStore, createWorkspace, deleteWorkspaceRecord } = await import("./workspaces");
    const first = get(workspacesStore)[0];
    const second = createWorkspace("Second"); // now active
    deleteWorkspaceRecord(second.id);
    expect(get(activeWorkspaceIdStore)).toBe(first.id);
    expect(get(workspacesStore).map((w) => w.id)).not.toContain(second.id);
  });

  it("deleteWorkspaceRecord sets active to null when the last workspace is deleted", async () => {
    const { workspacesStore, activeWorkspaceIdStore, deleteWorkspaceRecord } = await import("./workspaces");
    deleteWorkspaceRecord(get(workspacesStore)[0].id);
    expect(get(activeWorkspaceIdStore)).toBeNull();
    expect(get(workspacesStore)).toEqual([]);
  });

  it("deleteWorkspaceRecord leaves the active workspace alone when deleting a different one", async () => {
    const { workspacesStore, activeWorkspaceIdStore, createWorkspace, deleteWorkspaceRecord } = await import("./workspaces");
    const firstId = get(activeWorkspaceIdStore)!;
    const second = createWorkspace("Second");
    deleteWorkspaceRecord(firstId);
    expect(get(activeWorkspaceIdStore)).toBe(second.id);
    expect(get(workspacesStore).map((w) => w.id)).toEqual([second.id]);
  });
});
