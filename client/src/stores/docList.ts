import { writable } from "svelte/store";

// DocList.svelte's mobile Documents/Headings tab bar. A store rather than
// component-local $state because #sidebar (and DocList.svelte inside it)
// stays mounted continuously on mobile — the bottom sheet's open/closed
// state is a CSS transform, not conditional rendering — so local state
// would silently persist across close/reopen. app.ts resets this to
// "documents" whenever the sheet is opened (see toggleSidebar()).
export type DocListTab = "documents" | "headings";
export const docListActiveTab = writable<DocListTab>("documents");
