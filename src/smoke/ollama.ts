import { config } from "../config.ts";

const url = `${config.OLLAMA_URL}/api/embed`;
const body = {
  model: config.OLLAMA_EMBED_MODEL,
  input: "hello world",
};

try {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HTTP ${response.status}: ${text}`);
  }

  const data = (await response.json()) as { embeddings?: number[][] };
  const vector = data.embeddings?.[0];
  if (!Array.isArray(vector)) {
    throw new Error("Response missing `embeddings[0]` array.");
  }
  if (vector.length !== config.EMBED_DIM) {
    throw new Error(
      `Expected ${config.EMBED_DIM}-dim vector, got ${vector.length}-dim. ` +
        `Model '${config.OLLAMA_EMBED_MODEL}' produces a different dimension.`,
    );
  }

  console.log("✓ Ollama embedder reachable.");
  console.log(`  url=${url}`);
  console.log(
    `  model=${config.OLLAMA_EMBED_MODEL} dim=${vector.length}`,
  );
  process.exit(0);
} catch (err) {
  console.error("✗ Ollama smoke test failed.");
  console.error(err);
  process.exit(1);
}
