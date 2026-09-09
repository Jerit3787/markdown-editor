import { test, expect, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import AnnotationCard from "../../../../client/src/components/AnnotationCard.svelte";
import type { RailAnnotation } from "../../../../client/src/annotations";

const insertSug: RailAnnotation = {
  id: "s1",
  kind: "suggestion",
  author: "alice",
  createdAt: 0,
  anchorFrom: 5,
  anchorTo: 11,
  changeKind: "insert",
  changeText: "world",
};
const replaceSug: RailAnnotation = {
  id: "d1+i1",
  kind: "suggestion",
  author: "alice",
  createdAt: 0,
  anchorFrom: 0,
  anchorTo: 11,
  changeText: "requests",
  replacedText: "fetches",
  groupedIds: ["d1", "i1"],
};
const comment: RailAnnotation = {
  id: "t1",
  kind: "comment",
  author: "bob",
  createdAt: 0,
  anchorFrom: 0,
  anchorTo: 5,
  quote: "hello",
  resolved: false,
  replies: [{ id: "c1", author: "bob", body: "is this right?", createdAt: 0 }],
};

test("an editor sees Accept + Reject on a suggestion and no Withdraw", async () => {
  const onAccept = vi.fn();
  const screen = await render(AnnotationCard, { annotation: insertSug, viewer: { role: "editor", name: "carol" }, onAccept });
  await expect.element(screen.getByText(/add/i)).toBeInTheDocument();
  await expect.element(screen.getByText("world")).toBeInTheDocument();
  await screen.getByRole("button", { name: /accept/i }).click();
  expect(onAccept).toHaveBeenCalledOnce();
  expect(screen.container.querySelector("button[data-act='withdraw']")).toBeNull();
});

test("the author sees Withdraw, not Accept", async () => {
  const screen = await render(AnnotationCard, { annotation: insertSug, viewer: { role: "reviewer", name: "alice" } });
  await expect.element(screen.getByRole("button", { name: /withdraw/i })).toBeInTheDocument();
  expect(screen.container.querySelector("button[data-act='accept']")).toBeNull();
});

test("a third-party reviewer sees no action row on a suggestion", async () => {
  const screen = await render(AnnotationCard, { annotation: insertSug, viewer: { role: "reviewer", name: "dave" } });
  expect(screen.container.querySelector(".annotation-card-actions")).toBeNull();
});

test("renders a replace on one line", async () => {
  const screen = await render(AnnotationCard, { annotation: replaceSug, viewer: { role: "editor", name: "carol" } });
  await expect.element(screen.getByText("fetches")).toBeInTheDocument();
  await expect.element(screen.getByText("requests")).toBeInTheDocument();
});

test("a comment card shows the quote, replies, and a Resolve toggle", async () => {
  const onResolve = vi.fn();
  const screen = await render(AnnotationCard, { annotation: comment, viewer: { role: "editor", name: "carol" }, focused: true, onResolve });
  await expect.element(screen.getByText(/is this right\?/)).toBeInTheDocument();
  await screen.getByRole("button", { name: /resolve/i }).click();
  expect(onResolve).toHaveBeenCalledWith(true);
});
