export { CollabRoom } from "./collab-room.js";
export { WorkspaceRoom } from "./workspace-room.js";
import { handleLogin, handleCallback, handleLogout, handleMe, handleGistCreate, handleGistUpdate, handleGistGet, handleGistList } from "./github-auth.js";
import { handleGistImageUpload } from "./gist-images.js";
import { handleRepoList, handleRepoCreate, handleRepoTree, handleRepoBlob, handleRepoCommits, handleRepoFileAtRef, handleRepoPush } from "./github-repo.js";
import type { Env } from "./env";
import { generateNonce, appCsp, legalCsp } from "./csp.js";

const ROOM_PATH = /^\/api\/collab\/([A-Za-z0-9_-]{1,128})$/;
const ROOM_ACCESS_PATH = /^\/api\/collab\/([A-Za-z0-9_-]{1,128})\/access$/;
const ROOM_MIGRATE_PATH = /^\/api\/collab\/([A-Za-z0-9_-]{1,128})\/migrate$/;
const ROOM_VERSIONS_PATH = /^\/api\/collab\/([A-Za-z0-9_-]{1,128})\/versions(\/.*)?$/;
const ROOM_COMMENTS_PATH = /^\/api\/collab\/([A-Za-z0-9_-]{1,128})\/comments(\/.*)?$/;
const WORKSPACE_PATH = /^\/api\/workspace\/([A-Za-z0-9_-]{1,128})$/;
const WORKSPACE_ACCESS_PATH = /^\/api\/workspace\/([A-Za-z0-9_-]{1,128})\/access$/;
const WORKSPACE_ACCESS_REQUEST_PATH = /^\/api\/workspace\/([A-Za-z0-9_-]{1,128})\/access-request(\/[A-Za-z0-9_.@-]{1,128})?$/;
const WORKSPACE_JOIN_TICKET_PATH = /^\/api\/workspace\/([A-Za-z0-9_-]{1,128})\/join-ticket$/;
const WORKSPACE_META_PATH = /^\/api\/workspace\/([A-Za-z0-9_-]{1,128})\/meta$/;
const WORKSPACE_DOCS_PATH = /^\/api\/workspace\/([A-Za-z0-9_-]{1,128})\/docs$/;
const WORKSPACE_DOC_VERSIONS_PATH = /^\/api\/workspace\/([A-Za-z0-9_-]{1,128})\/docs\/([A-Za-z0-9_-]{1,128})\/versions(\/.*)?$/;
const WORKSPACE_DOC_COMMENTS_PATH = /^\/api\/workspace\/([A-Za-z0-9_-]{1,128})\/docs\/([A-Za-z0-9_-]{1,128})\/comments(\/.*)?$/;
const WORKSPACE_DOC_WIKILINK_RENAME_PATH = /^\/api\/workspace\/([A-Za-z0-9_-]{1,128})\/docs\/([A-Za-z0-9_-]{1,128})\/wikilink-rename$/;
const GIST_PATH = /^\/api\/gist\/([0-9a-f]+)$/i;
const GIST_IMAGE_PATH = /^\/api\/gist\/([0-9a-f]+)\/image$/i;
const REPO_TREE_PATH = /^\/api\/repo\/([^/]+)\/([^/]+)\/tree$/;
const REPO_BLOB_PATH = /^\/api\/repo\/([^/]+)\/([^/]+)\/blob\/([0-9a-f]+)$/i;
const REPO_PUSH_PATH = /^\/api\/repo\/([^/]+)\/([^/]+)\/push$/;
const REPO_COMMITS_PATH = /^\/api\/repo\/([^/]+)\/([^/]+)\/commits$/;
const REPO_FILE_AT_REF_PATH = /^\/api\/repo\/([^/]+)\/([^/]+)\/contents\/(.+)$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    const workspaceAccessMatch = url.pathname.match(WORKSPACE_ACCESS_PATH);
    if (workspaceAccessMatch) {
      const id = env.WORKSPACE_ROOM.idFromName(workspaceAccessMatch[1]!);
      return env.WORKSPACE_ROOM.get(id).fetch(request);
    }

    const workspaceAccessRequestMatch = url.pathname.match(WORKSPACE_ACCESS_REQUEST_PATH);
    if (workspaceAccessRequestMatch) {
      const id = env.WORKSPACE_ROOM.idFromName(workspaceAccessRequestMatch[1]!);
      return env.WORKSPACE_ROOM.get(id).fetch(request);
    }

    const joinTicketMatch = url.pathname.match(WORKSPACE_JOIN_TICKET_PATH);
    if (joinTicketMatch) {
      const id = env.WORKSPACE_ROOM.idFromName(joinTicketMatch[1]!);
      return env.WORKSPACE_ROOM.get(id).fetch(request);
    }

    const workspaceMetaMatch = url.pathname.match(WORKSPACE_META_PATH);
    if (workspaceMetaMatch) {
      const id = env.WORKSPACE_ROOM.idFromName(workspaceMetaMatch[1]!);
      return env.WORKSPACE_ROOM.get(id).fetch(request);
    }

    const workspaceDocsMatch = url.pathname.match(WORKSPACE_DOCS_PATH);
    if (workspaceDocsMatch) {
      const id = env.WORKSPACE_ROOM.idFromName(workspaceDocsMatch[1]!);
      return env.WORKSPACE_ROOM.get(id).fetch(request);
    }

    const workspaceDocVersionsMatch = url.pathname.match(WORKSPACE_DOC_VERSIONS_PATH);
    if (workspaceDocVersionsMatch) {
      const id = env.WORKSPACE_ROOM.idFromName(workspaceDocVersionsMatch[1]!);
      return env.WORKSPACE_ROOM.get(id).fetch(request);
    }

    const workspaceDocCommentsMatch = url.pathname.match(WORKSPACE_DOC_COMMENTS_PATH);
    if (workspaceDocCommentsMatch) {
      const id = env.WORKSPACE_ROOM.idFromName(workspaceDocCommentsMatch[1]!);
      return env.WORKSPACE_ROOM.get(id).fetch(request);
    }

    const workspaceWikilinkRenameMatch = url.pathname.match(WORKSPACE_DOC_WIKILINK_RENAME_PATH);
    if (workspaceWikilinkRenameMatch) {
      const id = env.WORKSPACE_ROOM.idFromName(workspaceWikilinkRenameMatch[1]!);
      return env.WORKSPACE_ROOM.get(id).fetch(request);
    }

    const workspaceMatch = url.pathname.match(WORKSPACE_PATH);
    if (workspaceMatch) {
      if (request.method !== "DELETE" && request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected websocket", { status: 426 });
      }
      const id = env.WORKSPACE_ROOM.idFromName(workspaceMatch[1]!);
      return env.WORKSPACE_ROOM.get(id).fetch(request);
    }

    const roomMigrateMatch = url.pathname.match(ROOM_MIGRATE_PATH);
    if (roomMigrateMatch) {
      const id = env.COLLAB_ROOM.idFromName(roomMigrateMatch[1]!);
      return env.COLLAB_ROOM.get(id).fetch(request);
    }

    const roomAccessMatch = url.pathname.match(ROOM_ACCESS_PATH);
    if (roomAccessMatch) {
      const id = env.COLLAB_ROOM.idFromName(roomAccessMatch[1]!);
      return env.COLLAB_ROOM.get(id).fetch(request);
    }

    const roomVersionsMatch = url.pathname.match(ROOM_VERSIONS_PATH);
    if (roomVersionsMatch) {
      const id = env.COLLAB_ROOM.idFromName(roomVersionsMatch[1]!);
      return env.COLLAB_ROOM.get(id).fetch(request);
    }

    const roomCommentsMatch = url.pathname.match(ROOM_COMMENTS_PATH);
    if (roomCommentsMatch) {
      const id = env.COLLAB_ROOM.idFromName(roomCommentsMatch[1]!);
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
    // POST-only: a GET here is reachable by a cross-site top-level
    // navigation (SameSite=Lax sends the session cookie), and handleLogout
    // revokes the GitHub OAuth grant + clears the session — a CSRF logout
    // (MDE-03). The app only ever calls this with fetch(..., {method:"POST"}).
    if (url.pathname === "/api/auth/github/logout") {
      if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
      return handleLogout(request, env);
    }
    if (url.pathname === "/api/auth/github/me") return handleMe(request, env);

    if (url.pathname === "/api/gist" && request.method === "POST") return handleGistCreate(request, env);
    if (url.pathname === "/api/gists" && request.method === "GET") return handleGistList(request, env);
    const gistImageMatch = url.pathname.match(GIST_IMAGE_PATH);
    if (gistImageMatch && request.method === "POST") return handleGistImageUpload(request, env, gistImageMatch[1]!);

    const gistMatch = url.pathname.match(GIST_PATH);
    if (gistMatch && request.method === "PATCH") return handleGistUpdate(request, env, gistMatch[1]!);
    if (gistMatch && request.method === "GET") return handleGistGet(request, env, gistMatch[1]!);

    if (url.pathname === "/api/repo/list" && request.method === "GET") return handleRepoList(request, env);
    if (url.pathname === "/api/repo/create" && request.method === "POST") return handleRepoCreate(request, env);

    const repoTreeMatch = url.pathname.match(REPO_TREE_PATH);
    if (repoTreeMatch && request.method === "GET") {
      const branch = url.searchParams.get("branch") || "";
      const sha = url.searchParams.get("sha") || undefined;
      return handleRepoTree(request, env, repoTreeMatch[1]!, repoTreeMatch[2]!, branch, sha);
    }

    const repoBlobMatch = url.pathname.match(REPO_BLOB_PATH);
    if (repoBlobMatch && request.method === "GET") return handleRepoBlob(request, env, repoBlobMatch[1]!, repoBlobMatch[2]!, repoBlobMatch[3]!);

    const repoCommitsMatch = url.pathname.match(REPO_COMMITS_PATH);
    if (repoCommitsMatch && request.method === "GET") {
      const branch = url.searchParams.get("branch") || "";
      const page = Number(url.searchParams.get("page")) || 1;
      const path = url.searchParams.get("path") || undefined;
      return handleRepoCommits(request, env, repoCommitsMatch[1]!, repoCommitsMatch[2]!, branch, page, path);
    }

    const repoFileAtRefMatch = url.pathname.match(REPO_FILE_AT_REF_PATH);
    if (repoFileAtRefMatch && request.method === "GET") {
      const ref = url.searchParams.get("ref") || "";
      return handleRepoFileAtRef(request, env, repoFileAtRefMatch[1]!, repoFileAtRefMatch[2]!, repoFileAtRefMatch[3]!, ref);
    }

    const repoPushMatch = url.pathname.match(REPO_PUSH_PATH);
    if (repoPushMatch && request.method === "POST") return handleRepoPush(request, env, repoPushMatch[1]!, repoPushMatch[2]!);

    // Terms / Privacy (client/public/{privacy,terms}.html) are served at
    // the clean URLs /privacy and /terms directly by the asset layer's
    // html_handling (it maps /privacy → privacy.html). No worker route:
    // an explicit rewrite to `/privacy.html` gets 307'd back to
    // `/privacy` by that same html_handling, which is an infinite loop.
    // `not_found_handling: single-page-application` only fires for paths
    // with NO matching asset, so it never shadows these two.
    const assetRes = await env.ASSETS.fetch(request);
    const contentType = assetRes.headers.get("content-type") ?? "";
    if (!contentType.includes("text/html")) return assetRes;

    // HTML gets a per-request CSP nonce header instead of the static
    // <meta> tag baked into the asset. Cloudflare stamps its edge-injected
    // JavaScript Detections <script> tags with the nonce it parses out of
    // this header — the only way JSD (rotating inline body, unhashable)
    // and a CSP without 'unsafe-inline' can coexist. See src/csp.ts.
    const nonce = generateNonce();
    const isLegalPage = url.pathname === "/privacy" || url.pathname === "/terms";
    const policy = isLegalPage ? legalCsp(nonce) : appCsp(nonce);

    const rewritten = new HTMLRewriter()
      .on('meta[http-equiv="Content-Security-Policy"]', {
        element(el) {
          el.remove();
        },
      })
      .on("script", {
        element(el) {
          el.setAttribute("nonce", nonce);
        },
      })
      .transform(assetRes);

    const headers = new Headers(rewritten.headers);
    headers.set("Content-Security-Policy", policy);
    // A cached HTML doc carries a fixed nonce; a later request's JSD
    // injection would use a different one and be blocked. no-store on the
    // small shell keeps body, header and injected script in agreement.
    // The hashed /assets/* bundles are non-HTML and keep caching.
    headers.set("Cache-Control", "no-store");
    return new Response(rewritten.body, {
      status: rewritten.status,
      statusText: rewritten.statusText,
      headers,
    });
  },
} satisfies ExportedHandler<Env>;
