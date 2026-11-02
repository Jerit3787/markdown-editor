// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "fake-indexeddb/auto";
import { get } from "svelte/store";
import {
  linkWorkspaceToDrive,
  pullFromDrive,
  pushToDrive,
  DriveReconnectError,
  hashPushPayload,
  hashImageDataUrl,
  pullDriveRevisions,
  getDriveRevisionContent,
  fetchDriveRevisionImages,
} from "../../../client/src/drive-sync";
import { workspacesStore, activeWorkspaceIdStore } from "../../../client/src/stores/workspaces";
import { docsStore, activeIdStore, activeDocContent } from "../../../client/src/stores/docs";
import { getHistory, maybeSnapshotVersion } from "../../../client/src/history";
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

function setDocs(next: Doc[]): void {
  docsStore.set(next);
  activeIdStore.set(next[0]?.id ?? null);
  activeDocContent.set(next[0]?.content ?? "");
}

function linkedWorkspace() {
  workspacesStore.set([{ id: "w1", name: "Notes", createdAt: 0, updatedAt: 0, driveLink: { folderId: "folder-1", folderName: "Notes" } }]);
  activeWorkspaceIdStore.set("w1");
}

beforeEach(() => {
  localStorage.clear();
  workspacesStore.set([{ id: "w1", name: "Notes", createdAt: 0, updatedAt: 0 }]);
  activeWorkspaceIdStore.set("w1");
  setDocs([]);
  activeIdStore.set(null);
  activeDocContent.set("");
});

afterEach(() => vi.unstubAllGlobals());

describe("linkWorkspaceToDrive", () => {
  it("creates the folder, stores the link, and pushes every local doc", async () => {
    setDocs([doc({ id: "d1", name: "Notes", content: "# Hi" })]);
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

  it("waits for confirmation before removing a local doc whose Drive file disappeared", async () => {
    linkedWorkspace();
    setDocs([doc({ id: "d1", name: "Gone", driveFileId: "gone", drivePath: "gone.md", driveRev: "r1", drivePushedHash: await hashPushPayload("", []) })]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ folderId: "folder-1", folderName: "Notes", workspaceId: "w1", entries: [] })),
    );

    const { plan, applyResolved } = await pullFromDrive("w1");
    expect(plan.deletions).toHaveLength(1);
    // Nothing is deleted until the user confirms in the conflict modal.
    expect(get(docsStore)).toHaveLength(1);

    await applyResolved({});
    expect(get(docsStore)).toHaveLength(0);
    // A deletion applied FROM Drive must not be queued for push-back.
    expect(get(workspacesStore)[0]!.pendingDriveDeletions).toBeUndefined();
  });
});

