import { describe, it, expect } from "vitest";
import { planDrivePull, planDrivePush, hashPushPayload, hashImageDataUrl, type DriveEntry, type DriveTree } from "../../../client/src/drive-sync";
import type { Doc } from "../../../client/src/types";

function doc(overrides: Partial<Doc> = {}): Doc {
  return { id: "d1", name: "Notes", content: "", updatedAt: 0, createdAt: 0, workspaceId: "w1", ...overrides };
}

function entry(fileId: string, path: string, rev: string, mimeType = "text/markdown"): DriveEntry {
  return { fileId, path, mimeType, rev };
}

function tree(entries: DriveEntry[], workspaceId: string | null = "w1"): DriveTree {
  return { folderId: "folder-1", folderName: "Notes", workspaceId, entries };
}

describe("planDrivePull", () => {
  it("classifies create / update / unchanged / conflict / deletion", async () => {
    const docs = [
      doc({ id: "d1", name: "A", driveFileId: "a", drivePath: "a.md", driveRev: "r1" }),
      doc({ id: "d2", name: "B", driveFileId: "b", drivePath: "b.md", driveRev: "r1" }),
      doc({ id: "d3", name: "C", driveFileId: "c", drivePath: "c.md", driveRev: "r1" }),
      doc({ id: "d4", name: "Gone", driveFileId: "gone", drivePath: "gone.md", driveRev: "r1" }),
    ];
    const plan = planDrivePull(
      tree([entry("a", "a.md", "r1"), entry("b", "b.md", "r2"), entry("c", "c.md", "r2"), entry("new", "new.md", "r9")]),
      docs,
      new Set(["d3"]),
    );

    expect(plan.creates).toEqual([{ path: "new.md", fileId: "new", rev: "r9" }]);
    expect(plan.updates).toEqual([{ docId: "d2", path: "b.md", fileId: "b", rev: "r2" }]);
    expect(plan.conflicts).toEqual([{ docId: "d3", docName: "C", drivePath: "c.md" }]);
    expect(plan.deletions).toEqual([{ docId: "d4", docName: "Gone", drivePath: "gone.md" }]);
    expect(plan.unchanged).toEqual(["d1"]);
  });

  it("treats an image revision change as a change to its owning doc", async () => {
    const docs = [
      doc({
        id: "d1",
        driveFileId: "a",
        drivePath: "a.md",
        driveRev: "r1",
        driveImageRevs: { "pic.png": { fileId: "img", rev: "ir1" } },
      }),
    ];
    const entries = [entry("a", "a.md", "r1"), entry("img", "assets/a/pic.png", "ir2", "image/png")];

    expect(planDrivePull(tree(entries), docs, new Set()).updates).toHaveLength(1);
    expect(planDrivePull(tree(entries), docs, new Set(["d1"])).conflicts).toHaveLength(1);
  });

  it("matches a never-linked local doc by path on the first pull", () => {
    const docs = [doc({ id: "d1", name: "Notes", drivePath: "notes.md" })];
    const plan = planDrivePull(tree([entry("f1", "notes.md", "r1")]), docs, new Set());
    expect(plan.updates).toEqual([{ docId: "d1", path: "notes.md", fileId: "f1", rev: "r1" }]);
    expect(plan.creates).toHaveLength(0);
  });

  it("ignores non-markdown entries", () => {
    const plan = planDrivePull(tree([entry("img", "assets/a/pic.png", "ir1", "image/png")]), [], new Set());
    expect(plan.creates).toHaveLength(0);
  });
});

describe("hashPushPayload", () => {
  it("is stable regardless of asset order and changes when content changes", async () => {
    const a = { path: "assets/a/x.png", dataUrl: "data:image/png;base64,QQ==" };
    const b = { path: "assets/a/y.png", dataUrl: "data:image/png;base64,Qg==" };
    const first = await hashPushPayload("# Hi", [a, b]);
    expect(await hashPushPayload("# Hi", [b, a])).toBe(first);
    expect(await hashPushPayload("# Bye", [a, b])).not.toBe(first);
  });
});

