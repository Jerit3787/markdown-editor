// Short reference name instead of the full base64 blob living inline in
// the editor text — e.g. "screenshot.png" or "screenshot-2.png" if that
// name's taken. The preview/export resolve it back to the real data URI
// (see the marked image renderer in app.ts's updatePreview and
// resolveImageRefs).
export function imageKey(filename: string, images: Record<string, string>): string {
  const match = (filename || "image").match(/^(.*?)(\.[^.]+)?$/);
  // This key gets embedded directly into markdown as ![alt](key) — an
  // unescaped space in a link destination isn't valid CommonMark/GFM
  // syntax, so marked silently refuses to parse it as an image at all
  // (falls back to literal text) whenever a pasted filename has a
  // space in it, which most screenshot/download filenames do. Periods
  // are completely safe in a link destination and don't need
  // stripping (a macOS screenshot's "5.22.26 PM" time portion relies
  // on them staying intact to still look like a filename).
  const base =
    (match?.[1] || "image")
      .trim()
      .replace(/\s+/g, "-")
      .replace(/[^a-zA-Z0-9-_.]+/g, "") || "image";
  const ext = match?.[2] || ".png";
  let key = `${base}${ext}`;
  let n = 2;
  while (images[key]) {
    key = `${base}-${n}${ext}`;
    n++;
  }
  return key;
}
