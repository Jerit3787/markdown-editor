// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "fake-indexeddb/auto";
import { get } from "svelte/store";
import { linkWorkspaceToDrive, pullFromDrive, pushToDrive, DriveReconnectError, hashPushPayload, hashImageDataUrl } from "../../../client/src/drive-sync";
import { workspacesStore, activeWorkspaceIdStore } from "../../../client/src/stores/workspaces";
import { docsStore, activeIdStore } from "../../../client/src/stores/docs";
import type { Doc } from "../../../client/src/types";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function b64(text: string): string {
  return Buffer.from(text, "utf-8").toString("base64");
}

function doc(overrides: Partial<Doc> = {}): Doc {
  return { id: "d1", name: "Notes", content: "", updatedAt: 0, createdAt: 0, workspaceId: "w1", ...overrides };
}

function linkedWorkspace() {
  workspacesStore.set([{ id: "w1", name: "Notes", createdAt: 0, updatedAt: 0, driveLink: { folderId: "folder-1", folderName: "Notes" } }]);
  activeWorkspaceIdStore.set("w1");
}

beforeEach(() => {
  localStorage.clear();
  workspacesStore.set([{ id: "w1", name: "Notes", createdAt: 0, updatedAt: 0 }]);
  activeWorkspaceIdStore.set("w1");
  docsStore.set([]);
  activeIdStore.set(null);
});

afterEach(() => vi.unstubAllGlobals());

describe("linkWorkspaceToDrive", () => {
  it("creates the folder, stores the link, and pushes every local doc", async () => {
    docsStore.set([doc({ id: "d1", name: "Notes", content: "# Hi" })]);
    let pushBody: any;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const u = String(url);
        if (u === "/api/drive/folder") {
          expect(JSON.parse(String(init!.body))).toMatchObject({ workspaceId: "w1", workspaceName: "Notes", folderName: "Notes" });
          return json({ folderId: "folder-1", folderName: "Notes" });
        }
        if (u.includes("/tree")) return json({ folderId: "folder-1", folderName: "Notes", workspaceId: "w1", entries: [] });
        if (u.includes("/push")) {
          pushBody = JSON.parse(String(init!.body));
          return json({
            results: pushBody.creates.map((create: any, i: number) => ({ path: create.path, op: "create", ok: true, fileId: `f${i + 1}`, rev: `r${i + 1}` })),
            synced: pushBody.creates.length,
            failed: 0,
          });
        }
        throw new Error(`unexpected fetch ${u}`);
      }),
    );

    const { plan, result } = await linkWorkspaceToDrive("w1", "Notes");
    expect(plan.creates).toHaveLength(1);
    expect(result).toMatchObject({ synced: 1, failed: 0 });
    expect(pushBody.creates[0]).toMatchObject({ path: "Notes.md", mimeType: "text/markdown" });
    expect(get(workspacesStore)[0]!.driveLink).toEqual({ folderId: "folder-1", folderName: "Notes" });

    const stored = get(docsStore)[0]!;
    expect(stored.driveFileId).toBe("f1");
    expect(stored.driveRev).toBe("r1");
    expect(stored.drivePath).toBe("Notes.md");
    expect(stored.drivePushedHash).toBe(await hashPushPayload("# Hi", []));
  });
});

