// @vitest-environment jsdom
import { test, expect, vi, beforeEach } from "vitest";
import { get } from "svelte/store";

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
});

test("defaults to empty when no seed is stored", async () => {
  const { collabIdentity } = await import("../../../../client/src/stores/collabIdentity");
  expect(get(collabIdentity)).toEqual({ id: "", name: "" });
});

test("seeds synchronously from a stored anon identity", async () => {
  localStorage.setItem("mde_anon_identity", JSON.stringify({ id: "anon:abc123", name: "Swift Otter" }));
  const { collabIdentity } = await import("../../../../client/src/stores/collabIdentity");
  expect(get(collabIdentity)).toEqual({ id: "anon:abc123", name: "Swift Otter" });
});

test("ignores a stored value that is not an anon id", async () => {
  localStorage.setItem("mde_anon_identity", JSON.stringify({ id: "alice", name: "alice" }));
  const { collabIdentity } = await import("../../../../client/src/stores/collabIdentity");
  expect(get(collabIdentity)).toEqual({ id: "", name: "" });
});
