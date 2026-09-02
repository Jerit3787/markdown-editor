import { describe, it, expect } from "vitest";
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