describe("planDrivePush", () => {
  it("creates a new doc at its slugified path and dedupes against the tree", async () => {
    const docs = [doc({ id: "d1", name: "My Notes", content: "# Hi" }), doc({ id: "d2", name: "My Notes", content: "# Two" })];
    const plan = await planDrivePush(docs, tree([entry("taken", "My Notes.md", "r1")]), true, []);
    expect(plan.creates.map((c) => c.path)).toEqual(["My Notes-2.md", "My Notes-3.md"]);
    expect(plan.creates[0]!.imageOps).toEqual([]);
    expect(plan.conflicts).toHaveLength(0);
  });

  it("is unchanged when the pushed payload hash and remote rev both match", async () => {
    const content = "# Hi";
    const hash = await hashPushPayload(content, []);
    const docs = [doc({ id: "d1", driveFileId: "f1", drivePath: "notes.md", driveRev: "r1", drivePushedHash: hash, content })];
    const plan = await planDrivePush(docs, tree([entry("f1", "notes.md", "r1")]), true, []);
    expect(plan.unchanged).toEqual(["d1"]);
    expect(plan.updates).toHaveLength(0);
  });

  it("updates when local content changed and the remote rev still matches", async () => {
    const oldHash = await hashPushPayload("# Old", []);
    const docs = [doc({ id: "d1", driveFileId: "f1", drivePath: "notes.md", driveRev: "r1", drivePushedHash: oldHash, content: "# New" })];
    const plan = await planDrivePush(docs, tree([entry("f1", "notes.md", "r1")]), true, []);
    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0]!.fileId).toBe("f1");
    expect(plan.updates[0]!.path).toBe("notes.md");
  });

  it("conflicts when both sides changed", async () => {
    const oldHash = await hashPushPayload("# Old", []);
    const docs = [doc({ id: "d1", driveFileId: "f1", drivePath: "notes.md", driveRev: "r1", drivePushedHash: oldHash, content: "# New" })];
    const plan = await planDrivePush(docs, tree([entry("f1", "notes.md", "r2")]), true, []);
    expect(plan.conflicts).toEqual([{ docId: "d1", docName: "Notes", drivePath: "notes.md" }]);
    expect(plan.updates).toHaveLength(0);
  });

  it("renames by creating the new path and deleting the old file id", async () => {
    const hash = await hashPushPayload("# Hi", []);
    const docs = [doc({ id: "d1", name: "New name", driveFileId: "f1", drivePath: "old.md", driveRev: "r1", drivePushedHash: hash, content: "# Hi" })];
    const plan = await planDrivePush(docs, tree([entry("f1", "old.md", "r1")]), true, []);
    expect(plan.creates.map((c) => c.path)).toEqual(["New name.md"]);
    expect(plan.deletes).toEqual(["f1"]);
  });

  it("conflicts on a path match in a folder this workspace does not own", async () => {
    const docs = [doc({ id: "d1", name: "Notes", drivePath: "Notes.md", content: "# Hi" })];
    const plan = await planDrivePush(docs, tree([entry("f1", "Notes.md", "r1")], "other-workspace"), false, []);
    expect(plan.conflicts).toEqual([{ docId: "d1", docName: "Notes", drivePath: "Notes.md" }]);
    expect(plan.creates).toHaveLength(0);
  });

  it("creates missing images and updates changed images", async () => {
    const docs = [
      doc({
        id: "d1",
        content: "![pic](img-1)",
        images: { "img-1": "data:image/png;base64,QQ==" },
        driveFileId: "f1",
        drivePath: "notes.md",
        driveRev: "r1",
        drivePushedHash: await hashPushPayload("![pic](assets/notes/img-1.png)", [{ path: "assets/notes/img-1.png", dataUrl: "data:image/png;base64,QQ==" }]),
      }),
    ];
    const plan = await planDrivePush(docs, tree([entry("f1", "notes.md", "r1")]), true, []);
    expect(plan.updates[0]!.imageOps).toEqual([expect.objectContaining({ kind: "create", ref: "img-1", path: "assets/notes/img-1.png" })]);
  });

  it("deletes orphaned assets only in a folder this workspace owns", async () => {
    const hash = await hashPushPayload("# Hi", []);
    const docs = [doc({ id: "d1", driveFileId: "f1", drivePath: "notes.md", driveRev: "r1", drivePushedHash: hash, content: "# Hi" })];
    const entries = [entry("f1", "notes.md", "r1"), entry("orphan", "assets/notes/orphan.png", "ir1", "image/png")];
    expect((await planDrivePush(docs, tree(entries), true, [])).deletes).toContain("orphan");
    expect((await planDrivePush(docs, tree(entries, "other"), false, [])).deletes).not.toContain("orphan");
  });

  it("carries pending deletions through unless a live doc reclaimed the file", async () => {
    const docs = [doc({ id: "d1", name: "keep", driveFileId: "keep", drivePath: "keep.md", driveRev: "r1", drivePushedHash: await hashPushPayload("", []) })];
    const entries = [entry("keep", "keep.md", "r1"), entry("gone", "gone.md", "r1")];
    expect((await planDrivePush(docs, tree(entries), true, ["gone", "keep"])).deletes).toEqual(["gone"]);
  });
});

