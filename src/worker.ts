export { CollabRoom } from "./collab-room.js";
import {
  handleLogin,
  handleCallback,
  handleLogout,
  handleMe,
  handleGistCreate,
  handleGistUpdate,
  handleGistGet,
  handleGistList,
} from "./github-auth.js";
import { handleGistImageUpload } from "./gist-images.js";
import type { Env } from "./env";

const ROOM_PATH = /^\/api\/collab\/([A-Za-z0-9_-]{1,128})$/;
const ROOM_ACCESS_PATH = /^\/api\/collab\/([A-Za-z0-9_-]{1,128})\/access$/;
const GIST_PATH = /^\/api\/gist\/([0-9a-f]+)$/i;
const GIST_IMAGE_PATH = /^\/api\/gist\/([0-9a-f]+)\/image$/i;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    const roomAccessMatch = url.pathname.match(ROOM_ACCESS_PATH);
    if (roomAccessMatch) {
      const id = env.COLLAB_ROOM.idFromName(roomAccessMatch[1]!);
      return env.COLLAB_ROOM.get(id).fetch(request);
    }

    const roomMatch = url.pathname.match(ROOM_PATH);
    if (roomMatch) {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected websocket", { status: 426 });
      }
      const id = env.COLLAB_ROOM.idFromName(roomMatch[1]!);
      return env.COLLAB_ROOM.get(id).fetch(request);
    }

    if (url.pathname === "/api/auth/github/login") return handleLogin(request, env);
    if (url.pathname === "/api/auth/github/callback") return handleCallback(request, env);
    if (url.pathname === "/api/auth/github/logout") return handleLogout(request);
    if (url.pathname === "/api/auth/github/me") return handleMe(request, env);

    if (url.pathname === "/api/gist" && request.method === "POST") return handleGistCreate(request, env);
    if (url.pathname === "/api/gists" && request.method === "GET") return handleGistList(request, env);
    const gistImageMatch = url.pathname.match(GIST_IMAGE_PATH);
    if (gistImageMatch && request.method === "POST") return handleGistImageUpload(request, env, gistImageMatch[1]!);

    const gistMatch = url.pathname.match(GIST_PATH);
    if (gistMatch && request.method === "PATCH") return handleGistUpdate(request, env, gistMatch[1]!);
    if (gistMatch && request.method === "GET") return handleGistGet(request, env, gistMatch[1]!);

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
