import { writable } from "svelte/store";

// Opened from the top-bar account menu (TopbarAccount.svelte). Its own
// tiny store so that menu can reach it without importing the component —
// same pattern as shortcutsModal / githubSignInModal / linkModal.
export const settingsModalOpen = writable(false);
