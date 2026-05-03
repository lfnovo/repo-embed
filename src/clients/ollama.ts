import { config } from "../config.ts";

export async function embedMany(texts: string[]): Promise<number[][]> {
  const url = `${config.OLLAMA_URL}/api/embed`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: config.OLLAMA_EMBED_MODEL, input: texts }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HTTP ${response.status}: ${text}`);
  }

  const data = (await response.json()) as { embeddings?: number[][] };
  const embeddings = data.embeddings;
  if (!Array.isArray(embeddings)) {
    throw new Error("Response missing `embeddings` array.");
  }

  for (const vector of embeddings) {
    if (vector.length !== config.EMBED_DIM) {
      throw new Error(
        `Model '${config.OLLAMA_EMBED_MODEL}' produced ${vector.length}-dim vector, expected ${config.EMBED_DIM}.`,
      );
    }
  }

  return embeddings;
}

export async function embed(text: string): Promise<number[]> {
  const result = await embedMany([text]);
  return result[0];
}
