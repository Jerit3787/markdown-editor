import { render } from "vitest-browser-svelte";
import { expect, test } from "vitest";
import GistVisibilityDialog from "../../../../client/src/components/GistVisibilityDialog.svelte";
import { chooseGistVisibility } from "../../../../client/src/stores/gistVisibilityDialog";

test("defaults to Secret and resolves it when Publish is clicked without changing the selection", async () => {
  const resultPromise = chooseGistVisibility();
  const screen = await render(GistVisibilityDialog);

  await expect.element(screen.getByRole("combobox")).toHaveValue("secret");
  await screen.getByRole("button", { name: "Publish" }).click();

  await expect(resultPromise).resolves.toBe("secret");
});

test('selecting Public and clicking Publish resolves "public"', async () => {
  const resultPromise = chooseGistVisibility();
  const screen = await render(GistVisibilityDialog);

  await screen.getByRole("combobox").selectOptions("public");
  await screen.getByRole("button", { name: "Publish" }).click();

  await expect(resultPromise).resolves.toBe("public");
});

test("Cancel resolves null", async () => {
  const resultPromise = chooseGistVisibility();
  const screen = await render(GistVisibilityDialog);

  await screen.getByRole("button", { name: "Cancel" }).click();

  await expect(resultPromise).resolves.toBeNull();
});
