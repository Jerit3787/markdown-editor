import { describe, it, expect, vi, afterEach } from "vitest";
import {
  handleDrivePickerToken,
  handleDriveImport,
  handleDriveExport,
  handleDriveCreateFolder,
  handleDriveListFolders,
  handleDriveTree,
  handleDriveFile,
  handleDrivePush,
} from "../../src/google-drive";
import { encryptJSON } from "../../src/auth";
import type { Env } from "../../src/env";

const env = {
  SESSION_SECRET: "test-secret-key-not-real",
  GOOGLE_CLIENT_ID: "111222333444-abcdef.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "gcs",
  GOOGLE_API_KEY: "gak",
} as unknown as Env;

afterEach(() => vi.unstubAllGlobals());

async function connectedReq(url: string, init?: RequestInit) {
  const cookie = await encryptJSON(env, { refreshToken: "r", accessToken: "live-token", accessTokenExp: Date.now() + 3600_000 });
  return new Request(url, { ...init, headers: { ...(init?.headers ?? {}), Cookie: `mde_google_session=${cookie}` } });
}

describe("handleDrivePickerToken", () => {
  it("returns the live token, api key, and the project-number appId when connected", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const res = await handleDrivePickerToken(await connectedReq("https://app/api/auth/google/picker-token"), env);
    expect(await res.json()).toEqual({ token: "live-token", apiKey: "gak", appId: "111222333444" });
  });
  it("401 when not connected", async () => {
    const res = await handleDrivePickerToken(new Request("https://app/api/auth/google/picker-token"), env);
    expect(res.status).toBe(401);
  });
});

describe("handleDriveImport", () => {
  it("downloads each picked file, best-effort, 200 with per-file status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const u = String(url);
        if (u.includes("/files/ok1?") && u.includes("alt=media")) return new Response("# Hello", { status: 200 });
        if (u.includes("/files/ok1?")) return Response.json({ name: "notes.md", mimeType: "text/markdown" });
        if (u.includes("/files/bad2?")) return new Response("Not Found", { status: 404 });
        return new Response("?", { status: 500 });
      }),
    );
    const req = await connectedReq("https://app/api/drive/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileIds: ["ok1", "bad2"] }),
    });
    const res = await handleDriveImport(req, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: Array<{ fileId: string; name?: string; contentBase64?: string; ok: boolean }> };
    expect(body.results).toHaveLength(2);
    expect(body.results[0]).toMatchObject({ fileId: "ok1", name: "notes.md", ok: true });
    expect(Buffer.from(body.results[0]!.contentBase64!, "base64").toString()).toBe("# Hello");
    expect(body.results[1]).toMatchObject({ fileId: "bad2", ok: false });
  });
  it("401 when not connected", async () => {
    const res = await handleDriveImport(new Request("https://app/api/drive/import", { method: "POST", body: JSON.stringify({ fileIds: ["x"] }) }), env);
    expect(res.status).toBe(401);
  });
});

describe("handleDriveImport — resource caps", () => {
  it("caps the number of files per request", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes("alt=media")) return new Response("# ok", { status: 200 });
      return Response.json({ name: "n.md", mimeType: "text/markdown" });
    });
    vi.stubGlobal("fetch", fetchMock);
    const fileIds = Array.from({ length: 25 }, (_, i) => `f${i}`);
    const req = await connectedReq("https://app/api/drive/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileIds }),
    });
    const res = await handleDriveImport(req, env);
    const body = (await res.json()) as { results: unknown[] };
    expect(body.results).toHaveLength(20);
    // 20 files × (meta + content) — not 25.
    expect(fetchMock).toHaveBeenCalledTimes(40);
  });

  it("rejects a file whose declared size exceeds the per-file cap", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const u = String(url);
        if (u.includes("alt=media")) return new Response("x", { status: 200, headers: { "Content-Length": String(50 * 1024 * 1024) } });
        return Response.json({ name: "huge.md", mimeType: "text/markdown" });
      }),
    );
    const req = await connectedReq("https://app/api/drive/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileIds: ["big1"] }),
    });
    const res = await handleDriveImport(req, env);
    const body = (await res.json()) as { results: Array<{ ok: boolean; error?: string }> };
    expect(body.results[0]).toMatchObject({ ok: false });
    expect(body.results[0]!.error).toMatch(/large/i);
  });
});