describe("truncated Drive trees", () => {
  it("never infers a remote deletion from an incomplete tree", () => {
    const docs = [doc({ id: "d1", name: "Gone", driveFileId: "gone", drivePath: "gone.md", driveRev: "r1" })];
    const incomplete = { ...tree([]), truncated: true };
    expect(planDrivePull(incomplete, docs, new Set()).deletions).toEqual([]);
  });

  it("leaves a missing linked doc alone instead of creating a duplicate", async () => {
    const docs = [doc({ id: "d1", name: "one", driveFileId: "f1", drivePath: "one.md", driveRev: "r1", drivePushedHash: await hashPushPayload("", []) })];
    const plan = await planDrivePush(docs, { ...tree([]), truncated: true }, true, ["f1"]);
    expect(plan.creates).toEqual([]);
    expect(plan.updates).toEqual([]);
    expect(plan.unchanged).toEqual(["d1"]);
  });

  it("skips orphan cleanup on an incomplete tree", async () => {
    const docs = [doc({ id: "d1", name: "notes", driveFileId: "f1", drivePath: "notes.md", driveRev: "r1", drivePushedHash: await hashPushPayload("", []) })];
    const entries = [entry("f1", "notes.md", "r1"), entry("orphan", "assets/notes/orphan.png", "ir1", "image/png")];
    const plan = await planDrivePush(docs, { ...tree(entries), truncated: true }, true, []);
    expect(plan.deletes).toEqual([]);
  });
});

describe("renames with images", () => {
  it("moves an image into the new asset folder and deletes the old file", async () => {
    const dataUrl = "data:image/png;base64,QQ==";
    const oldContent = "![pic](assets/old/img-1.png)";
    const docs = [
      doc({
        id: "d1",
        name: "New",
        content: "![pic](img-1)",
        images: { "img-1": dataUrl },
        driveFileId: "f1",
        drivePath: "old.md",
        driveRev: "r1",
        drivePushedHash: await hashPushPayload(oldContent, [{ path: "assets/old/img-1.png", dataUrl }]),
        driveImageRevs: { "img-1": { fileId: "img1", rev: "ir1", hash: await hashImageDataUrl(dataUrl) } },
      }),
    ];
    const entries = [entry("f1", "old.md", "r1"), entry("img1", "assets/old/img-1.png", "ir1", "image/png")];
    const plan = await planDrivePush(docs, tree(entries), true, []);
    expect(plan.creates).toHaveLength(1);
    expect(plan.creates[0]!.path).toBe("New.md");
    expect(plan.creates[0]!.imageOps).toEqual([expect.objectContaining({ kind: "create", path: "assets/New/img-1.png" })]);
    expect(plan.deletes).toEqual(expect.arrayContaining(["f1", "img1"]));
  });
});

describe("rename conflicts", () => {
  it("does not delete the old file when the renamed doc also conflicts", async () => {
    const dataA = "data:image/png;base64,QQ==";
    const dataB = "data:image/png;base64,Qg==";
    const docs = [
      doc({
        id: "d1",
        name: "New",
        content: "![pic](img-1)",
        images: { "img-1": dataB },
        driveFileId: "f1",
        drivePath: "old.md",
        driveRev: "r1",
        drivePushedHash: await hashPushPayload("![pic](assets/old/img-1.png)", [{ path: "assets/old/img-1.png", dataUrl: dataA }]),
        driveImageRevs: { "img-1": { fileId: "img1", rev: "ir1", hash: await hashImageDataUrl(dataA) } },
      }),
    ];
    const entries = [entry("f1", "old.md", "r1"), entry("img1", "assets/old/img-1.png", "ir2", "image/png")];
    const plan = await planDrivePush(docs, tree(entries), true, []);
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.deletes).toEqual([]);
    expect(plan.creates).toEqual([]);
  });
});

describe("pending local deletions", () => {
  it("does not pull back a file the user already deleted locally", () => {
    const plan = planDrivePull(tree([entry("f1", "notes.md", "r1")]), [], new Set(), ["f1"]);
    expect(plan.creates).toEqual([]);
  });
});

describe("pending deletions on incomplete trees", () => {
  it("still retries a known pending deletion", async () => {
    const plan = await planDrivePush([], { ...tree([]), truncated: true }, true, ["gone"]);
    expect(plan.deletes).toEqual(["gone"]);
    expect(plan.pendingDeletes).toEqual(["gone"]);
  });
});
