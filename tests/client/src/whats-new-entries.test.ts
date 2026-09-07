import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { WHATS_NEW_ENTRIES } from "../../../client/src/whats-new-entries";
import type { WhatsNewCategory } from "../../../client/src/whats-new-entries";
import { CATEGORY_ICONS } from "../../../client/src/whats-new";

const KNOWN_CATEGORIES: WhatsNewCategory[] = ["Editing & Formatting", "Collaboration", "Version History", "GitHub Integration", "Organization & Navigation"];

const PUBLIC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../../client/public");

describe("WHATS_NEW_ENTRIES categories", () => {
  it("every entry has a category from the known set", () => {
    for (const entry of WHATS_NEW_ENTRIES) {
      expect(KNOWN_CATEGORIES).toContain(entry.category);
    }
  });
});

describe("WHATS_NEW_ENTRIES screenshots", () => {
  // WhatsNew.svelte renders `<img src={entry.screenshot}>` with NO
  // fallback — a screenshot file that isn't on disk is a broken-image
  // icon shown to every user who opens that entry, not a cosmetic gap
  // (this is exactly what CLAUDE.md's release checklist warns about, and
  // it has already happened once). Fail the build here so it's caught in
  // the PR that adds the entry, not in production.
  it("every entry's screenshot file exists under client/public/", () => {
    const missing = WHATS_NEW_ENTRIES.filter((e) => !existsSync(resolve(PUBLIC_DIR, `.${e.screenshot}`))).map(
      (e) => `  v${e.version} "${e.title}"  →  client/public${e.screenshot}`,
    );
    expect(
      missing,
      `\nWhat's New entries reference screenshot files that don't exist:\n${missing.join("\n")}\n\nCapture the real screenshot (see tests/scripts/manual-testing/capture-*-screenshot.mjs) into client/public/whats-new/ in the same change that adds the entry.\n`,
    ).toEqual([]);
  });

  it("every entry has a non-empty title + description and a well-formed screenshot path", () => {
    for (const e of WHATS_NEW_ENTRIES) {
      expect(e.title.trim(), `v${e.version} title is empty`).not.toBe("");
      expect(e.description.trim(), `v${e.version} "${e.title}" description is empty`).not.toBe("");
      expect(e.screenshot, `v${e.version} "${e.title}" screenshot path`).toMatch(/^\/whats-new\/[\w-]+\.(png|jpg|webp)$/);
    }
  });
});

describe("CATEGORY_ICONS", () => {
  it("has a sprite icon id for every known category", () => {
    for (const category of KNOWN_CATEGORIES) {
      expect(CATEGORY_ICONS[category]).toMatch(/^icon-/);
    }
  });
});
