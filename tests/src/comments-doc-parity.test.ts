import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";

// client/src/comments-doc.ts and src/comments-doc.ts are hand-synced
// byte-identical copies — the same discipline suggestions.ts / anchor.ts
// rely on, but with an automated guard for this pair.
describe("comments-doc hand-sync", () => {
  it("client/src/comments-doc.ts and src/comments-doc.ts are byte-identical", () => {
    const client = readFileSync(fileURLToPath(new URL("../../client/src/comments-doc.ts", import.meta.url)), "utf8");
    const server = readFileSync(fileURLToPath(new URL("../../src/comments-doc.ts", import.meta.url)), "utf8");
    expect(client).toBe(server);
  });
});
