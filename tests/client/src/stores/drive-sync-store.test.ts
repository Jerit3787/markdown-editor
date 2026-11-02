// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { get } from "svelte/store";
import "fake-indexeddb/auto";
import {
  workspacesStore,
  setWorkspaceDriveLink,
  clearWorkspaceDriveLink,
  setWorkspaceDriveLastSynced,
  queueDriveDeletion,
  clearPendingDriveDeletions,
  queueDriveHistoryDeletion,
  clearPendingDriveHistoryDeletions,
} from "../../../../client/src/stores/workspaces";
import {
  docsStore,
  activeIdStore,
  upsertDocFromDrive,
  removeDocsByDriveFileIds,
  setDocDriveLinkById,
  clearDriveSyncMetadata,
  removeDocById,
} from "../../../../client/src/stores/docs";
import type { Doc, Workspace } from "../../../../client/src/types";

function ws(overrides: Partial<Workspace> = {}): Workspace {
  return { id: "w1", name: "Notes", createdAt: 0, updatedAt: 0, ...overrides };
}

function doc(overrides: Partial<Doc> = {}): Doc {
  return { id: "d1", name: "Notes", content: "", updatedAt: 0, createdAt: 0, workspaceId: "w1", ...overrides };
}

beforeEach(() => {
  localStorage.clear();
  workspacesStore.set([ws()]);
  docsStore.set([doc()]);
  activeIdStore.set("d1");
});

describe("workspace drive link", () => {
  it("sets, stamps last-synced, and clears the link", () => {
    setWorkspaceDriveLink("w1", { folderId: "f1", folderName: "Notes" });
    expect(get(workspacesStore)[0]!.driveLink).toEqual({ folderId: "f1", folderName: "Notes" });

    setWorkspaceDriveLastSynced("w1", 1234);
    expect(get(workspacesStore)[0]!.driveLastSyncedAt).toBe(1234);

    clearWorkspaceDriveLink("w1");
    expect(get(workspacesStore)[0]!.driveLink).toBeUndefined();
    expect(get(workspacesStore)[0]!.driveLastSyncedAt).toBeUndefined();
  });
});

describe("pending drive deletions", () => {
  it("queues once and clears only the sent ids", () => {
    queueDriveDeletion("w1", "f1");
    queueDriveDeletion("w1", "f1");
    queueDriveDeletion("w1", "f2");
    expect(get(workspacesStore)[0]!.pendingDriveDeletions).toEqual(["f1", "f2"]);

    clearPendingDriveDeletions("w1", ["f1"]);
    expect(get(workspacesStore)[0]!.pendingDriveDeletions).toEqual(["f2"]);
  });
});

describe("pending drive history deletions", () => {
  it("queues once and clears only the sent paths", () => {
    queueDriveHistoryDeletion("w1", ".mde/history/notes.json");
    queueDriveHistoryDeletion("w1", ".mde/history/notes.json");
    queueDriveHistoryDeletion("w1", ".mde/history/docs/plan.json");
    expect(get(workspacesStore)[0]!.pendingDriveHistoryDeletions).toEqual([".mde/history/notes.json", ".mde/history/docs/plan.json"]);

    clearPendingDriveHistoryDeletions("w1", [".mde/history/notes.json"]);
    expect(get(workspacesStore)[0]!.pendingDriveHistoryDeletions).toEqual([".mde/history/docs/plan.json"]);
  });
});

