import { z } from "zod";

const EnvSchema = z.object({
  GITHUB_TOKEN: z.string().optional(),
  SURREAL_URL: z.string().url().default("http://localhost:8018/rpc"),
  SURREAL_NS: z.string().default("githubembed"),
  SURREAL_DB: z.string().default("main"),
  SURREAL_USER: z.string().default("root"),
  SURREAL_PASS: z.string().default("root"),
  OLLAMA_URL: z.string().url().default("http://localhost:11434"),
  OLLAMA_EMBED_MODEL: z.string().default("nomic-embed-text"),
  EMBED_DIM: z.coerce.number().int().positive().default(768),
});

const result = EnvSchema.safeParse(process.env);
if (!result.success) {
  console.error("Invalid environment configuration:");
  console.error(result.error.issues);
  process.exit(1);
}

export const config = result.data;

export function requireGithubToken(): string {
  if (!config.GITHUB_TOKEN) {
    console.error(
      "GITHUB_TOKEN is required for this command. Set it in .env.",
    );
    process.exit(1);
  }
  return config.GITHUB_TOKEN;
}
