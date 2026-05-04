// Hard cap to stay inside `nomic-embed-text`'s 8192-token context window.
// 6000 chars is the empirically-determined safe figure for this corpus:
// the densest item in lfnovo/esperanto (a 7995-char comment) exceeds the
// context at 7000+ chars but works at ≤ 6500. We pick 6000 for headroom.
//
// At 8192 tokens / 6000 chars ≈ 1.4 tokens/char, this is conservative for
// most real-world text. Items longer than the cap lose their tail in the
// embedding only — the full body is preserved on the row for retrieval-
// time access.
//
// Future, when long-item retrieval quality matters: chunk into multiple
// embeddings per item (open in VISION).
export const EMBED_TEXT_MAX_CHARS = 6000;

export function embedText(node: { title?: string | null; body: string | null }): string {
  const title = node.title ?? "";
  const body = (node.body ?? "").replace(/\r\n/g, "\n");
  const full = title ? `${title}\n\n${body}` : body;
  return full.length > EMBED_TEXT_MAX_CHARS ? full.slice(0, EMBED_TEXT_MAX_CHARS) : full;
}
