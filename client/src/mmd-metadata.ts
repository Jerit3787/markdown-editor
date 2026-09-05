export interface MetadataPair {
  key: string;
  value: string;
}

const METADATA_LINE_RE = /^([A-Za-z][\w \t-]*):[ \t]+(.*)$/;
const CONTINUATION_LINE_RE = /^[ \t]+(.*)$/;
const COMMENT_OPEN = "<!--";
const COMMENT_CLOSE = "-->";
// HTML's comment-parsing state machine recognizes a second, legacy closing
// sequence too ("comment end bang state", kept for pre-HTML5 compatibility)
// — a value containing "--!>" would leak the comment open just as surely
// as one containing "-->" if only the latter were escaped.
const COMMENT_CLOSE_BANG = "--!>";

// Key and value are both free text with no character restrictions (see the
// Doc Info/Edit UI) — either could legitimately contain the literal
// substring "-->" or "--!>", either of which would otherwise close the
// wrapping HTML comment early and leak everything after it (including the
// rest of the metadata and the real body) as visible text. Splitting the
// dashes from the rest of each sequence with a zero-width space
// neutralizes both invisibly, in both directions, without rejecting or
// visibly mangling the field's content. A key that needed escaping will no
// longer match METADATA_LINE_RE's own character class on the way back in
// and so won't round-trip as a parsed field — an acceptable loss, since
// such a key was never a well-formed metadata key to begin with; what
// matters is that the comment itself never breaks open. The two escaped
// forms can't appear as substrings of one another, so escaping/unescaping
// them in either order is safe.
const ZERO_WIDTH_SPACE = "\u200B";
function escapeCommentClose(text: string): string {
  return text.split(COMMENT_CLOSE).join(`--${ZERO_WIDTH_SPACE}>`).split(COMMENT_CLOSE_BANG).join(`--!${ZERO_WIDTH_SPACE}>`);
}
function unescapeCommentClose(text: string): string {
  return text.split(`--!${ZERO_WIDTH_SPACE}>`).join(COMMENT_CLOSE_BANG).split(`--${ZERO_WIDTH_SPACE}>`).join(COMMENT_CLOSE);
}

// Shared by both the new wrapped format and the legacy bare format: a run
// of "Key: Value" lines, each optionally followed by indented continuation
// lines that extend the previous value (joined with a space), stopping at
// the first blank or non-matching line. `consumed` is the index (within
// `lines`) of whichever line stopped the scan — a blank line or a
// non-matching line — so the caller can decide what to do with it; it is
// only meaningful when `metadata.length > 0`.
function scanMetadataLines(lines: string[]): { metadata: MetadataPair[]; consumed: number } {
  const metadata: MetadataPair[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === "") break;
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
  return { metadata, consumed: i };
}

// If `lines[from]` is blank, it's the separator between the metadata block
// and the body — skip past it. Otherwise the block ended because it hit
// non-matching content directly (no separator), which belongs to the body
// and must be preserved.
function skipSeparator(lines: string[], from: number): number {
  return lines[from] === "" ? from + 1 : from;
}

// Metadata must be the very first thing in the document, in one of two
// forms: the new comment-wrapped form (`<!--`, one "Key: Value" line per
// field, `-->`), or — for documents already published before this format
// existed — a bare run of "Key: Value" lines with no comment wrapper at
// all. If neither is present, there is no metadata block.
export function parseMetadataBlock(text: string): { metadata: MetadataPair[]; body: string } {
  const lines = text.split("\n");

  if (lines[0] === COMMENT_OPEN) {
    const closeIndex = lines.indexOf(COMMENT_CLOSE, 1);
    if (closeIndex !== -1) {
      const { metadata } = scanMetadataLines(lines.slice(1, closeIndex));
      if (metadata.length > 0) {
        const unescaped = metadata.map((m) => ({ key: m.key, value: unescapeCommentClose(m.value) }));
        const bodyStart = skipSeparator(lines, closeIndex + 1);
        return { metadata: unescaped, body: lines.slice(bodyStart).join("\n") };
      }
    }
  }

  const { metadata, consumed } = scanMetadataLines(lines);
  if (metadata.length === 0) return { metadata: [], body: text };
  const bodyStart = skipSeparator(lines, consumed);
  return { metadata, body: lines.slice(bodyStart).join("\n") };
}

// Inverse of parseMetadataBlock — always writes the new comment-wrapped
// form (continuation lines are never re-derived; a value is written back
// out as a single line even if it was originally read from a
// continuation), followed by a blank line, prepended to body. Returns body
// unchanged if metadata is empty.
export function serializeMetadataBlock(metadata: MetadataPair[], body: string): string {
  if (metadata.length === 0) return body;
  const block = metadata.map((m) => `${escapeCommentClose(m.key)}: ${escapeCommentClose(m.value)}`).join("\n");
  return `${COMMENT_OPEN}\n${block}\n${COMMENT_CLOSE}\n\n${body}`;
}
