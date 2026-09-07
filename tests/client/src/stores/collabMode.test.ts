// @vitest-environment jsdom
import { test, expect, beforeEach } from "vitest";
import { get } from "svelte/store";
import {
  collabRole,
  collabIsOwner,
  chosenMode,
  effectiveMode,
  modesAllowed,
  setChosenMode,
  enterCollabRoom,
  leaveCollabRoom,
} from "../../../../client/src/stores/collabMode";

beforeEach(() => {
  localStorage.clear();
  leaveCollabRoom();
});

test("effectiveMode is null when not in a shared workspace", () => {
  expect(get(effectiveMode)).toBeNull();
  expect(get(modesAllowed)).toEqual([]);
});

test("effectiveMode defaults per role and clamps to the ceiling", () => {
  enterCollabRoom("r1", "viewer", false);
  expect(get(effectiveMode)).toBe("viewing");
  expect(get(modesAllowed)).toEqual(["viewing"]);

  enterCollabRoom("r2", "reviewer", false);
  expect(get(effectiveMode)).toBe("suggesting");
  expect(get(modesAllowed)).toEqual(["suggesting", "viewing"]);

  enterCollabRoom("r3", "editor", true);
  expect(get(effectiveMode)).toBe("editing");
  expect(get(modesAllowed)).toEqual(["editing", "suggesting", "viewing"]);
});

test("setChosenMode honours a valid pick and rejects one above the ceiling", () => {
  enterCollabRoom("r1", "reviewer", false);
  setChosenMode("editing"); // above ceiling — ignored
  expect(get(effectiveMode)).toBe("suggesting");
  setChosenMode("viewing");
  expect(get(effectiveMode)).toBe("viewing");
});

test("a chosen mode persists per remoteId and reloads on re-enter", () => {
  enterCollabRoom("r1", "editor", true);
  setChosenMode("viewing");
  leaveCollabRoom();
  enterCollabRoom("r1", "editor", true);
  expect(get(chosenMode)).toBe("viewing");
  expect(get(effectiveMode)).toBe("viewing");
});

test("chosen modes are keyed per remoteId, not shared", () => {
  enterCollabRoom("r1", "editor", true);
  setChosenMode("suggesting");
  leaveCollabRoom();
  enterCollabRoom("r2", "editor", true);
  expect(get(chosenMode)).toBeNull();
  expect(get(effectiveMode)).toBe("editing");
});

test("a stored mode that now exceeds the role is clamped, not applied", () => {
  localStorage.setItem("mde:collabMode", JSON.stringify({ r1: "editing" }));
  enterCollabRoom("r1", "viewer", false);
  expect(get(effectiveMode)).toBe("viewing");
});

test("leaveCollabRoom resets everything", () => {
  enterCollabRoom("r1", "editor", true);
  setChosenMode("suggesting");
  leaveCollabRoom();
  expect(get(collabRole)).toBeNull();
  expect(get(collabIsOwner)).toBe(false);
  expect(get(chosenMode)).toBeNull();
  expect(get(effectiveMode)).toBeNull();
});

test("setChosenMode is a no-op outside a room (no remoteId)", () => {
  setChosenMode("viewing");
  expect(get(chosenMode)).toBeNull();
  expect(localStorage.getItem("mde:collabMode")).toBeNull();
});
