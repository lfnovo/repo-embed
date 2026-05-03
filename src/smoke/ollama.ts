import { config } from "../config.ts";
import { embedMany } from "../clients/ollama.ts";

try {
  const embeddings = await embedMany(["hello world"]);
  const vector = embeddings[0];

  console.log("✓ Ollama embedder reachable.");
  console.log(`  url=${config.OLLAMA_URL}/api/embed`);
  console.log(`  model=${config.OLLAMA_EMBED_MODEL} dim=${vector.length}`);
  process.exit(0);
} catch (err) {
  console.error("✗ Ollama smoke test failed.");
  console.error(err);
  process.exit(1);
}
