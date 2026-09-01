import { test, expect } from "./support/fixtures";

// Regression test for IMPROVEMENTS.md's "toolbar ordering isn't grouped by
// type" fix: the trailing insert cluster (link/image/table/hr/diagram/
// math/footnote/command-palette) used to be one long run of buttons with
// no separators. Asserts the DOM order of that cluster, including where
// each new `.sep` sits, rather than just that every button exists.
test("toolbar groups insert-type buttons with separators, Command Palette set apart at the end", async ({ page }) => {
  const items = await page.$$eval(".toolbar-buttons > *", (els) =>
    els.map((el) => (el.classList.contains("sep") ? "sep" : (el.getAttribute("title") ?? el.id))),
  );

  const tailStart = items.indexOf("Link (Ctrl+K)");
  expect(tailStart).toBeGreaterThan(-1);

  expect(items.slice(tailStart)).toEqual([
    "Link (Ctrl+K)",
    "Image",
    "Manage images",
    "sep",
    "Table",
    "Horizontal rule",
    "Insert diagram",
    "sep",
    "Math",
    "Footnote",
    "sep",
    "Command Palette (Ctrl/Cmd+Shift+P)",
  ]);
});
