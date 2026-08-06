const MAX_TOTAL_BYTES = 3 * 1024 * 1024 * 1024; // 3 GiB — stays well under R2's 10 GB/mo free tier
const RATE_LIMIT_COUNT = 20;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const STORAGE_KEY = "totalBytes";

// Single global instance (see idFromName("global") in images.js). Every
// upload has to clear this gate first, so it's the one place that
// guarantees the R2 bucket never grows past MAX_TOTAL_BYTES and that no
// single IP can hammer it — regardless of whether the request came from the
// editor's UI or a script hitting POST /api/images directly, since there's
// no auth in front of this app.
export class ImageQuota {
  constructor(state) {
    this.state = state;
    this.totalBytes = 0;
    this.uploadLog = new Map(); // ip -> timestamps[]
    this.state.blockConcurrencyWhile(async () => {
      this.totalBytes = (await this.state.storage.get(STORAGE_KEY)) || 0;
    });
  }

  async fetch(request) {
    const { ip, bytes } = await request.json();

    if (this.totalBytes + bytes > MAX_TOTAL_BYTES) {
      return Response.json({ ok: false, reason: "quota_exceeded" });
    }

    const now = Date.now();
    const timestamps = (this.uploadLog.get(ip) || []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
    if (timestamps.length >= RATE_LIMIT_COUNT) {
      return Response.json({ ok: false, reason: "rate_limited" });
    }

    timestamps.push(now);
    this.uploadLog.set(ip, timestamps);
    this.totalBytes += bytes;
    await this.state.storage.put(STORAGE_KEY, this.totalBytes);
    return Response.json({ ok: true });
  }
}
