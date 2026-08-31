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
});
