import { test, expect } from "./support/fixtures";

// NOTE: marked rejects a link destination containing a raw space —
// `[a](Design Notes)` is literal text, not a link (pre-existing marked
// behaviour, out of scope). A space-containing target must be written
// `[a](Design%20Notes)` or `[a](<Design Notes>)`; resolveDocRef decodes
// it. These tests use the `%20` form and space-free names.

test("G1: a [text](Doc%20Name) link navigates to that document in-app", async ({ page }) => {
  await page.evaluate(async () => {
    const { createDoc, switchDoc } = await import("/src/stores/docs.ts");
    createDoc({ id: "pl-target", name: "Design Notes" });
    switchDoc("e2e-doc-1");
  });
  await page.click("#editor-mount .cm-content");
  await page.keyboard.type("See [the notes](Design%20Notes) here.");
  await expect(page.locator("#preview a.wikilink")).toHaveText("the notes");
  await page.click("#preview a.wikilink");
  await expect.poll(() => page.evaluate(() => new URL(location.href).pathname)).toContain("pl-target");
});

test("G1: an unresolved bare-name [text](ref) shows the dashed affordance; clicking creates the doc (never a dead /d/ nav)", async ({ page }) => {
  await page.click("#editor-mount .cm-content");
  await page.keyboard.type("[a draft](SomeDraftDoc)");
  const link = page.locator("#preview a.doc-ref-missing");
  await expect(link).toHaveAttribute("title", /No document named/);
  const before = await page.evaluate(() => JSON.parse(localStorage.getItem("mde:docs") || "[]").length);
  await link.click();
  // A new doc is created and opened — the URL never becomes /d/SomeDraftDoc.
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("mde:docs") || "[]").length)).toBe(before + 1);
  expect(new URL(page.url()).pathname).not.toContain("SomeDraftDoc");
});

test("G1: an unresolved path-form [text](ref) is inert on click (no dead navigation, no stray doc)", async ({ page }) => {
  await page.click("#editor-mount .cm-content");
  await page.keyboard.type("[api](docs/missing.md)");
  const link = page.locator("#preview a.doc-ref-missing");
  await expect(link).toHaveAttribute("title", /No document named/);
  const before = page.url();
  const docsBefore = await page.evaluate(() => JSON.parse(localStorage.getItem("mde:docs") || "[]").length);
  await link.click();
  expect(page.url()).toBe(before);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("mde:docs") || "[]").length)).toBe(docsBefore);
});

test("G1: a bare-domain link opens in a new tab", async ({ page }) => {
  await page.click("#editor-mount .cm-content");
  await page.keyboard.type("[our site](example.com)");
  const link = page.locator('#preview a[href="https://example.com"]');
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", /noopener/);
});

test("G2: [[Name]] inside an inline code span renders literally", async ({ page }) => {
  await page.click("#editor-mount .cm-content");
  await page.keyboard.type("use `[[Secret]]` verbatim");
  await expect(page.locator("#preview code")).toHaveText("[[Secret]]");
  await expect(page.locator("#preview")).not.toContainText("wikilink:");
});