describe("handleDriveExport — save markdown to Drive", () => {
  const exportBody = (overrides: Record<string, unknown> = {}) => JSON.stringify({ name: "notes.md", contentBase64: btoa("# Hello"), ...overrides });

  it("creates a new file with a multipart upload when no fileId is given", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        return Response.json({ id: "new-file", name: "notes.md", webViewLink: "https://drive.google.com/file/d/new-file/view" });
      }),
    );
    const req = await connectedReq("https://app/api/drive/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: exportBody({ parentFolderId: "folder-1" }),
    });

    const res = await handleDriveExport(req, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      fileId: "new-file",
      name: "notes.md",
      webViewLink: "https://drive.google.com/file/d/new-file/view",
    });

    const call = calls[0]!;
    expect(call.url).toContain("/upload/drive/v3/files");
    expect(call.url).toContain("uploadType=multipart");
    expect(call.init?.method).toBe("POST");
    expect(String((call.init?.headers as Record<string, string>)["Content-Type"])).toMatch(/^multipart\/related; boundary=/);
    const bodyText = await (call.init!.body as Blob).text();
    expect(bodyText).toContain('"name":"notes.md"');
    expect(bodyText).toContain('"parents":["folder-1"]');
    expect(bodyText).toContain("# Hello");
  });

  it("updates an existing file with a media PATCH", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        return Response.json({ id: "file-1", name: "notes.md", webViewLink: "https://drive.google.com/file/d/file-1/view" });
      }),
    );
    const req = await connectedReq("https://app/api/drive/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: exportBody({ fileId: "file-1" }),
    });

    const res = await handleDriveExport(req, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ fileId: "file-1" });

    const call = calls[0]!;
    expect(call.url).toContain("/upload/drive/v3/files/file-1");
    expect(call.url).toContain("uploadType=media");
    expect(call.init?.method).toBe("PATCH");
  });

  it("returns 404 not-found when the stored file was deleted in Drive", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not found", { status: 404 })),
    );
    const req = await connectedReq("https://app/api/drive/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: exportBody({ fileId: "gone" }),
    });

    const res = await handleDriveExport(req, env);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not-found" });
  });

  it("rejects an oversized payload before uploading", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const req = await connectedReq("https://app/api/drive/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "big.md", contentBase64: "A".repeat(7 * 1024 * 1024) }),
    });

    const res = await handleDriveExport(req, env);
    expect(res.status).toBe(413);
  });
});

describe("handleDriveCreateFolder", () => {
  it("creates an app-owned folder with the workspace marker appProperties", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        return Response.json({ id: "folder-1", name: "Notes" });
      }),
    );
    const req = await connectedReq("https://app/api/drive/folder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: "w1", workspaceName: "My Notes", folderName: "Notes" }),
    });
    const res = await handleDriveCreateFolder(req, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ folderId: "folder-1", folderName: "Notes" });

    const call = calls[0]!;
    expect(call.url).toContain("/drive/v3/files");
    expect(call.url).toContain("fields=id,name");
    expect(call.init?.method).toBe("POST");
    const body = JSON.parse(String(call.init?.body)) as { name: string; mimeType: string; appProperties: Record<string, string> };
    expect(body.name).toBe("Notes");
    expect(body.mimeType).toBe("application/vnd.google-apps.folder");
    expect(body.appProperties).toEqual({ mde: "1", mdeWorkspace: "w1", mdeWorkspaceName: "My Notes" });
  });

  it("401 when not connected", async () => {
    const res = await handleDriveCreateFolder(new Request("https://app/api/drive/folder", { method: "POST" }), env);
    expect(res.status).toBe(401);
  });
});