describe("pushToDrive", () => {
  it("commits only successful per-file results", async () => {
    linkedWorkspace();
    const oldHash = await hashPushPayload("# old", []);
    setDocs([
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
    setDocs([
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

describe("pushToDrive partial image success", () => {
  it("records image revisions even when the markdown update fails", async () => {
    linkedWorkspace();
    const dataA = `data:image/png;base64,${Buffer.from("A").toString("base64")}`;
    const dataB = `data:image/png;base64,${Buffer.from("B").toString("base64")}`;
    const oldHash = await hashPushPayload("![pic](assets/one/img-1.png)", [{ path: "assets/one/img-1.png", dataUrl: dataA }]);
    setDocs([
      doc({
        id: "d1",
        name: "one",
        content: "![pic](img-1)",
        images: { "img-1": dataB },
        driveFileId: "f1",
        drivePath: "one.md",
        driveRev: "r1",
        drivePushedHash: oldHash,
        driveImageRevs: { "img-1": { fileId: "img1", rev: "ir1", hash: await hashImageDataUrl(dataA) } },
      }),
    ]);
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
              { fileId: "f1", path: "one.md", mimeType: "text/markdown", rev: "r1" },
              { fileId: "img1", path: "assets/one/img-1.png", mimeType: "image/png", rev: "ir1" },
            ],
          });
        }
        if (u.includes("/push")) {
          return json({
            results: [
              { path: "one.md", op: "update", ok: false, fileId: "f1", error: "HTTP 500" },
              { path: "assets/one/img-1.png", op: "update", ok: true, fileId: "img1", rev: "ir2" },
            ],
            synced: 1,
            failed: 1,
          });
        }
        throw new Error(`unexpected fetch ${u}`);
      }),
    );

    await pushToDrive("w1");
    const stored = get(docsStore)[0]!;
    expect(stored.driveRev).toBe("r1");
    expect(stored.drivePushedHash).toBe(oldHash);
    expect(stored.driveImageRevs?.["img-1"]).toMatchObject({ fileId: "img1", rev: "ir2" });
  });
});

describe("pullFromDrive safety", () => {
  it("flags a locally edited doc as a conflict instead of overwriting it", async () => {
    linkedWorkspace();
    setDocs([
      doc({
        id: "d1",
        name: "one",
        driveFileId: "f1",
        drivePath: "one.md",
        driveRev: "r1",
        drivePushedHash: await hashPushPayload("# old", []),
        content: "# local edit",
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
      throw new Error(`should not download: ${u}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { plan } = await pullFromDrive("w1");
    expect(plan.conflicts).toHaveLength(1);
    expect(get(docsStore)[0]!.content).toBe("# local edit");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("continues past one failed download and reports it", async () => {
    linkedWorkspace();
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
              { fileId: "bad", path: "bad.md", mimeType: "text/markdown", rev: "r1" },
              { fileId: "good", path: "good.md", mimeType: "text/markdown", rev: "r1" },
            ],
          });
        }
        if (u.includes("/file/bad")) return new Response("boom", { status: 500 });
        if (u.includes("/file/good")) return json({ contentBase64: b64("# Good") });
        throw new Error(`unexpected fetch ${u}`);
      }),
    );

    const { failures } = await pullFromDrive("w1");
    expect(failures).toEqual([{ path: "bad.md", error: "Couldn't download from Google Drive: HTTP 500" }]);
    expect(get(docsStore).map((entry) => entry.name)).toEqual(["good"]);
  });
});

describe("pushToDrive batching", () => {
  it("splits a workspace larger than the per-request cap into multiple pushes", async () => {
    linkedWorkspace();
    setDocs(Array.from({ length: 41 }, (_, i) => doc({ id: `d${i}`, name: `doc${i}`, content: `# ${i}` })));
    const pushes: any[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const u = String(url);
        if (u.includes("/tree")) {
          return json({ folderId: "folder-1", folderName: "Notes", workspaceId: "w1", entries: [] });
        }
        if (u.includes("/push")) {
          const body = JSON.parse(String(init!.body));
          pushes.push(body);
          return json({
            results: body.creates.map((create: any, i: number) => ({ path: create.path, op: "create", ok: true, fileId: `f-${create.path}`, rev: `r${i}` })),
            synced: body.creates.length,
            failed: 0,
          });
        }
        throw new Error(`unexpected fetch ${u}`);
      }),
    );

    const { result } = await pushToDrive("w1");
    expect(pushes).toHaveLength(2);
    expect(pushes[0]!.creates).toHaveLength(40);
    expect(pushes[1]!.creates).toHaveLength(1);
    expect(result).toMatchObject({ synced: 41, failed: 0 });
    expect(get(docsStore).every((entry) => !!entry.driveFileId)).toBe(true);
  });
});

describe("push conflict resolution", () => {
  it("sends the non-conflicting changes after the user resolves the conflict", async () => {
    linkedWorkspace();
    setDocs([
      doc({
        id: "d1",
        name: "one",
        driveFileId: "f1",
        drivePath: "one.md",
        driveRev: "r1",
        drivePushedHash: await hashPushPayload("# old", []),
        content: "# local",
      }),
      doc({ id: "d2", name: "two", content: "# new doc" }),
    ]);
    let pushCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const u = String(url);
        if (u.includes("/tree")) {
          return json({
            folderId: "folder-1",
            folderName: "Notes",
            workspaceId: "w1",
            entries: [{ fileId: "f1", path: "one.md", mimeType: "text/markdown", rev: "r2" }],
          });
        }
        if (u.includes("/push")) {
          pushCount++;
          const body = JSON.parse(String(init!.body));
          return json({
            results: [
              ...body.creates.map((create: any) => ({ path: create.path, op: "create", ok: true, fileId: `new-${create.path}`, rev: "r-new" })),
              ...body.updates.map((update: any) => ({ path: update.path, op: "update", ok: true, fileId: update.fileId, rev: "r-forced" })),
            ],
            synced: body.creates.length + body.updates.length,
            failed: 0,
          });
        }
        throw new Error(`unexpected fetch ${u}`);
      }),
    );

    const { plan, applyResolved } = await pushToDrive("w1");
    expect(plan.conflicts).toHaveLength(1);
    expect(pushCount).toBe(0);

    await applyResolved({ d1: "mine" });
    expect(pushCount).toBe(2);
    const two = get(docsStore).find((entry) => entry.id === "d2")!;
    expect(two.driveFileId).toBe("new-two.md");
  });
});

describe("remote renames", () => {
  it("pulls a Drive-side rename even when the revision did not change", async () => {
    linkedWorkspace();
    setDocs([
      doc({
        id: "d1",
        name: "notes",
        content: "# old",
        driveFileId: "f1",
        drivePath: "notes.md",
        driveRev: "r1",
        drivePushedHash: await hashPushPayload("# old", []),
      }),
    ]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const u = String(url);
        if (u.includes("/tree")) {
          return json({
            folderId: "folder-1",
            folderName: "Notes",
            workspaceId: "w1",
            entries: [{ fileId: "f1", path: "docs/renamed.md", mimeType: "text/markdown", rev: "r1" }],
          });
        }
        if (u.includes("/file/f1")) return json({ contentBase64: b64("# remote") });
        throw new Error(`unexpected fetch ${u}`);
      }),
    );

    const { plan } = await pullFromDrive("w1");
    expect(plan.updates).toHaveLength(1);
    const stored = get(docsStore)[0]!;
    expect(stored.drivePath).toBe("docs/renamed.md");
    expect(stored.name).toBe("renamed");
    expect(stored.content).toBe("# remote");
  });

  it("keeps a deliberately custom local name through a remote rename", async () => {
    linkedWorkspace();
    setDocs([
      doc({
        id: "d1",
        name: "My Notes",
        content: "# old",
        driveFileId: "f1",
        drivePath: "notes.md",
        driveRev: "r1",
        drivePushedHash: await hashPushPayload("# old", []),
      }),
    ]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const u = String(url);
        if (u.includes("/tree")) {
          return json({
            folderId: "folder-1",
            folderName: "Notes",
            workspaceId: "w1",
            entries: [{ fileId: "f1", path: "renamed.md", mimeType: "text/markdown", rev: "r1" }],
          });
        }
        if (u.includes("/file/f1")) return json({ contentBase64: b64("# remote") });
        throw new Error(`unexpected fetch ${u}`);
      }),
    );

    await pullFromDrive("w1");
    const stored = get(docsStore)[0]!;
    expect(stored.drivePath).toBe("renamed.md");
    expect(stored.name).toBe("My Notes");
  });
});

