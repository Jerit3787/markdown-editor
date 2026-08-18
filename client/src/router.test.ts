// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { parseDocIdFromPath, pushDocUrl, replaceToRoot } from "./router";

beforeEach(() => {
  history.replaceState(null, "", "/");
});

describe("parseDocIdFromPath", () => {
  it("extracts the doc id from a /d/<id> path", () => {
    expect(parseDocIdFromPath("/d/abc123")).toBe("abc123");
  });

  it("returns null for the root path", () => {
    expect(parseDocIdFromPath("/")).toBeNull();
  });

  it("returns null for a share link path", () => {
    expect(parseDocIdFromPath("/w/ws1/doc1/edit")).toBeNull();
  });

  it("returns null for a malformed /d/ path", () => {
    expect(parseDocIdFromPath("/d/")).toBeNull();
    expect(parseDocIdFromPath("/d/abc/extra")).toBeNull();
  });
});

describe("pushDocUrl", () => {
  it("pushes a new history entry with the doc's URL", () => {
    pushDocUrl("abc123");
    expect(location.pathname).toBe("/d/abc123");
  });

  it("does not push a redundant entry when already on that doc's URL", () => {
    history.pushState(null, "", "/d/abc123");
    const lengthBefore = history.length;
    pushDocUrl("abc123");
    expect(history.length).toBe(lengthBefore);
  });
});

describe("replaceToRoot", () => {
  it("replaces the current entry with /", () => {
    history.pushState(null, "", "/d/abc123");
    const lengthBefore = history.length;
    replaceToRoot();
    expect(location.pathname).toBe("/");
    expect(history.length).toBe(lengthBefore); // replace, not push — no new entry
  });

  it("does nothing when already at /", () => {
    const lengthBefore = history.length;
    replaceToRoot();
    expect(history.length).toBe(lengthBefore);
  });
});