describe("handleDriveListFolders", () => {
  it("lists only app folders and maps appProperties to workspaceId", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const u = String(url);
        expect(u).toContain("appProperties%20has%20%7B%20key%3D'mde'");
        return Response.json({
          files: [
            { id: "f1", name: "Notes", appProperties: { mde: "1", mdeWorkspace: "w1" }, modifiedTime: "2026-01-01T00:00:00Z" },
            { id: "f2", name: "Other", appProperties: { mde: "1" }, modifiedTime: "2026-01-02T00:00:00Z" },
          ],
        });
      }),
    );
    const res = await handleDriveListFolders(await connectedReq("https://app/api/drive/folders"), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      folders: [
        { folderId: "f1", folderName: "Notes", workspaceId: "w1", modifiedTime: "2026-01-01T00:00:00Z" },
        { folderId: "f2", folderName: "Other", workspaceId: null, modifiedTime: "2026-01-02T00:00:00Z" },
      ],
    });
  });

  it("401 when not connected", async () => {
    const res = await handleDriveListFolders(new Request("https://app/api/drive/folders"), env);
    expect(res.status).toBe(401);
  });
});

describe("handleDriveTree", () => {
  it("walks subfolders and flattens synthetic paths, falling back to modifiedTime", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const u = String(url);
        const q = new URL(u).searchParams.get("q") ?? "";
        if (u.includes("/files/folder-1?") && !q) {
          return Response.json({ id: "folder-1", name: "Notes", appProperties: { mdeWorkspace: "w1" } });
        }
        if (q.includes("'folder-1' in parents")) {
          return Response.json({
            files: [
              { id: "doc-1", name: "notes.md", mimeType: "text/markdown", headRevisionId: "rev-1" },
              { id: "docs-folder", name: "docs", mimeType: "application/vnd.google-apps.folder" },
              { id: "assets-folder", name: "assets", mimeType: "application/vnd.google-apps.folder" },
            ],
          });
        }
        if (q.includes("'docs-folder' in parents")) {
          return Response.json({ files: [{ id: "doc-2", name: "nested.md", mimeType: "text/markdown", headRevisionId: "rev-2" }] });
        }
        if (q.includes("'assets-folder' in parents")) {
          return Response.json({ files: [{ id: "img-1", name: "pic.png", mimeType: "image/png", modifiedTime: "2026-02-03T00:00:00Z" }] });
        }
        return Response.json({ files: [] });
      }),
    );
    const res = await handleDriveTree(await connectedReq("https://app/api/drive/folder/folder-1/tree"), env, "folder-1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      folderId: string;
      folderName: string;
      workspaceId: string | null;
      entries: { fileId: string; path: string; mimeType: string; rev: string }[];
    };
    expect(body.folderId).toBe("folder-1");
    expect(body.folderName).toBe("Notes");
    expect(body.workspaceId).toBe("w1");
    expect(body.entries).toEqual(
      expect.arrayContaining([
        { fileId: "doc-1", path: "notes.md", mimeType: "text/markdown", rev: "rev-1" },
        { fileId: "doc-2", path: "docs/nested.md", mimeType: "text/markdown", rev: "rev-2" },
        { fileId: "img-1", path: "assets/pic.png", mimeType: "image/png", rev: "2026-02-03T00:00:00Z" },
      ]),
    );
    expect(body.entries).toHaveLength(3);
  });

  it("404 when the folder is gone", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not found", { status: 404 })),
    );
    const res = await handleDriveTree(await connectedReq("https://app/api/drive/folder/gone/tree"), env, "gone");
    expect(res.status).toBe(404);
  });

  it("401 when not connected", async () => {
    const res = await handleDriveTree(new Request("https://app/api/drive/folder/f/tree"), env, "f");
    expect(res.status).toBe(401);
  });
});

