// Conservative cap to stay inside `nomic-embed-text`'s 8192-token context.
// At ~4 chars/token average for prose, 24000 chars ≈ 6000 tokens with headroom
// for code-heavy or symbol-heavy content. Items longer than this lose their
// tail in the embedding; the full body is still preserved on the row for
// retrieval-time access.
export const EMBED_TEXT_MAX_CHARS = 24000;

export function embedText(node: { title?: string | null; body: string | null }): string {
  const title = node.title ?? "";
  const body = (node.body ?? "").replace(/\r\n/g, "\n");
  const full = title ? `${title}\n\n${body}` : body;
  return full.length > EMBED_TEXT_MAX_CHARS ? full.slice(0, EMBED_TEXT_MAX_CHARS) : full;
}
