import { test, expect } from "vitest";
import { get } from "svelte/store";
import { shareChoice, shareChoiceRequest } from "../../../../client/src/stores/shareChoice";

test("a second share choice cancels the first instead of leaving its promise hanging", async () => {
  const first = shareChoice("A", "W", 2);
  const second = shareChoice("B", "W", 2);

  await expect(first).resolves.toBe("cancel");
  get(shareChoiceRequest)?.resolve("workspace");
  await expect(second).resolves.toBe("workspace");
});
