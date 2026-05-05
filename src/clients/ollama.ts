import { config } from "../config.ts";

const MIN_FALLBACK_CHARS = 256;

function isContextLengthError(err: unknown): boolean {
  return err instanceof Error && /context length/i.test(err.message);
}

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

export async function embedWithFallback(text: string): Promise<number[]> {
  let len = text.length;
  while (true) {
    try {
      const result = await embedMany([text.slice(0, len)]);
      return result[0];
    } catch (err) {
      if (!isContextLengthError(err)) throw err;
      if (len <= MIN_FALLBACK_CHARS) {
        throw new Error(
          "could not embed at any length: text exceeds context even at minimum",
        );
      }
      len = Math.max(MIN_FALLBACK_CHARS, Math.floor(len / 2));
    }
  }
}
