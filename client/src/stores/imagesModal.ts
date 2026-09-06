import { writable } from "svelte/store";

// Drives ImagePickerModal — the toolbar "Image" button and the Insert
// menu "Image..." item both open this.
export const imagesModalOpen = writable(false);

// Drives ManageImagesModal — the Insert menu "Manage Images..." item only.
export const manageImagesModalOpen = writable(false);
