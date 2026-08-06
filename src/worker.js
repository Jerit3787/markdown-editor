export { CollabRoom } from "./collab-room.js";
export { ImageQuota } from "./image-quota.js";
import { handleImageUpload, handleImageGet } from "./images.js";

const ROOM_PATH = /^\/api\/collab\/([A-Za-z0-9_-]{1,128})$/;
const IMAGE_GET_PATH = /^\/api\/images\/(.+)$/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const roomMatch = url.pathname.match(ROOM_PATH);
    if (roomMatch) {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected websocket", { status: 426 });
      }
      const id = env.COLLAB_ROOM.idFromName(roomMatch[1]);
      return env.COLLAB_ROOM.get(id).fetch(request);
    }

    if (url.pathname === "/api/images" && request.method === "POST") {
      return handleImageUpload(request, env);
    }
    const imageMatch = url.pathname.match(IMAGE_GET_PATH);
    if (imageMatch && request.method === "GET") {
      return handleImageGet(request, env, imageMatch[1]);
    }

    return env.ASSETS.fetch(request);
  },
};