describe("drive doc metadata", () => {
  it("creates by path then updates the same doc by file id", () => {
    const created = upsertDocFromDrive("w1", "notes/todo.md", {
      name: "todo",
      content: "# Todo",
      driveFileId: "file-1",
      driveRev: "rev-1",
      drivePushedHash: "hash-1",
      driveImageRevs: { "img-1": { fileId: "img-file", rev: "img-rev" } },
    });
    expect(created.created).toBe(true);
    let stored = get(docsStore).find((d) => d.id === created.id)!;
    expect(stored).toMatchObject({ drivePath: "notes/todo.md", driveFileId: "file-1", driveRev: "rev-1", drivePushedHash: "hash-1" });

    const updated = upsertDocFromDrive("w1", "notes/renamed.md", {
      name: "renamed",
      content: "# Renamed",
      driveFileId: "file-1",
      driveRev: "rev-2",
      drivePushedHash: "hash-2",
    });
    expect(updated).toEqual({ id: created.id, created: false });
    stored = get(docsStore).find((d) => d.id === created.id)!;
    expect(stored).toMatchObject({ drivePath: "notes/renamed.md", content: "# Renamed", driveRev: "rev-2", drivePushedHash: "hash-2" });
  });

  it("matches a never-linked local doc by path on the first pull", () => {
    docsStore.set([doc({ id: "d1", drivePath: "notes.md" })]);
    const result = upsertDocFromDrive("w1", "notes.md", { name: "Notes", content: "remote", driveFileId: "f1", driveRev: "r1" });
    expect(result).toEqual({ id: "d1", created: false });
    expect(get(docsStore)[0]).toMatchObject({ driveFileId: "f1", driveRev: "r1", content: "remote" });
  });

  it("removes docs by drive file id", () => {
    docsStore.set([doc({ id: "d1", driveFileId: "f1" }), doc({ id: "d2", driveFileId: "f2" })]);
    expect(removeDocsByDriveFileIds("w1", ["f1"])).toEqual(["d1"]);
    expect(get(docsStore).map((d) => d.id)).toEqual(["d2"]);
  });

  it("clears folder-sync metadata but leaves the standalone export link", () => {
    docsStore.set([
      doc({
        id: "d1",
        drivePath: "notes.md",
        driveFileId: "f1",
        driveRev: "r1",
        driveImageRevs: { x: { fileId: "i", rev: "r" } },
        drivePushedHash: "h",
        driveExportId: "export-1",
        driveExportName: "notes.md",
      }),
    ]);
    clearDriveSyncMetadata("w1");
    expect(get(docsStore)[0]).toMatchObject({ driveExportId: "export-1", driveExportName: "notes.md" });
    expect(get(docsStore)[0]!.drivePath).toBeUndefined();
    expect(get(docsStore)[0]!.driveFileId).toBeUndefined();
    expect(get(docsStore)[0]!.driveRev).toBeUndefined();
    expect(get(docsStore)[0]!.driveImageRevs).toBeUndefined();
    expect(get(docsStore)[0]!.drivePushedHash).toBeUndefined();
  });

  it("setDocDriveLinkById commits the per-file link", () => {
    setDocDriveLinkById("d1", { drivePath: "a.md", driveFileId: "f1", driveRev: "r1" });
    expect(get(docsStore)[0]).toMatchObject({ drivePath: "a.md", driveFileId: "f1", driveRev: "r1" });
  });
});

describe("removeDocById", () => {
  it("queues the Drive file id and history path when a synced doc is deleted", () => {
    workspacesStore.set([ws({ driveLink: { folderId: "folder-1", folderName: "Notes" } })]);
    docsStore.set([doc({ id: "d1", driveFileId: "f1", drivePath: "notes.md" })]);
    removeDocById("d1");
    expect(get(workspacesStore)[0]!.pendingDriveDeletions).toEqual(["f1"]);
    expect(get(workspacesStore)[0]!.pendingDriveHistoryDeletions).toEqual([".mde/history/notes.json"]);
  });

  it("does not queue a history deletion for a Drive-sourced deletion", () => {
    workspacesStore.set([ws({ driveLink: { folderId: "folder-1", folderName: "Notes" } })]);
    docsStore.set([doc({ id: "d1", driveFileId: "f1", drivePath: "notes.md" })]);
    removeDocById("d1", "drive");
    expect(get(workspacesStore)[0]!.pendingDriveHistoryDeletions).toBeUndefined();
  });
});

describe("remote-sourced deletions", () => {
  it("does not echo a Drive deletion into the repo or Drive push queues", () => {
    workspacesStore.set([
      ws({
        repoLink: { owner: "acme", repo: "notes", branch: "main" },
        driveLink: { folderId: "folder-1", folderName: "Notes" },
      }),
    ]);
    docsStore.set([doc({ id: "d1", repoPath: "notes.md", driveFileId: "f1" })]);
    removeDocById("d1", "drive");
    expect(get(workspacesStore)[0]!.pendingRepoDeletions).toBeUndefined();
    expect(get(workspacesStore)[0]!.pendingDriveDeletions).toBeUndefined();
  });
});