describe("handleDriveFile", () => {
  it("downloads a file as base64", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("# Hello")),
    );
    const res = await handleDriveFile(await connectedReq("https://app/api/drive/file/f1"), env, "f1");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ contentBase64: Buffer.from("# Hello").toString("base64") });
  });

  it("rejects a file above the 5 MB cap", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("x", { status: 200, headers: { "Content-Length": String(6 * 1024 * 1024) } })),
    );
    const res = await handleDriveFile(await connectedReq("https://app/api/drive/file/big"), env, "big");
    expect(res.status).toBe(413);
  });

  it("401 when not connected", async () => {
    const res = await handleDriveFile(new Request("https://app/api/drive/file/f1"), env, "f1");
    expect(res.status).toBe(401);
  });
});

describe("handleDrivePush", () => {
  function pushReq(body: unknown) {
    return connectedReq("https://app/api/drive/folder/folder-1/push", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("ensures subfolders, creates, updates, and deletes; returns per-item revisions", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const u = String(url);
        calls.push({ url: u, init });
        if (u.includes("/upload/drive/v3/files") && u.includes("uploadType=multipart")) {
          return Response.json({ id: "new-doc", name: "notes.md", headRevisionId: "rev-doc", modifiedTime: "t" });
        }
        if (u.includes("/upload/drive/v3/files/img-1")) {
          return Response.json({ id: "img-1", headRevisionId: "rev-img", modifiedTime: "t" });
        }
        if (u.includes("/drive/v3/files/gone") && init?.method === "DELETE") {
          return new Response(null, { status: 204 });
        }
        if (u.includes("/drive/v3/files?") && init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as { name: string };
          return Response.json({ id: body.name === "assets" ? "assets-id" : "notes-id", name: body.name });
        }
        const q = new URL(u).searchParams.get("q") ?? "";
        if (q.includes("name = 'assets'")) return Response.json({ files: [] });
        if (q.includes("name = 'notes'")) return Response.json({ files: [] });
        if (q.includes("'assets-id' in parents")) return Response.json({ files: [] });
        return Response.json({ files: [] });
      }),
    );

    const res = await handleDrivePush(
      await pushReq({
        ensureSubfolders: ["assets/notes"],
        creates: [{ path: "notes.md", mimeType: "text/markdown", contentBase64: Buffer.from("# Hi").toString("base64") }],
        updates: [{ fileId: "img-1", path: "assets/notes/pic.png", contentBase64: Buffer.from("img").toString("base64") }],
        deletes: ["gone"],
      }),
      env,
      "folder-1",
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      results: { path: string; op: string; ok: boolean; fileId?: string; rev?: string }[];
      synced: number;
      failed: number;
    };
    expect(body.synced).toBe(3);
    expect(body.failed).toBe(0);
    expect(body.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "notes.md", op: "create", ok: true, fileId: "new-doc", rev: "rev-doc" }),
        expect.objectContaining({ path: "assets/notes/pic.png", op: "update", ok: true, fileId: "img-1", rev: "rev-img" }),
        expect.objectContaining({ path: "gone", op: "delete", ok: true, fileId: "gone" }),
      ]),
    );

    const multipart = calls.find((c) => c.url.includes("uploadType=multipart"))!;
    const bodyText = await (multipart.init!.body as Blob).text();
    expect(bodyText).toContain('"name":"notes.md"');
    expect(bodyText).toContain('"parents":["folder-1"]');
    expect(bodyText).toContain('"mimeType":"text/markdown"');
    expect(bodyText).toContain("# Hi");
  });

  it("is best-effort: one failed update still returns 200 and the other items' results", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const u = String(url);
        if (u.includes("/upload/drive/v3/files/ok-1")) return Response.json({ id: "ok-1", headRevisionId: "r1" });
        if (u.includes("/upload/drive/v3/files/bad-2")) return new Response("boom", { status: 500 });
        if (u.includes("/upload/drive/v3/files/ok-3")) return Response.json({ id: "ok-3", headRevisionId: "r3" });
        return Response.json({ files: [] });
      }),
    );
    const res = await handleDrivePush(
      await pushReq({
        ensureSubfolders: [],
        creates: [],
        updates: [
          { fileId: "ok-1", path: "a.md", contentBase64: "YQ==" },
          { fileId: "bad-2", path: "b.md", contentBase64: "Yg==" },
          { fileId: "ok-3", path: "c.md", contentBase64: "Yw==" },
        ],
        deletes: [],
      }),
      env,
      "folder-1",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: { fileId?: string; ok: boolean; error?: string }[]; synced: number; failed: number };
    expect(body.results.map((r) => r.ok)).toEqual([true, false, true]);
    expect(body.results[1]!.error).toMatch(/HTTP 500/);
    expect(body.synced).toBe(2);
    expect(body.failed).toBe(1);
  });

  it("rejects an oversized push batch before any Drive call", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const updates = Array.from({ length: 41 }, (_, i) => ({ fileId: `f${i}`, path: `${i}.md`, contentBase64: "YQ==" }));
    const res = await handleDrivePush(await pushReq({ ensureSubfolders: [], creates: [], updates, deletes: [] }), env, "folder-1");
    expect(res.status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("401 when not connected", async () => {
    const res = await handleDrivePush(new Request("https://app/api/drive/folder/f/push", { method: "POST" }), env, "f");
    expect(res.status).toBe(401);
  });
});