describe("pull guard rails", () => {
  it("does not recreate a file whose local deletion is queued for push", async () => {
    workspacesStore.set([
      { id: "w1", name: "Notes", createdAt: 0, updatedAt: 0, driveLink: { folderId: "folder-1", folderName: "Notes" }, pendingDriveDeletions: ["f1"] },
    ]);
    activeWorkspaceIdStore.set("w1");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json({
          folderId: "folder-1",
          folderName: "Notes",
          workspaceId: "w1",
          entries: [{ fileId: "f1", path: "notes.md", mimeType: "text/markdown", rev: "r1" }],
        }),
      ),
    );

    const { plan } = await pullFromDrive("w1");
    expect(plan.creates).toEqual([]);
    expect(get(docsStore)).toEqual([]);
  });

  it("does not overwrite the active editor when it changed while the pull was in flight", async () => {
    linkedWorkspace();
    setDocs([
      doc({
        id: "d1",
        name: "notes",
        content: "# start",
        driveFileId: "f1",
        drivePath: "notes.md",
        driveRev: "r1",
        drivePushedHash: await hashPushPayload("# start", []),
      }),
    ]);
    const fetchMock = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes("/tree")) {
        activeDocContent.set("# typed during pull");
        return json({
          folderId: "folder-1",
          folderName: "Notes",
          workspaceId: "w1",
          entries: [{ fileId: "f1", path: "notes.md", mimeType: "text/markdown", rev: "r2" }],
        });
      }
      throw new Error(`should not download: ${u}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { plan } = await pullFromDrive("w1");
    expect(plan.conflicts).toHaveLength(1);
    expect(get(docsStore)[0]!.content).toBe("# start");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("only reloads the editor when the active doc itself changed", async () => {
    linkedWorkspace();
    setDocs([
      doc({
        id: "d1",
        name: "one",
        content: "# old",
        driveFileId: "f1",
        drivePath: "one.md",
        driveRev: "r1",
        drivePushedHash: await hashPushPayload("# old", []),
      }),
      doc({
        id: "d2",
        name: "two",
        content: "# two",
        driveFileId: "f2",
        drivePath: "two.md",
        driveRev: "r1",
        drivePushedHash: await hashPushPayload("# two", []),
      }),
    ]);
    activeIdStore.set("d2");
    activeDocContent.set("# two");
    const reload = vi.fn();
    window.MDE = { reloadActiveDocFromStore: reload } as unknown as typeof window.MDE;
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
              { fileId: "f1", path: "one.md", mimeType: "text/markdown", rev: "r2" },
              { fileId: "f2", path: "two.md", mimeType: "text/markdown", rev: "r1" },
            ],
          });
        }
        if (u.includes("/file/f1")) return json({ contentBase64: b64("# new") });
        throw new Error(`unexpected fetch ${u}`);
      }),
    );

    await pullFromDrive("w1");
    expect(reload).not.toHaveBeenCalled();
    expect(get(docsStore).find((entry) => entry.id === "d1")!.content).toBe("# new");
  });
});

describe("truncated pull images", () => {
  it("reuses existing image bytes when a referenced asset was not scanned", async () => {
    linkedWorkspace();
    const dataUrl = `data:image/png;base64,${Buffer.from("A").toString("base64")}`;
    setDocs([
      doc({
        id: "d1",
        name: "notes",
        content: "![pic](pic.png)",
        images: { "pic.png": dataUrl },
        driveFileId: "f1",
        drivePath: "notes.md",
        driveRev: "r1",
        drivePushedHash: await hashPushPayload("![pic](assets/notes/pic.png)", [{ path: "assets/notes/pic.png", dataUrl }]),
        driveImageRevs: { "pic.png": { fileId: "img1", rev: "ir1", hash: await hashImageDataUrl(dataUrl) } },
      }),
    ]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const u = String(url);
        if (u.includes("/tree")) {
          return json({
            folderId: "folder-1",
            folderName: "Notes",
            workspaceId: "w1",
            truncated: true,
            entries: [{ fileId: "f1", path: "notes.md", mimeType: "text/markdown", rev: "r2" }],
          });
        }
        if (u.includes("/file/f1")) return json({ contentBase64: b64("![pic](assets/notes/pic.png)") });
        throw new Error(`unexpected fetch ${u}`);
      }),
    );

    const { plan } = await pullFromDrive("w1");
    expect(plan.updates).toHaveLength(1);
    const stored = get(docsStore)[0]!;
    expect(stored.content).toBe("![pic](pic.png)");
    expect(stored.images).toEqual({ "pic.png": dataUrl });
    expect(stored.driveImageRevs?.["pic.png"]).toMatchObject({ fileId: "img1", rev: "ir1" });
  });
});

describe("pull conflict failures", () => {
  it("rejects when a chosen 'take theirs' download fails", async () => {
    linkedWorkspace();
    setDocs([
      doc({
        id: "d1",
        name: "one",
        content: "# local",
        driveFileId: "f1",
        drivePath: "one.md",
        driveRev: "r1",
        drivePushedHash: await hashPushPayload("# old", []),
      }),
    ]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const u = String(url);
        if (u.includes("/tree")) {
          return json({
            folderId: "folder-1",
            folderName: "Notes",
            workspaceId: "w1",
            entries: [{ fileId: "f1", path: "one.md", mimeType: "text/markdown", rev: "r2" }],
          });
        }
        if (u.includes("/file/f1")) return new Response("boom", { status: 500 });
        throw new Error(`unexpected fetch ${u}`);
      }),
    );

    const { plan, applyResolved } = await pullFromDrive("w1");
    expect(plan.conflicts).toHaveLength(1);
    await expect(applyResolved({ d1: "theirs" })).rejects.toThrow(/couldn't be pulled/);
    expect(get(docsStore)[0]!.content).toBe("# local");
  });
});

describe("Drive revision helpers", () => {
  it("maps the revisions endpoint and decodes revision content", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const u = String(url);
        if (u.endsWith("/revisions")) {
          return json({ revisions: [{ revId: "rev-2", modifiedTime: "2026-02-02T00:00:00Z", author: "Alice" }] });
        }
        if (u.includes("/revisions/rev-2")) return json({ contentBase64: b64("# Old") });
        throw new Error(`unexpected fetch ${u}`);
      }),
    );

    await expect(pullDriveRevisions("f1")).resolves.toEqual([{ revId: "rev-2", modifiedTime: "2026-02-02T00:00:00Z", author: "Alice" }]);
    await expect(getDriveRevisionContent("f1", "rev-2")).resolves.toBe("# Old");
  });

  it("resolves a revision's asset paths through the doc's image revisions", async () => {
    const imageBase64 = Buffer.from("PNG").toString("base64");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("/file/img1")) return json({ contentBase64: imageBase64 });
        throw new Error(`unexpected fetch ${String(url)}`);
      }),
    );
    const doc = {
      id: "d1",
      name: "notes",
      content: "",
      updatedAt: 0,
      createdAt: 0,
      workspaceId: "w1",
      drivePath: "notes.md",
      driveImageRevs: { "pic.png": { fileId: "img1", rev: "ir1" } },
    } as unknown as Doc;
    const images = await fetchDriveRevisionImages(doc, "![pic](assets/notes/pic.png)");
    expect(images).toEqual({ "assets/notes/pic.png": `data:image/png;base64,${imageBase64}` });
  });

  it("surfaces a 401 as a reconnect error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("unauthorized", { status: 401 })),
    );
    await expect(pullDriveRevisions("f1")).rejects.toBeInstanceOf(DriveReconnectError);
  });
});

describe("Drive folder-backed history", () => {
  it("pushes the companion history JSON in its own request", async () => {
    linkedWorkspace();
    setDocs([doc({ id: "d1", name: "Notes", content: "# Hi" })]);
    await maybeSnapshotVersion("d1", "# Hi", 1_700_000_000_000);
    const pushes: any[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const u = String(url);
        if (u.includes("/tree")) return json({ folderId: "folder-1", folderName: "Notes", workspaceId: "w1", entries: [] });
        if (u.includes("/push")) {
          const body = JSON.parse(String(init!.body));
          pushes.push(body);
          return json({
            results: body.creates.map((create: any) => ({ path: create.path, op: "create", ok: true, fileId: `f-${create.path}`, rev: "r1" })),
            synced: body.creates.length,
            failed: 0,
          });
        }
        throw new Error(`unexpected fetch ${u}`);
      }),
    );

    await pushToDrive("w1");
    const historyBody = pushes.find((body) => body.creates.some((create: any) => create.path.startsWith(".mde/history/")));
    expect(historyBody).toBeTruthy();
    expect(historyBody.ensureSubfolders).toContain(".mde/history");
    const historyCreate = historyBody.creates.find((create: any) => create.path.startsWith(".mde/history/"));
    const parsed = JSON.parse(Buffer.from(historyCreate.contentBase64, "base64").toString("utf-8"));
    expect(parsed.snapshots[0]).toMatchObject({ id: expect.any(String), content: "# Hi" });
  });

  it("pulls and merges history snapshots and notes by id", async () => {
    linkedWorkspace();
    const remoteHistory = JSON.stringify({
      snapshots: [{ id: "s-remote", timestamp: 1_700_000_000_000, content: "# old" }],
      notes: [{ id: "n1", from: 0, to: 5, quote: "# old", orphaned: false, body: "note from another device", createdAt: 1 }],
    });
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
              { fileId: "h1", path: ".mde/history/notes.json", mimeType: "application/json", rev: "r1" },
            ],
          });
        }
        if (u.includes("/file/f1")) return json({ contentBase64: b64("# new") });
        if (u.includes("/file/h1")) return json({ contentBase64: b64(remoteHistory) });
        throw new Error(`unexpected fetch ${u}`);
      }),
    );

    const { failures } = await pullFromDrive("w1");
    expect(failures).toEqual([]);
    const stored = get(docsStore)[0]!;
    const snapshots = await getHistory(stored.id);
    expect(snapshots).toEqual([expect.objectContaining({ id: "s-remote", content: "# old" })]);
    expect(stored.notes).toEqual([expect.objectContaining({ id: "n1", body: "note from another device" })]);
  });

  it("continues past a corrupt history file", async () => {
    linkedWorkspace();
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
              { fileId: "h1", path: ".mde/history/notes.json", mimeType: "application/json", rev: "r1" },
            ],
          });
        }
        if (u.includes("/file/f1")) return json({ contentBase64: b64("# new") });
        if (u.includes("/file/h1")) return json({ contentBase64: b64("not json") });
        throw new Error(`unexpected fetch ${u}`);
      }),
    );

    const { failures } = await pullFromDrive("w1");
    expect(failures).toEqual([expect.objectContaining({ path: ".mde/history/notes.json" })]);
    expect(get(docsStore)[0]!.content).toBe("# new");
  });

  it("deletes a pending history file and clears the queue", async () => {
    workspacesStore.set([
      {
        id: "w1",
        name: "Notes",
        createdAt: 0,
        updatedAt: 0,
        driveLink: { folderId: "folder-1", folderName: "Notes" },
        pendingDriveHistoryDeletions: [".mde/history/gone.json"],
      },
    ]);
    activeWorkspaceIdStore.set("w1");
    let pushBody: any;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const u = String(url);
        if (u.includes("/tree")) {
          return json({
            folderId: "folder-1",
            folderName: "Notes",
            workspaceId: "w1",
            entries: [{ fileId: "h1", path: ".mde/history/gone.json", mimeType: "application/json", rev: "r1" }],
          });
        }
        if (u.includes("/push")) {
          pushBody = JSON.parse(String(init!.body));
          return json({ results: [{ path: "h1", op: "delete", ok: true, fileId: "h1" }], synced: 1, failed: 0 });
        }
        throw new Error(`unexpected fetch ${u}`);
      }),
    );

    await pushToDrive("w1");
    expect(pushBody.deletes).toEqual(["h1"]);
    expect(get(workspacesStore)[0]!.pendingDriveHistoryDeletions).toBeUndefined();
  });
});
