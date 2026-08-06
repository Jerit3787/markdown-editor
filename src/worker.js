export { CollabRoom } from "./collab-room.js";

const ROOM_PATH = /^\/api\/collab\/([A-Za-z0-9_-]{1,128})$/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const match = url.pathname.match(ROOM_PATH);

    if (match) {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected websocket", { status: 426 });
      }
      const id = env.COLLAB_ROOM.idFromName(match[1]);
      const stub = env.COLLAB_ROOM.get(id);
      return stub.fetch(request);
    }

    return env.ASSETS.fetch(request);
  },
};
