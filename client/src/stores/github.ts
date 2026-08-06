import { writable } from "svelte/store";

// Set by gist.ts's render() whenever the signed-in GitHub username changes
// (or becomes null on sign-out) — the one piece of gist.ts's state that
// Settings.svelte needs to render reactively instead of via direct DOM
// manipulation, now that it owns that markup instead of gist.ts.
export const githubUsername = writable<string | null>(null);
