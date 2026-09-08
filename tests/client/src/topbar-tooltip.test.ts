import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const html = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../../client/index.html"), "utf8");

describe("UI-5: top-bar tooltip attribute migration", () => {
  const ids = ["commentsBtn", "versionHistoryBtn", "settingsBtn", "newDocBtn"];
  for (const id of ids) {
    it(`#${id} has data-tooltip and no title=`, () => {
      const tag = html.match(new RegExp(`<button[^>]*\\bid="${id}"[^>]*>`))?.[0] ?? "";
      expect(tag, `#${id} <button> tag not found`).not.toBe("");
      expect(tag).toContain("data-tooltip=");
      expect(tag).not.toMatch(/\btitle=/);
      expect(tag).toContain("aria-label=");
    });
  }

  it("#shareBtn has neither title= nor data-tooltip (it has a visible label)", () => {
    const tag = html.match(/<button[^>]*\bid="shareBtn"[^>]*>/)?.[0] ?? "";
    expect(tag).not.toBe("");
    expect(tag).not.toMatch(/\btitle=/);
    expect(tag).not.toContain("data-tooltip=");
  });
});