describe("pullFromDrive", () => {
  it("downloads markdown and its images, rewrites refs, and records revisions", async () => {
    linkedWorkspace();
    const markdown = "# Hi\n\n![pic](assets/notes/pic.png)";
    const imageBase64 = Buffer.from("PNGDATA").toString("base64");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const u = String(url);
        if (u.includes("/tree")) {
          return json({
            folderId: "folder-1",
            folderName: "Notes",
            workspaceId: "w1",
            entries: [
              { fileId: "f1", path: "notes.md", mimeType: "text/markdown", rev: "r1" },
              { fileId: "img1", path: "assets/notes/pic.png", mimeType: "image/png", rev: "ir1" },
            ],
          });
        }
        if (u.includes("/file/f1")) return json({ contentBase64: b64(markdown) });
        if (u.includes("/file/img1")) return json({ contentBase64: imageBase64 });
        throw new Error(`unexpected fetch ${u}`);
      }),
    );

    const { plan } = await pullFromDrive("w1");
    expect(plan.creates).toHaveLength(1);
    const stored = get(docsStore)[0]!;
    expect(stored.name).toBe("notes");
    expect(stored.content).toBe("# Hi\n\n![pic](pic.png)");
    expect(stored.images).toEqual({ "pic.png": `data:image/png;base64,${imageBase64}` });
    expect(stored.driveFileId).toBe("f1");
    expect(stored.driveRev).toBe("r1");
    expect(stored.driveImageRevs?.["pic.png"]).toMatchObject({ fileId: "img1", rev: "ir1" });
    expect(stored.driveImageRevs?.["pic.png"]?.hash).toBe(await hashImageDataUrl(`data:image/png;base64,${imageBase64}`));
    expect(stored.drivePushedHash).toBe(
      await hashPushPayload("# Hi\n\n![pic](assets/notes/pic.png)", [{ path: "assets/notes/pic.png", dataUrl: `data:image/png;base64,${imageBase64}` }]),
    );
  });

  it("removes a local doc whose Drive file disappeared", async () => {
    linkedWorkspace();
    docsStore.set([doc({ id: "d1", driveFileId: "gone", drivePath: "gone.md", driveRev: "r1" })]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ folderId: "folder-1", folderName: "Notes", workspaceId: "w1", entries: [] })),
    );

    const { plan } = await pullFromDrive("w1");
    expect(plan.deletions).toHaveLength(1);
    expect(get(docsStore)).toHaveLength(0);
    // A deletion applied FROM Drive must not be queued for push-back.
    expect(get(workspacesStore)[0]!.pendingDriveDeletions).toEqual([]);
  });
});

describe("pushToDrive", () => {
  it("commits only successful per-file results", async () => {
    linkedWorkspace();
    const oldHash = await hashPushPayload("# old", []);
    docsStore.set([
      doc({ id: "d1", name: "one", driveFileId: "f1", drivePath: "one.md", driveRev: "r1", drivePushedHash: oldHash, content: "# new" }),
      doc({ id: "d2", name: "two", driveFileId: "f2", drivePath: "two.md", driveRev: "r1", drivePushedHash: oldHash, content: "# new" }),
    ]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const u = String(url);
        if (u.includes("/tree")) {
          return json({
            folderId: "folder-1",
            folderName: "Notes",
            workspaceId: "w1",
            entries: [
              { fileId: "f1", path: "one.md", mimeType: "text/markdown", rev: "r1" },
              { fileId: "f2", path: "two.md", mimeType: "text/markdown", rev: "r1" },
            ],
          });
        }
        if (u.includes("/push")) {
          return json({
            results: [
              { path: "one.md", op: "update", ok: true, fileId: "f1", rev: "r2" },
              { path: "two.md", op: "update", ok: false, fileId: "f2", error: "HTTP 500" },
            ],
            synced: 1,
            failed: 1,
          });
        }
        throw new Error(`unexpected fetch ${u}`);
      }),
    );

    const { result } = await pushToDrive("w1");
    expect(result).toMatchObject({ synced: 1, failed: 1 });
    const [one, two] = get(docsStore);
    expect(one).toMatchObject({ driveRev: "r2", drivePushedHash: await hashPushPayload("# new", []) });
    expect(two).toMatchObject({ driveRev: "r1", drivePushedHash: oldHash });
  });

  it("does not send a push when the plan has conflicts", async () => {
    linkedWorkspace();
    docsStore.set([
      doc({
        id: "d1",
        name: "one",
        driveFileId: "f1",
        drivePath: "one.md",
        driveRev: "r1",
        drivePushedHash: await hashPushPayload("# old", []),
        content: "# new",
      }),
    ]);
    const fetchMock = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes("/tree")) {
        return json({
          folderId: "folder-1",
          folderName: "Notes",
          workspaceId: "w1",
          entries: [{ fileId: "f1", path: "one.md", mimeType: "text/markdown", rev: "r2" }],
        });
      }
      throw new Error(`should not push: ${u}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { plan, result } = await pushToDrive("w1");
    expect(plan.conflicts).toHaveLength(1);
    expect(result).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws a reconnect error on 401", async () => {
    linkedWorkspace();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Reconnect", { status: 401 })),
    );
    await expect(pullFromDrive("w1")).rejects.toBeInstanceOf(DriveReconnectError);
  });
});
