// Same-origin image fetch used by the PDF exporter. html2canvas can only
// draw cross-origin images that opt into CORS; many image hosts don't, so
// the export used to silently drop them. Fetching through the Worker gives
// the renderer same-origin bytes regardless of the host's CORS headers.
//
// This is deliberately not a general-purpose open proxy: HTTPS only, no
// userinfo / non-standard ports / IP literals / local names, image content
// only, redirects re-validated, 10 MB cap, and a short timeout. Requests
// from a cross-site browser context are rejected. DNS rebinding cannot be
// fully ruled out from a Worker, but Cloudflare's egress does not reach
// private network ranges.

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const FETCH_TIMEOUT_MS = 10_000;

function isIpv4Literal(host: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host);
}

function parseAllowedImageUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  if (url.port && url.port !== "443") return null;
  const host = url.hostname.toLowerCase();
  if (!host.includes(".") || host.startsWith("[") || host.includes(":") || isIpv4Literal(host)) return null;
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".home.arpa") ||
    host === "metadata.google.internal"
  ) {
    return null;
  }
  return url;
}

function imageContentType(contentTypeHeader: string | null, pathname: string): string | null {
  const contentType = (contentTypeHeader ?? "").split(";")[0]!.trim().toLowerCase();
  if (contentType.startsWith("image/")) return contentType;
  if (contentType && contentType !== "application/octet-stream") return null;
  const ext = /\.([a-z0-9]+)$/i.exec(pathname)?.[1]?.toLowerCase();
  const byExtension: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    avif: "image/avif",
    bmp: "image/bmp",
  };
  return ext ? (byExtension[ext] ?? null) : null;
}

async function fetchFollowingSafeRedirects(start: URL): Promise<Response> {
  let current = start;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(current.toString(), {
        redirect: "manual",
        signal: controller.signal,
        headers: { Accept: "image/*", "User-Agent": "MarkdownEditorImageProxy/1.0" },
      });
    } finally {
      clearTimeout(timer);
    }
    if (res.status < 300 || res.status >= 400) return res;
    const location = res.headers.get("Location");
    if (!location) throw new Error("redirect without location");
    const next = parseAllowedImageUrl(new URL(location, current).toString());
    if (!next) throw new Error("unsafe redirect");
    current = next;
  }
  throw new Error("too many redirects");
}

export async function handleImageProxy(request: Request): Promise<Response> {
  // A cross-site browser request must not be able to use this as a proxy.
  // (A non-browser client can omit/spoof this; the URL and size guards are
  // the primary defense, this just stops drive-by web abuse.)
  const site = request.headers.get("Sec-Fetch-Site");
  if (site && site !== "same-origin") return new Response("Forbidden", { status: 403 });

  const raw = new URL(request.url).searchParams.get("url") ?? "";
  const target = parseAllowedImageUrl(raw);
  if (!target) return new Response("Invalid image URL", { status: 400 });

  let upstream: Response;
  try {
    upstream = await fetchFollowingSafeRedirects(target);
  } catch {
    return new Response("Couldn't fetch the image.", { status: 502 });
  }
  if (!upstream.ok) return new Response("Couldn't fetch the image.", { status: 502 });

  const contentType = imageContentType(upstream.headers.get("Content-Type"), target.pathname);
  if (!contentType) return new Response("Not an image.", { status: 502 });

  const declaredLength = Number(upstream.headers.get("Content-Length") ?? "");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_IMAGE_BYTES) {
    return new Response("Image is too large.", { status: 413 });
  }
  const bytes = await upstream.arrayBuffer();
  if (bytes.byteLength > MAX_IMAGE_BYTES) return new Response("Image is too large.", { status: 413 });

  return new Response(bytes, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(bytes.byteLength),
      "Cache-Control": "public, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
