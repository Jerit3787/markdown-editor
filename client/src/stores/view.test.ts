// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { viewMode, isEditorOn, isPreviewOn, toggleEditorPane, togglePreviewPane } from "./view";

describe("isEditorOn / isPreviewOn", () => {
  it("editor mode: editor on, preview off", () => {
    expect(isEditorOn("editor")).toBe(true);
    expect(isPreviewOn("editor")).toBe(false);
  });

  it("preview mode: editor off, preview on", () => {
    expect(isEditorOn("preview")).toBe(false);
    expect(isPreviewOn("preview")).toBe(true);
  });

  it("split mode: both on", () => {
    expect(isEditorOn("split")).toBe(true);
    expect(isPreviewOn("split")).toBe(true);
  });
});

describe("toggleEditorPane / togglePreviewPane", () => {
  beforeEach(() => {
    window.MDE = { setView: vi.fn() } as unknown as typeof window.MDE;
  });

  it("toggleEditorPane from split turns editor off (-> preview)", () => {
    viewMode.set("split");
    toggleEditorPane();
    expect(window.MDE.setView).toHaveBeenCalledWith("preview");
  });

  it("toggleEditorPane from preview turns editor on (-> split)", () => {
    viewMode.set("preview");
    toggleEditorPane();
    expect(window.MDE.setView).toHaveBeenCalledWith("split");
  });

  it("toggleEditorPane from editor is a no-op (editor is the only pane on)", () => {
    viewMode.set("editor");
    toggleEditorPane();
    expect(window.MDE.setView).not.toHaveBeenCalled();
  });

  it("togglePreviewPane from split turns preview off (-> editor)", () => {
    viewMode.set("split");
    togglePreviewPane();
    expect(window.MDE.setView).toHaveBeenCalledWith("editor");
  });

  it("togglePreviewPane from editor turns preview on (-> split)", () => {
    viewMode.set("editor");
    togglePreviewPane();
    expect(window.MDE.setView).toHaveBeenCalledWith("split");
  });

  it("togglePreviewPane from preview is a no-op (preview is the only pane on)", () => {
    viewMode.set("preview");
    togglePreviewPane();
    expect(window.MDE.setView).not.toHaveBeenCalled();
  });
});
