import { render } from "vitest-browser-svelte";
import { expect, test, beforeEach, afterEach } from "vitest";
import { get } from "svelte/store";
import { userEvent } from "vitest/browser";
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { buildSearchExtension } from "../../../../client/src/search";

// stores/findReplace.ts imports stores/view.ts, which reads/writes
// document.getElementById("body") at module load time (it mirrors the
// current view mode onto that element's className) — this app's own
// index.html always has that element, but the plain tester page Vitest's
// browser mode serves for component tests doesn't, so it has to be
// seeded before either module ever loads (including transitively, via
// FindReplaceBar.svelte's own static import of stores/findReplace).
if (!document.getElementById("body")) {
  const bodyMarker = document.createElement("div");
  bodyMarker.id = "body";
  document.body.appendChild(bodyMarker);
}

const { findBarOpen, findBarMode, closeFindBar } = await import("../../../../client/src/stores/findReplace");
const { default: FindReplaceBar } = await import("../../../../client/src/components/FindReplaceBar.svelte");

let view: EditorView;
let host: HTMLDivElement;

function mountEditor(doc: string, readOnly = false) {
  host = document.createElement("div");
  document.body.appendChild(host);
  const extensions = readOnly ? [buildSearchExtension(), EditorState.readOnly.of(true)] : [buildSearchExtension()];
  view = new EditorView({ state: EditorState.create({ doc, extensions }), parent: host });
  window.MDE = { getEditor: () => view } as unknown as typeof window.MDE;
}

beforeEach(() => {
  findBarMode.set("find");
  findBarOpen.set(true);
});

afterEach(() => {
  closeFindBar();
  view?.destroy();
  host?.remove();
});

test("typing a query shows a live match count", async () => {
  mountEditor("cat cat CAT dog");
  const screen = await render(FindReplaceBar);
  await screen.getByLabelText("Find").fill("cat");
  // Case-insensitive by default: matches both "cat"s and "CAT".
  await expect.element(screen.getByText("1 of 3")).toBeVisible();
});

test("the match case toggle narrows the count", async () => {
  mountEditor("cat cat CAT dog");
  const screen = await render(FindReplaceBar);
  await screen.getByLabelText("Find").fill("cat");
  await screen.getByLabelText("Match case").click();
  // Case-sensitive: only the two lowercase "cat"s match, not "CAT".
  await expect.element(screen.getByText("1 of 2")).toBeVisible();
});

test("the replace row only appears in replace mode", async () => {
  mountEditor("cat cat");
  const screen = await render(FindReplaceBar);
  await expect.element(screen.getByLabelText("Replace", { exact: true })).not.toBeInTheDocument();
  await screen.getByLabelText("Toggle replace").click();
  await expect.element(screen.getByLabelText("Replace", { exact: true })).toBeVisible();
});

test("Replace and Replace All are disabled on a read-only view", async () => {
  mountEditor("cat cat", true);
  findBarMode.set("replace");
  const screen = await render(FindReplaceBar);
  await screen.getByLabelText("Find").fill("cat");
  await expect.element(screen.getByRole("button", { name: "Replace", exact: true })).toBeDisabled();
  await expect.element(screen.getByRole("button", { name: "Replace All" })).toBeDisabled();
});

test("an invalid regex disables navigation and shows the invalid state", async () => {
  mountEditor("cat cat");
  const screen = await render(FindReplaceBar);
  await screen.getByLabelText("Use regular expression").click();
  await screen.getByLabelText("Find").fill("cat(");
  await expect.element(screen.getByLabelText("Find")).toHaveClass("invalid");
  await expect.element(screen.getByRole("button", { name: "Next match" })).toBeDisabled();
});

test("Escape closes the bar", async () => {
  mountEditor("cat cat");
  const screen = await render(FindReplaceBar);
  await screen.getByLabelText("Find").fill("cat");
  await userEvent.keyboard("{Escape}");
  expect(get(findBarOpen)).toBe(false);
});

test("SRCH-05: Next / Previous cycle through matches and wrap around", async () => {
  mountEditor("cat one cat two cat three");
  const screen = await render(FindReplaceBar);
  const next = screen.getByRole("button", { name: "Next match" });
  await screen.getByLabelText("Find").fill("cat");
  await expect.element(screen.getByText("1 of 3")).toBeVisible();

  // The first Next selects the match the cursor is already at (match 1);
  // each subsequent Next advances.
  await next.click();
  expect(view.state.selection.main.from).toBe(0);
  await next.click();
  await expect.element(screen.getByText("2 of 3")).toBeVisible();
  await next.click();
  await expect.element(screen.getByText("3 of 3")).toBeVisible();
  await next.click();
  await expect.element(screen.getByText("1 of 3")).toBeVisible(); // wrapped forward

  await screen.getByRole("button", { name: "Previous match" }).click();
  await expect.element(screen.getByText("3 of 3")).toBeVisible(); // wrapped backward
});

test("SRCH-08: the whole-word toggle restricts matches to word boundaries", async () => {
  mountEditor("cat cats cat");
  const screen = await render(FindReplaceBar);
  await screen.getByLabelText("Find").fill("cat");
  await expect.element(screen.getByText("1 of 3")).toBeVisible();

  await screen.getByLabelText("Whole word").click();
  await expect.element(screen.getByText("1 of 2")).toBeVisible();
});

test("SRCH-06: Replace replaces just the current match, not all", async () => {
  mountEditor("cat cat cat");
  findBarMode.set("replace");
  const screen = await render(FindReplaceBar);
  const replace = screen.getByRole("button", { name: "Replace", exact: true });
  await screen.getByLabelText("Find").fill("cat");
  await screen.getByLabelText("Replace", { exact: true }).fill("dog");

  // CodeMirror's replaceNext: the first click just selects the match at
  // the cursor; the next click replaces it and advances.
  await replace.click();
  await replace.click();
  expect(view.state.doc.toString()).toBe("dog cat cat"); // exactly one replaced
});

test("SRCH-07: regex Replace All applies $1 capture-group substitutions", async () => {
  mountEditor("Ada Lovelace, Alan Turing");
  findBarMode.set("replace");
  const screen = await render(FindReplaceBar);
  await screen.getByLabelText("Use regular expression").click();
  await screen.getByLabelText("Find").fill("(\\w+) (\\w+)");
  await screen.getByLabelText("Replace", { exact: true }).fill("$2, $1");
  await screen.getByRole("button", { name: "Replace All" }).click();
  expect(view.state.doc.toString()).toBe("Lovelace, Ada, Turing, Alan");
});

test("SRCH-15: the Find query is not retained across a close then reopen", async () => {
  mountEditor("cat cat");
  const first = await render(FindReplaceBar);
  await first.getByLabelText("Find").fill("cat");
  await expect.element(first.getByText("1 of 2")).toBeVisible();

  closeFindBar();
  findBarOpen.set(true);
  const second = await render(FindReplaceBar);
  await expect.element(second.getByLabelText("Find").last()).toHaveValue("");
});
