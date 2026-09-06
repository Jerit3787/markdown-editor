import { test, expect } from "vitest";
import { render } from "vitest-browser-svelte";
import DiffView from "../../../../client/src/components/DiffView.svelte";

const IMG = "data:image/png;base64,AAAA";

test("VER-12: renders line-number gutters and word-level intraline highlighting", async () => {
  const screen = await render(DiffView, { before: "alpha\nold value\ngamma\n", after: "alpha\nnew value\ngamma\n" });

  const gutters = Array.from(screen.container.querySelectorAll(".diff-view-gutter")).map((g) => g.textContent?.trim());
  expect(gutters).toContain("1");
  expect(gutters).toContain("2");
  expect(gutters).toContain("3");

  // "value" is unchanged between "old value" and "new value" — only the
  // differing words carry .diff-segment-changed.
  const changed = Array.from(screen.container.querySelectorAll(".diff-segment-changed")).map((s) => s.textContent);
  expect(changed).toContain("old");
  expect(changed).toContain("new");
  expect(changed).not.toContain("value");
});

test("VER-12: the Split / Unified toggle switches layout", async () => {
  const screen = await render(DiffView, { before: "a\nb\n", after: "a\nc\n" });

  expect(screen.container.querySelector(".diff-view-unified")).toBeNull();
  await screen.getByRole("button", { name: "Unified" }).click();
  expect(screen.container.querySelector(".diff-view-unified")).not.toBeNull();
  await screen.getByRole("button", { name: "Split" }).click();
  expect(screen.container.querySelector(".diff-view-unified")).toBeNull();
});

test("VER-13: renders before/after image thumbnails for an image-only changed line, Split and Unified", async () => {
  const before = "intro\n![old pic](old.png)\nend\n";
  const after = "intro\n![new pic](new.png)\nend\n";
  const screen = await render(DiffView, {
    before,
    after,
    beforeImages: { "old.png": IMG },
    afterImages: { "new.png": IMG },
  });

  let thumbs = Array.from(screen.container.querySelectorAll("img.diff-image-thumb"));
  expect(thumbs.map((t) => t.getAttribute("src"))).toEqual([IMG, IMG]);
  expect(thumbs.map((t) => t.getAttribute("alt"))).toEqual(["old pic", "new pic"]);

  await screen.getByRole("button", { name: "Unified" }).click();
  thumbs = Array.from(screen.container.querySelectorAll("img.diff-image-thumb"));
  expect(thumbs.length).toBe(2);
  expect(thumbs.every((t) => t.getAttribute("src") === IMG)).toBe(true);
});

test("VER-13: an unknown ref falls back to the raw ref as src (browser shows its own broken-image icon)", async () => {
  const screen = await render(DiffView, {
    before: "![x](a.png)\n",
    after: "![x](b.png)\n",
    beforeImages: {},
    afterImages: {},
  });
  const thumbs = Array.from(screen.container.querySelectorAll("img.diff-image-thumb"));
  expect(thumbs.map((t) => t.getAttribute("src"))).toEqual(["a.png", "b.png"]);
});

test("VER-14: shows a loading placeholder while an image-line diff's images are still undefined", async () => {
  const screen = await render(DiffView, {
    before: "![p](a.png)\n",
    after: "![p](b.png)\n",
    // beforeImages / afterImages omitted -> still loading
  });
  expect(screen.container.querySelectorAll(".diff-image-loading").length).toBe(2);
  expect(screen.container.querySelector("img.diff-image-thumb")).toBeNull();

  await screen.getByRole("button", { name: "Unified" }).click();
  expect(screen.container.querySelectorAll(".diff-image-loading").length).toBe(2);
});
