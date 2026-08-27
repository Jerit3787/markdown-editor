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
