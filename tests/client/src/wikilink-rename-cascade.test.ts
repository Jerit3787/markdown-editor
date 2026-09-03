import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { planWikilinkRenameCascade } from "../../../client/src/wikilink-rename-cascade";
import type { Doc, Workspace } from "../../../client/src/types";

function workspace(partial: Partial<Workspace> & { id: string }): Workspace {
  return { name: "ws", createdAt: 0, updatedAt: 0, ...partial };
}

function doc(partial: Partial<Doc> & { id: string; workspaceId: string }): Doc {
  return { name: "Doc", content: "", updatedAt: 0, createdAt: 0, ...partial };
}

describe("planWikilinkRenameCascade", () => {
  it("returns empty buckets when nothing references the name", () => {
    const docs = [doc({ id: "1", workspaceId: "ws1", content: "no links" })];
    const workspaces = [workspace({ id: "ws1" })];
    const plan = planWikilinkRenameCascade("Old", docs, "renamed-id", workspaces);
    expect(plan).toEqual({ selfReferenceDoc: null, localTargets: [], sharedTargets: [] });
  });

  it("buckets the renamed document's own self-reference separately, even in a shared workspace", () => {
    const renamed = doc({ id: "renamed-id", workspaceId: "ws1", content: "links to [[Old]] itself" });
    const workspaces = [workspace({ id: "ws1", shared: true, remoteId: "room-1" })];
    const plan = planWikilinkRenameCascade("Old", [renamed], "renamed-id", workspaces);
    expect(plan.selfReferenceDoc?.id).toBe("renamed-id");
    expect(plan.sharedTargets).toEqual([]);
    expect(plan.localTargets).toEqual([]);
  });

  it("buckets a document in a plain local workspace as a local target", () => {
    const other = doc({ id: "2", workspaceId: "ws1", content: "[[Old]]" });
    const workspaces = [workspace({ id: "ws1" })];
    const plan = planWikilinkRenameCascade("Old", [other], "renamed-id", workspaces);
    expect(plan.localTargets.map((d) => d.id)).toEqual(["2"]);
    expect(plan.sharedTargets).toEqual([]);
  });

  it("buckets a document in a shared workspace (with remoteId) as a shared target", () => {
    const other = doc({ id: "2", workspaceId: "ws1", content: "[[Old]]" });
    const workspaces = [workspace({ id: "ws1", shared: true, remoteId: "room-1" })];
    const plan = planWikilinkRenameCascade("Old", [other], "renamed-id", workspaces);
    expect(plan.localTargets).toEqual([]);
    expect(plan.sharedTargets).toEqual([{ doc: other, workspace: workspaces[0] }]);
  });

  it("treats a workspace flagged shared but missing remoteId as a local target (defensive)", () => {
    const other = doc({ id: "2", workspaceId: "ws1", content: "[[Old]]" });
    const workspaces = [workspace({ id: "ws1", shared: true })];
    const plan = planWikilinkRenameCascade("Old", [other], "renamed-id", workspaces);
    expect(plan.localTargets.map((d) => d.id)).toEqual(["2"]);
    expect(plan.sharedTargets).toEqual([]);
  });

  it("buckets a doc whose workspace can't be found as a local target (defensive)", () => {
    const orphan = doc({ id: "2", workspaceId: "missing-ws", content: "[[Old]]" });
    const plan = planWikilinkRenameCascade("Old", [orphan], "renamed-id", []);
    expect(plan.localTargets.map((d) => d.id)).toEqual(["2"]);
  });

  it("handles a mix of self-reference, local, and shared targets in one call", () => {
    const renamed = doc({ id: "renamed-id", workspaceId: "ws1", content: "[[Old]]" });
    const local = doc({ id: "2", workspaceId: "ws1", content: "[[Old]]" });
    const shared = doc({ id: "3", workspaceId: "ws2", content: "[[Old]]" });
    const workspaces = [workspace({ id: "ws1" }), workspace({ id: "ws2", shared: true, remoteId: "room-2" })];
    const plan = planWikilinkRenameCascade("Old", [renamed, local, shared], "renamed-id", workspaces);
    expect(plan.selfReferenceDoc?.id).toBe("renamed-id");
    expect(plan.localTargets.map((d) => d.id)).toEqual(["2"]);
    expect(plan.sharedTargets.map((t) => t.doc.id)).toEqual(["3"]);
  });
});

