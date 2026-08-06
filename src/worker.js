export { CollabRoom } from "./collab-room.js";

const ROOM_PATH = /^\/api\/collab\/([A-Za-z0-9_-]{1,128})$/;

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

    return env.ASSETS.fetch(request);
  },
};
