// @vitest-environment jsdom
// collab.ts registers a document.addEventListener("DOMContentLoaded", ...)
// at module load time — a static import of it needs a real `document`
// global to exist during that side effect, which the default node
// environment doesn't provide (localStorage, also touched transitively
// via stores/docs.ts -> stores/workspaces.ts, is covered by the project's
// vitest.setup.ts regardless of environment).
import { describe, it, expect } from "vitest";
import { decideShareTarget, decideJoinTarget } from "./collab";
import type { Doc, Workspace } from "./types";

function fakeDoc(overrides: Partial<Doc>): Doc {
  return { id: "d1", name: "Doc", content: "", updatedAt: 0, createdAt: 0, workspaceId: "w1", ...overrides };
}
function fakeWorkspace(overrides: Partial<Workspace>): Workspace {
  return { id: "w1", name: "Workspace", createdAt: 0, ...overrides };
}

describe("decideShareTarget", () => {
  it("shares directly when the workspace is already shared, even with siblings", () => {
    const doc = fakeDoc({ id: "d1", workspaceId: "w1" });
    const docs = [doc, fakeDoc({ id: "d2", workspaceId: "w1" })];
    const workspaces = [fakeWorkspace({ id: "w1", shared: true })];
    expect(decideShareTarget(doc, docs, workspaces)).toEqual({ kind: "direct" });
  });

  it("shares directly when the workspace is already shared and has no siblings", () => {
    const doc = fakeDoc({ id: "d1", workspaceId: "w1" });
    const workspaces = [fakeWorkspace({ id: "w1", shared: true })];
    expect(decideShareTarget(doc, [doc], workspaces)).toEqual({ kind: "direct" });
  });

  it("shares directly when not shared and the doc has no siblings", () => {
    const doc = fakeDoc({ id: "d1", workspaceId: "w1" });
    const workspaces = [fakeWorkspace({ id: "w1" })];
    expect(decideShareTarget(doc, [doc], workspaces)).toEqual({ kind: "direct" });
  });

  it("returns a choice decision when not shared and the doc has siblings", () => {
    const doc = fakeDoc({ id: "d1", name: "My Notes", workspaceId: "w1" });
    const docs = [doc, fakeDoc({ id: "d2", workspaceId: "w1" }), fakeDoc({ id: "d3", workspaceId: "w1" })];
    const workspaces = [fakeWorkspace({ id: "w1", name: "My Workspace" })];
    expect(decideShareTarget(doc, docs, workspaces)).toEqual({
      kind: "choice",
      docName: "My Notes",
      workspaceName: "My Workspace",
      docCount: 3,
    });
  });

  it("falls back to placeholder names if the doc/workspace name is empty", () => {
    const doc = fakeDoc({ id: "d1", name: "", workspaceId: "w1" });
    const docs = [doc, fakeDoc({ id: "d2", workspaceId: "w1" })];
    const workspaces = [fakeWorkspace({ id: "w1", name: "" })];
    const result = decideShareTarget(doc, docs, workspaces);
    expect(result).toEqual({ kind: "choice", docName: "Untitled", workspaceName: "Untitled workspace", docCount: 2 });
  });
});

describe("decideJoinTarget", () => {
  it("auto-lands a single document as its own new workspace, even with existing workspaces", () => {
    const result = decideJoinTarget([{ name: "Release Notes" }], 3);
    expect(result).toEqual({ kind: "auto", workspaceName: "Release Notes" });
  });

  it("auto-lands a single document as its own new workspace when the receiver has none", () => {
    const result = decideJoinTarget([{ name: "Release Notes" }], 0);
    expect(result).toEqual({ kind: "auto", workspaceName: "Release Notes" });
  });

  it("falls back to a placeholder name when the single document has no name", () => {
    const result = decideJoinTarget([{ name: "" }], 1);
    expect(result).toEqual({ kind: "auto", workspaceName: "Untitled" });
  });

  it("auto-lands a multi-document workspace when the receiver has zero workspaces", () => {
    const result = decideJoinTarget([{ name: "A" }, { name: "B" }], 0);
    expect(result).toEqual({ kind: "auto", workspaceName: "Shared workspace" });
  });

  it("returns a choice decision for a multi-document workspace when the receiver has existing workspaces", () => {
    const result = decideJoinTarget([{ name: "A" }, { name: "B" }], 2);
    expect(result).toEqual({ kind: "choice" });
  });

  it("treats zero valid documents as a multi-document share (no single doc to auto-land)", () => {
    const result = decideJoinTarget([], 0);
    expect(result).toEqual({ kind: "auto", workspaceName: "Shared workspace" });
  });
});
