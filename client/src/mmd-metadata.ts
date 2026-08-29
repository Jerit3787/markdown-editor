export interface MetadataPair {
  key: string;
  value: string;
}

const METADATA_LINE_RE = /^([A-Za-z][\w \t-]*):[ \t]+(.*)$/;
const CONTINUATION_LINE_RE = /^[ \t]+(.*)$/;

// Metadata must be the first thing in the document: a run of "Key: Value" lines
// (any key name — this app doesn't restrict to a known set), each optionally
// followed by indented continuation lines that extend the previous value
// (joined with a space), terminated by the first blank line (consumed as the
// separator) or the first non-matching, non-blank line (left in body). If line
// 1 doesn't match, there is no metadata block at all.
export function parseMetadataBlock(text: string): { metadata: MetadataPair[]; body: string } {
  const lines = text.split("\n");
  const metadata: MetadataPair[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === "") {
      i++;
      break;
    }
    const m = METADATA_LINE_RE.exec(line);
    if (!m) break;
    let value = m[2]!;
    let j = i + 1;
    while (j < lines.length && lines[j]!.trim() !== "" && CONTINUATION_LINE_RE.test(lines[j]!)) {
      value += ` ${lines[j]!.trim()}`;
      j++;
    }
    metadata.push({ key: m[1]!.trim(), value });
    i = j;
  }
  if (metadata.length === 0) return { metadata: [], body: text };
  return { metadata, body: lines.slice(i).join("\n") };
}

// Inverse of parseMetadataBlock — a real "Key: Value\n" block, one line per
// pair (continuation lines are never re-derived; a value is written back out
// as a single line even if it was originally read from a continuation),
// followed by a blank line, prepended to body. Returns body unchanged if
// metadata is empty.
export function serializeMetadataBlock(metadata: MetadataPair[], body: string): string {
  if (metadata.length === 0) return body;
  const block = metadata.map((m) => `${m.key}: ${m.value}`).join("\n");
  return `${block}\n\n${body}`;
}
