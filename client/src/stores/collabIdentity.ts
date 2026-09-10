import { writable } from "svelte/store";

// The current user's collaboration identity: a GitHub username, or a
// server-assigned "anon:<id>". `name` is the display label (the username,
// or the assigned "Adjective Animal"). Empty until resolved:
// - signed in  -> set from window.MDE.githubUsername in collab.ts
// - anonymous  -> set from the MESSAGE_ANON_IDENTITY frame
// A returning anonymous visitor is seeded synchronously below so their
// cards / cursor don't flash an empty identity before the frame lands.
export const collabIdentity = writable<{ id: string; name: string }>(readSeed());

function readSeed(): { id: string; name: string } {
  try {
    const raw = localStorage.getItem("mde_anon_identity");
    if (raw) {
      const p = JSON.parse(raw) as { id?: unknown; name?: unknown };
      if (typeof p.id === "string" && typeof p.name === "string" && p.id.startsWith("anon:")) return { id: p.id, name: p.name };
    }
  } catch {
    /* private mode / blocked / malformed */
  }
  return { id: "", name: "" };
}
