import { describe, it, expect, vi, afterEach } from "vitest";
import { handleDrivePickerToken, handleDriveImport } from "../../src/google-drive";
import { encryptJSON } from "../../src/auth";
import type { Env } from "../../src/env";

const env = {
  SESSION_SECRET: "test-secret-at-least-32-bytes-long!!",
  GOOGLE_CLIENT_ID: "gcid",
  GOOGLE_CLIENT_SECRET: "gcs",
  GOOGLE_API_KEY: "gak",
} as unknown as Env;

afterEach(() => vi.unstubAllGlobals());

async function connectedReq(url: string, init?: RequestInit) {
  const cookie = await encryptJSON(env, { refreshToken: "r", accessToken: "live-token", accessTokenExp: Date.now() + 3600_000 });
  return new Request(url, { ...init, headers: { ...(init?.headers ?? {}), Cookie: `mde_google_session=${cookie}` } });
}

describe("handleDrivePickerToken", () => {
  it("returns the live token + api key when connected", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const res = await handleDrivePickerToken(await connectedReq("https://app/api/auth/google/picker-token"), env);
    expect(await res.json()).toEqual({ token: "live-token", apiKey: "gak" });
  });
  it("401 when not connected", async () => {
    const res = await handleDrivePickerToken(new Request("https://app/api/auth/google/picker-token"), env);
    expect(res.status).toBe(401);
  });
  it("503 when GOOGLE_API_KEY is unset", async () => {
    const res = await handleDrivePickerToken(await connectedReq("https://app/api/auth/google/picker-token"), {
      ...env,
      GOOGLE_API_KEY: undefined,
    } as unknown as Env);
    expect(res.status).toBe(503);
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
    const body = (await res.json()) as { results: { fileId: string; name?: string; contentBase64?: string; ok: boolean }[] };
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
