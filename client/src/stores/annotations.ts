import { writable } from "svelte/store";

// The raw suggestion-entry / comment-thread ids currently hovered or
// focused, shared between the editor (which highlights the matching
// marks via .cm-annotation-active) and the rail (which highlights the
// matching card). A replace card contributes both of its underlying ids.
export const activeAnnotationIds = writable<string[]>([]);
