import { writable } from "svelte/store";

export const githubSignInModalOpen = writable(false);
export const githubSignInModalHint = writable("");
