// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { get } from "svelte/store";

if (typeof localStorage === "undefined") {
  class MockLocalStorage {
    private data: Record<string, string> = {};
    setItem(key: string, value: string): void {
      this.data[key] = String(value);
    }
    getItem(key: string): string | null {
      return this.data[key] ?? null;
    }
    removeItem(key: string): void {
      delete this.data[key];
    }
    clear(): void {
      this.data = {};
    }
    key(index: number): string | null {
      return Object.keys(this.data)[index] ?? null;
    }
    get length(): number {
      return Object.keys(this.data).length;
    }
  }
  (globalThis as any).localStorage = new MockLocalStorage();
}

describe("keybindings store", () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
  });

  it("defaults to normal when localStorage has no saved mode", async () => {
    const { keybindingMode } = await import("../../../../client/src/stores/keybindings");
    expect(get(keybindingMode)).toBe("normal");
  });

  it("loads a previously-saved mode on module init", async () => {
    localStorage.setItem("mde:keybindings", "vim");
    const { keybindingMode } = await import("../../../../client/src/stores/keybindings");
    expect(get(keybindingMode)).toBe("vim");
  });

  it("falls back to normal for a corrupted/unrecognized saved value", async () => {
    localStorage.setItem("mde:keybindings", "colemak");
    const { keybindingMode } = await import("../../../../client/src/stores/keybindings");
    expect(get(keybindingMode)).toBe("normal");
  });

  it("setKeybindingMode updates the store and persists to localStorage", async () => {
    const { keybindingMode, setKeybindingMode } = await import("../../../../client/src/stores/keybindings");
    setKeybindingMode("emacs");
    expect(get(keybindingMode)).toBe("emacs");
    expect(localStorage.getItem("mde:keybindings")).toBe("emacs");
  });
});
