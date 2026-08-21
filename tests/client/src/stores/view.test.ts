// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { get } from "svelte/store";

describe("isEditorOn / isPreviewOn", () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="body"></div>';
    vi.resetModules();
  });

  it("editor mode: editor on, preview off", async () => {
    const { isEditorOn, isPreviewOn } = await import("../../../../client/src/stores/view");
    expect(isEditorOn("editor")).toBe(true);
    expect(isPreviewOn("editor")).toBe(false);
  });

  it("preview mode: editor off, preview on", async () => {
    const { isEditorOn, isPreviewOn } = await import("../../../../client/src/stores/view");
    expect(isEditorOn("preview")).toBe(false);
    expect(isPreviewOn("preview")).toBe(true);
  });

  it("split mode: both on", async () => {
    const { isEditorOn, isPreviewOn } = await import("../../../../client/src/stores/view");
    expect(isEditorOn("split")).toBe(true);
    expect(isPreviewOn("split")).toBe(true);
  });
});

describe("toggleEditorPane / togglePreviewPane", () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="body"></div>';
    vi.resetModules();
  });

  it("toggleEditorPane from split turns editor off (-> preview)", async () => {
    const { viewMode, toggleEditorPane } = await import("../../../../client/src/stores/view");
    viewMode.set("split");
    toggleEditorPane();
    expect(get(viewMode)).toBe("preview");
  });

  it("toggleEditorPane from preview turns editor on (-> split)", async () => {
    const { viewMode, toggleEditorPane } = await import("../../../../client/src/stores/view");
    viewMode.set("preview");
    toggleEditorPane();
    expect(get(viewMode)).toBe("split");
  });

  it("toggleEditorPane from editor is a no-op (editor is the only pane on)", async () => {
    const { viewMode, toggleEditorPane } = await import("../../../../client/src/stores/view");
    viewMode.set("editor");
    toggleEditorPane();
    expect(get(viewMode)).toBe("editor");
  });

  it("togglePreviewPane from split turns preview off (-> editor)", async () => {
    const { viewMode, togglePreviewPane } = await import("../../../../client/src/stores/view");
    viewMode.set("split");
    togglePreviewPane();
    expect(get(viewMode)).toBe("editor");
  });

  it("togglePreviewPane from editor turns preview on (-> split)", async () => {
    const { viewMode, togglePreviewPane } = await import("../../../../client/src/stores/view");
    viewMode.set("editor");
    togglePreviewPane();
    expect(get(viewMode)).toBe("split");
  });

  it("togglePreviewPane from preview is a no-op (preview is the only pane on)", async () => {
    const { viewMode, togglePreviewPane } = await import("../../../../client/src/stores/view");
    viewMode.set("preview");
    togglePreviewPane();
    expect(get(viewMode)).toBe("preview");
  });
});
