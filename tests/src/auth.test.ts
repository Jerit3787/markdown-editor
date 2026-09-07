import { describe, it, expect } from "vitest";
import { encryptJSON, decryptJSON } from "../../src/auth";
import type { Env } from "../../src/env";

const env = { SESSION_SECRET: "test-secret-at-least-32-bytes-long!!" } as unknown as Env;

describe("encryptJSON / decryptJSON", () => {
  it("round-trips an arbitrary object and stamps an exp", async () => {
    const token = await encryptJSON(env, { refreshToken: "r", accessToken: "a", accessTokenExp: 123 });
    const back = await decryptJSON<{ refreshToken: string; accessToken: string; accessTokenExp: number; exp?: number }>(env, token);
    expect(back).toMatchObject({ refreshToken: "r", accessToken: "a", accessTokenExp: 123 });
    expect(typeof back!.exp).toBe("number");
    expect(back!.exp).toBeGreaterThan(Date.now());
  });

  it("returns null for a tampered / malformed value", async () => {
    expect(await decryptJSON(env, "not.a.token")).toBeNull();
    expect(await decryptJSON(env, "")).toBeNull();
  });

  it("returns null once exp has passed", async () => {
    const token = await encryptJSON(env, { x: 1 }, -1000); // already expired
    expect(await decryptJSON<{ x: number; exp?: number }>(env, token)).toBeNull();
  });
});
