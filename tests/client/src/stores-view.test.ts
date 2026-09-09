// @vitest-environment jsdom
// stores/view.ts touches document.getElementById("body") as a top-level
// module-load side effect (mirrors app.ts's old initViewToggle) — the
// #body element must exist BEFORE the module is first imported, which a
// static import at the top of this file can't guarantee (imports are
// hoisted and evaluate before any of this file's own top-level code
// runs). Dynamically importing after setting up the DOM avoids that.
import { describe, it, expect, beforeEach } from "vitest";
import { get } from "svelte/store";

document.body.innerHTML = '<div id="body"></div>';
const { viewMode, viewModeLocked, setView, lockToPreviewOnly, unlockViewMode } = await import("../../../client/src/stores/view");

describe("viewModeLocked", () => {
  beforeEach(() => {
    unlockViewMode();
  });

  it("forces preview mode and flags the lock", () => {
    setView("split");
    lockToPreviewOnly();
    expect(get(viewMode)).toBe("preview");
    expect(get(viewModeLocked)).toBe(true);
  });

  it("setView is a no-op while locked", () => {
    lockToPreviewOnly();
    setView("split");
    expect(get(viewMode)).toBe("preview");
  });

  it("unlocking allows setView again", () => {
    lockToPreviewOnly();
    unlockViewMode();
    setView("split");
    expect(get(viewMode)).toBe("split");
  });

  it("unlock restores the mode that was active before the lock", () => {
    setView("split");
    lockToPreviewOnly();
    expect(get(viewMode)).toBe("preview");
    unlockViewMode();
    expect(get(viewMode)).toBe("split");
  });

  it("a viewer that locks and never unlocks stays in preview", () => {
    setView("split");
    lockToPreviewOnly();
    expect(get(viewMode)).toBe("preview");
    // no unlockViewMode() — this is the real-viewer path
    expect(get(viewMode)).toBe("preview");
  });

  it("a redundant second lock keeps the original stashed mode", () => {
    setView("editor");
    lockToPreviewOnly();
    lockToPreviewOnly(); // e.g. handleDocChanged re-locking after the pessimistic lock
    unlockViewMode();
    expect(get(viewMode)).toBe("editor");
  });

  it("unlock with no prior lock does not change the mode", () => {
    setView("split");
    unlockViewMode();
    expect(get(viewMode)).toBe("split");
  });
});
