import { test, expect } from "./support/fixtures";

test("Document Info shows read-only info; Edit opens a modal to rename and edit metadata", async ({ page }) => {
  await page.click("#fileMenuBtn");
  await page.click("#menuDocInfo");
  const infoModal = page.locator(".modal-box-v2", { hasText: "Document info" });
  await expect(infoModal).toBeVisible();
  await expect(infoModal.getByRole("textbox")).toHaveCount(0);

  await infoModal.getByRole("button", { name: "Edit" }).click();
  const editModal = page.locator(".modal-box-v2", { hasText: "Edit document" });
  await expect(editModal).toBeVisible();

  const nameInput = page.locator("#docEditNameInput");
  await nameInput.fill("Renamed via edit modal");
  await nameInput.blur();

  await page.getByRole("button", { name: "Add field" }).click();
  await page.getByPlaceholder("Key").first().fill("Author");
  await page.getByPlaceholder("Value").first().fill("Ada");

  await editModal.getByRole("button", { name: "Close" }).click();

  await expect(infoModal).toContainText("Renamed via edit modal");
  await expect(infoModal).toContainText("Author");
  await expect(infoModal).toContainText("Ada");
});

test("renaming to a colliding name from the edit modal opens the collision dialog above it", async ({ page, docId }) => {
  // A second document to collide with, created through the store's own
  // API (not a raw localStorage write) — see slash-and-wikilinks.spec.ts's
  // "wikilink autocomplete" suite for the same pattern and why. createDoc()
  // always switches to the doc it creates, so switch back to the fixture's
  // doc afterward.
  await page.evaluate(async (existingId) => {
    const { createDoc, switchDoc } = await import("/src/stores/docs.ts");
    createDoc({ id: "e2e-doc-2", name: "Existing Doc" });
    switchDoc(existingId);
  }, docId);

  await page.click("#fileMenuBtn");
  await page.click("#menuDocInfo");
  await page.locator(".modal-box-v2", { hasText: "Document info" }).getByRole("button", { name: "Edit" }).click();

  const nameInput = page.locator("#docEditNameInput");
  await nameInput.fill("Existing Doc");
  await nameInput.blur();

  const collisionModal = page.locator(".modal-box-v2", { hasText: "Name already in use" });
  await expect(collisionModal).toBeVisible();
  await page.getByRole("button", { name: /^Save as/ }).click();
  await expect(collisionModal).not.toBeVisible();
  // The edit modal (elevated, underneath the now-closed collision dialog) is still open and usable.
  await expect(page.locator(".modal-box-v2", { hasText: "Edit document" })).toBeVisible();
});
