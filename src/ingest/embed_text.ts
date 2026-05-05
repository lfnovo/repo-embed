export function embedText(node: { title?: string | null; body: string | null }): string {
  const title = node.title ?? "";
  const body = (node.body ?? "").replace(/\r\n/g, "\n");
  return title ? `${title}\n\n${body}` : body;
}
