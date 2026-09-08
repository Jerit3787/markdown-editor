import { writable } from "svelte/store";

// The "checking you're human" modal (TurnstilePrompt.svelte) — opened by
// client/src/turnstile.ts's solveTurnstile() while a fresh challenge is
// pending, closed on success or cancel.
export const turnstilePromptOpen = writable(false);
export const turnstilePromptError = writable(false);
