// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { get } from "svelte/store";

describe("findReplace store", () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="body"></div>';
    vi.resetModules();
  });

  it("opens in find mode", async () => {
    const { findBarOpen, findBarMode, openFindBar } = await import("../../../../client/src/stores/findReplace");
    openFindBar("find");
    expect(get(findBarOpen)).toBe(true);
    expect(get(findBarMode)).toBe("find");
  });

  it("opens in replace mode", async () => {
    const { findBarMode, openFindBar } = await import("../../../../client/src/stores/findReplace");
    openFindBar("replace");
    expect(get(findBarMode)).toBe("replace");
  });

  it("switches out of preview-only view mode so the bar is visible", async () => {
    const { openFindBar } = await import("../../../../client/src/stores/findReplace");
    const { viewMode, setView } = await import("../../../../client/src/stores/view");
    setView("preview");
    openFindBar("find");
    expect(get(viewMode)).toBe("split");
  });

  it("leaves an already-visible view mode alone", async () => {
    const { openFindBar } = await import("../../../../client/src/stores/findReplace");
    const { viewMode, setView } = await import("../../../../client/src/stores/view");
    setView("editor");
    openFindBar("find");
    expect(get(viewMode)).toBe("editor");
  });

  it("closeFindBar hides the bar", async () => {
    const { findBarOpen, openFindBar, closeFindBar } = await import("../../../../client/src/stores/findReplace");
    openFindBar("find");
    closeFindBar();
    expect(get(findBarOpen)).toBe(false);
  });
});
