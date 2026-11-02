import { describe, it, expect, vi, afterEach } from "vitest";
import { handleDrivePickerToken, handleDriveImport, handleDriveExport } from "../../src/google-drive";
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
