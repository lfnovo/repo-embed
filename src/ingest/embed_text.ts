// Hard cap to stay inside `nomic-embed-text`'s 8192-token context window.
// 8000 chars is the safe-regardless-of-tokenization figure: even at
// 1 char per token (worst case for dense code, non-Latin scripts, or
// heavily-tokenized symbols), this stays under the 8192-token context.
// Items longer than this lose their tail in the embedding only — the
// full body remains on the row for retrieval-time access.
//
// (The earlier 24000-char value, derived from a 4-chars-per-token
// English-prose assumption, failed end-to-end on lfnovo/esperanto when
// a PR body's tokenization came out far denser than the heuristic.)
export const EMBED_TEXT_MAX_CHARS = 8000;

export function embedText(node: { title?: string | null; body: string | null }): string {
  const title = node.title ?? "";
  const body = (node.body ?? "").replace(/\r\n/g, "\n");
  const full = title ? `${title}\n\n${body}` : body;
  return full.length > EMBED_TEXT_MAX_CHARS ? full.slice(0, EMBED_TEXT_MAX_CHARS) : full;
}