// @vitest-environment jsdom
describe("runWikilinkRenameCascade", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete (window as any).MDE;
  });

  it("counts a local target rewrite and shows no active-doc or shared work when there's none", async () => {
    const { createDoc } = await import("../../../client/src/stores/docs");
    const { runWikilinkRenameCascade } = await import("../../../client/src/wikilink-rename-cascade");
    const renamed = createDoc({ name: "New", content: "" });
    const linker = createDoc({ name: "Linker", content: "[[Old]]" });
    (window as any).MDE = { applyWikilinkRenameToActiveDoc: vi.fn().mockReturnValue(false) };

    const count = await runWikilinkRenameCascade(renamed.id, "Old", "New");

    expect(count).toBe(1);
    const { findDocById } = await import("../../../client/src/stores/docs");
    expect(findDocById(linker.id)?.content).toBe("[[New]]");
  });

  it("counts a self-reference fixed via the active-editor bridge", async () => {
    const { createDoc } = await import("../../../client/src/stores/docs");
    const { runWikilinkRenameCascade } = await import("../../../client/src/wikilink-rename-cascade");
    const renamed = createDoc({ name: "New", content: "links to [[Old]] itself" });
    const applyToActive = vi.fn().mockReturnValue(true);
    (window as any).MDE = { applyWikilinkRenameToActiveDoc: applyToActive };

    const count = await runWikilinkRenameCascade(renamed.id, "Old", "New");

    expect(count).toBe(1);
    expect(applyToActive).toHaveBeenCalledWith("Old", "New");
  });

  it("counts a shared target pushed successfully, and doesn't let one failure suppress others", async () => {
    const { createDoc, activeDocContent } = await import("../../../client/src/stores/docs");
    const { createWorkspace, workspacesStore } = await import("../../../client/src/stores/workspaces");
    const { runWikilinkRenameCascade } = await import("../../../client/src/wikilink-rename-cascade");
    const renamed = createDoc({ name: "New", content: "" });
    const sharedWs = createWorkspace("Shared");
    workspacesStore.update((all) => all.map((w) => (w.id === sharedWs.id ? { ...w, shared: true, remoteId: "room-1" } : w)));
    const failingWs = createWorkspace("AlsoShared");
    workspacesStore.update((all) => all.map((w) => (w.id === failingWs.id ? { ...w, shared: true, remoteId: "room-2" } : w)));
    createDoc({ workspaceId: sharedWs.id, name: "Good", content: "[[Old]]" });
    // createDoc makes its new doc the active one, and the *next* createDoc
    // call flushes activeDocContent (the live-editor buffer store) into
    // whichever doc was active before it — in this bare unit-test
    // environment activeDocContent never tracks a real editor, so without
    // this it would silently clobber "Good"'s content back to "" the
    // moment "Bad" is created. Setting it to match first makes that flush
    // a no-op.
    activeDocContent.set("[[Old]]");
    createDoc({ workspaceId: failingWs.id, name: "Bad", content: "[[Old]]" });
    (window as any).MDE = { applyWikilinkRenameToActiveDoc: vi.fn().mockReturnValue(false) };
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("room-1")) return new Response(JSON.stringify({ changed: true }), { status: 200 });
      return new Response("nope", { status: 403 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const count = await runWikilinkRenameCascade(renamed.id, "Old", "New");

    // Only the room-1 push (the "Good" target) counts — the room-2 push
    // (the "Bad" target) returns 403, which pushWikilinkRenameToSharedDoc
    // reports as `false` rather than throwing, so it just doesn't add to
    // the total. Both fetches still happen (asserted below) — one
    // target's failure doesn't stop the loop from reaching the other.
    expect(count).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
