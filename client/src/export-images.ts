// Inlines cross-origin images into a cloned preview tree before PDF
// rendering. html2canvas can only draw a cross-origin image when the host
// opts into CORS; the Worker's /api/image-proxy supplies same-origin bytes
// for hosts that don't. Only absolute http(s) URLs are touched — data,
// blob, and same-origin images already render fine.

export interface InlineRemoteImagesResult {
  attempted: number;
  failed: number;
}

type FetchLike = (input: string) => Promise<Response>;

async function blobToDataUrl(blob: Blob, contentType: string): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return `data:${blob.type || contentType};base64,${btoa(binary)}`;
}

export async function inlineRemoteImages(root: ParentNode, fetchImpl: FetchLike = fetch): Promise<InlineRemoteImagesResult> {
  const images = Array.from(root.querySelectorAll("img"));
  const pageUrl = typeof location !== "undefined" ? location.href : undefined;
  const pageOrigin = pageUrl ? new URL(pageUrl).origin : undefined;
  let attempted = 0;
  let failed = 0;

  for (const image of images) {
    const source = image.getAttribute("src") ?? "";
    if (!/^https?:\/\//i.test(source)) continue;
    let parsed: URL;
    try {
      parsed = new URL(source);
    } catch {
      continue;
    }
    if (pageOrigin && parsed.origin === pageOrigin) continue;

    attempted++;
    try {
      const res = await fetchImpl(`/api/image-proxy?url=${encodeURIComponent(source)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const contentType = (res.headers.get("Content-Type") || blob.type).split(";")[0]!.trim().toLowerCase();
      if (!contentType.startsWith("image/")) throw new Error("Not an image");
      image.setAttribute("src", await blobToDataUrl(blob, contentType));
    } catch {
      // Leave the original URL in place; html2canvas will skip it exactly
      // as it did before, and the caller can warn about the count.
      failed++;
    }
  }

  return { attempted, failed };
}
