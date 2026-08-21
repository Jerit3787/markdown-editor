import { describe, it, expect } from "vitest";
import { nextAvailableName, ensureUniqueName } from "../../../client/src/doc-naming";
import type { Doc } from "../../../client/src/types";

describe("nextAvailableName", () => {
  it("returns the name unchanged when not taken", () => {
    expect(nextAvailableName("Notes", new Set())).toBe("Notes");
  });

  it("appends -2 on a single collision", () => {
    expect(nextAvailableName("Notes", new Set(["Notes"]))).toBe("Notes-2");
  });

  it("keeps incrementing past an already-taken suffix", () => {
    expect(nextAvailableName("Notes", new Set(["Notes", "Notes-2"]))).toBe("Notes-3");
  });
});

describe("ensureUniqueName", () => {
  const docs: Doc[] = [
    { id: "a", name: "Notes", content: "", updatedAt: 0, createdAt: 0, workspaceId: "ws1" },
    { id: "b", name: "Notes-2", content: "", updatedAt: 0, createdAt: 0, workspaceId: "ws1" },
  ];

  it("suffixes a colliding name", () => {
    expect(ensureUniqueName("Notes", docs)).toBe("Notes-3");
  });

  it("returns the name unchanged when excludeId is its own current holder", () => {
    expect(ensureUniqueName("Notes", docs, "a")).toBe("Notes");
  });

  it("excluding a doc frees up its own name for someone else to take", () => {
    // excludeId="b" removes "Notes-2" from the taken set, so "Notes"
    // (already held by doc "a") still collides but "Notes-2" is now free.
    expect(ensureUniqueName("Notes", docs, "b")).toBe("Notes-2");
  });
});