describe("upstream 401 handling", () => {
  it("folder create/list/file/tree/push all surface a dead Google token as 401", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("unauthorized", { status: 401 })),
    );
    const create = await handleDriveCreateFolder(
      await connectedReq("https://app/api/drive/folder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId: "w1", workspaceName: "WS", folderName: "Notes" }),
      }),
      env,
    );
    expect(create.status).toBe(401);
    expect((await handleDriveListFolders(await connectedReq("https://app/api/drive/folders"), env)).status).toBe(401);
    expect((await handleDriveFile(await connectedReq("https://app/api/drive/file/f1"), env, "f1")).status).toBe(401);
    expect((await handleDriveTree(await connectedReq("https://app/api/drive/folder/f1/tree"), env, "f1")).status).toBe(401);
    const push = await handleDrivePush(
      await connectedReq("https://app/api/drive/folder/f1/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ensureSubfolders: [], creates: [], updates: [{ fileId: "x", path: "x.md", contentBase64: "YQ==" }], deletes: [] }),
      }),
      env,
      "f1",
    );
    expect(push.status).toBe(401);

    const pushWithSubfolder = await handleDrivePush(
      await connectedReq("https://app/api/drive/folder/f1/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ensureSubfolders: ["assets/notes"],
          creates: [{ path: "assets/notes/pic.png", mimeType: "image/png", contentBase64: "YQ==" }],
          updates: [],
          deletes: [],
        }),
      }),
      env,
      "f1",
    );
    expect(pushWithSubfolder.status).toBe(401);
  });
});

describe("handleDriveTree pagination", () => {
  it("follows nextPageToken instead of silently dropping later files", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const parsed = new URL(String(url));
        const q = parsed.searchParams.get("q") ?? "";
        if (String(url).includes("/files/folder-1?") && !q) {
          return Response.json({ id: "folder-1", name: "Notes", appProperties: { mdeWorkspace: "w1" } });
        }
        if (parsed.searchParams.get("pageToken") === "page-2") {
          return Response.json({ files: [{ id: "doc-2", name: "two.md", mimeType: "text/markdown", headRevisionId: "r2" }] });
        }
        return Response.json({
          files: [{ id: "doc-1", name: "one.md", mimeType: "text/markdown", headRevisionId: "r1" }],
          nextPageToken: "page-2",
        });
      }),
    );
    const res = await handleDriveTree(await connectedReq("https://app/api/drive/folder/folder-1/tree"), env, "folder-1");
    const body = (await res.json()) as { entries: { path: string }[]; truncated: boolean };
    expect(body.entries.map((entry) => entry.path)).toEqual(["one.md", "two.md"]);
    expect(body.truncated).toBe(false);
  });
});
