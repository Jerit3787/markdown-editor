const MIME_EXT = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
};

// SVG is intentionally excluded — it can carry inline <script> and would
// execute in the page's own origin when embedded/viewed directly.
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const KEY_PATTERN = /^img\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|gif|webp|avif)$/;

export async function handleImageUpload(request, env) {
  const contentType = (request.headers.get("Content-Type") || "").split(";")[0].trim();
  const ext = MIME_EXT[contentType];
  if (!ext) return new Response("Unsupported image type", { status: 415 });

  const body = await request.arrayBuffer();
  if (body.byteLength === 0) return new Response("Empty upload", { status: 400 });
  if (body.byteLength > MAX_IMAGE_BYTES) return new Response("Image too large (max 8MB)", { status: 413 });

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const quotaStub = env.IMAGE_QUOTA.get(env.IMAGE_QUOTA.idFromName("global"));
  const quota = await quotaStub
    .fetch("https://internal/reserve", {
      method: "POST",
      body: JSON.stringify({ ip, bytes: body.byteLength }),
    })
    .then((r) => r.json());

  if (!quota.ok) {
    if (quota.reason === "rate_limited") {
      return new Response("Too many uploads — try again in a bit.", { status: 429 });
    }
    return new Response("Image storage is full for now.", { status: 507 });
  }

  const key = `img/${crypto.randomUUID()}.${ext}`;
  await env.IMAGES.put(key, body, { httpMetadata: { contentType } });
  return Response.json({ url: `/api/images/${key}` });
}

export async function handleImageGet(request, env, key) {
  if (!KEY_PATTERN.test(key)) return new Response("Not found", { status: 404 });

  const cache = caches.default;
  const cached = await cache.match(request);
  if (cached) return cached;

  const object = await env.IMAGES.get(key);
  if (!object) return new Response("Not found", { status: 404 });

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("Cache-Control", "public, max-age=31536000, immutable");

  const response = new Response(object.body, { headers });
  await cache.put(request, response.clone());
  return response;
}
