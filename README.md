`github-embedder-surrealdb` is a read-only GitHub knowledge-base mirror stored as a graph in SurrealDB and exposed as a Bun CLI. It mirrors discussion artifacts of one or more GitHub repositories — issues, PRs, discussions, comments, and PR-referenced commits — so an AI agent can semantically retrieve project memory about what has already been discussed, decided, or attempted.

## Testing

### Running tests

```sh
# Run the full test suite
bun test

# Run a single test file
bun test src/ingest/crossrefs.test.ts
```

### File location convention

Tests are co-located with their source files as `*.test.ts`. There is no separate `tests/` directory. Each module owns its test alongside it (e.g., `src/ingest/crossrefs.ts` is tested by `src/ingest/crossrefs.test.ts`).

### Three tiers

**Unit** — Pure logic with no I/O. Tested with plain `bun test`. No database, no network. Example: `extractReferences` in `src/ingest/crossrefs.test.ts`.

**Integration** — Tests that exercise real infrastructure using in-memory substitutes. SurrealDB tests use `withTestDb` (in-memory `mem://` engine via `@surrealdb/wasm`). GitHub API calls are intercepted with `mock.module` from `bun:test`. These run in CI alongside unit tests.

**Smoke** — Manual checks against live external services (SurrealDB on localhost, Ollama, GitHub API). Run via `bun run smoke:surreal`, `bun run smoke:ollama`, `bun run smoke:github`. Require a real `GITHUB_TOKEN` and running services. Never included in the `bun test` chain.

### Mocking the GitHub client

Use `mock.module` from `bun:test` to intercept `src/clients/github.ts` before importing the module under test:

```typescript
import { mock } from "bun:test";

mock.module("../../clients/github.ts", () => ({
  fetchIssues: async () => [{ number: 1, title: "Test issue", body: "" }],
}));

// Import after mock is registered
const { ingestIssues } = await import("./issues.ts");
```

### Using `withTestDb`

`withTestDb` spins up a fresh in-memory SurrealDB instance with the full schema applied, runs your callback, then tears it down:

```typescript
import { withTestDb } from "../test_utils/with_test_db.ts";

it("persists and retrieves a repo", async () => {
  const name = await withTestDb(async (db) => {
    await db.query(`CREATE repo:test CONTENT { name: "my-repo", ... }`);
    const [[row]] = await db.query<[[{ name: string }]]>("SELECT name FROM repo:test");
    return row.name;
  });
  expect(name).toBe("my-repo");
});
```

Each `withTestDb` call is isolated — data does not persist across calls.

### Recording fixtures

For GraphQL responses from GitHub, capture a real API response once using `bun run smoke:github` or a `curl`/`gh api` call, then save the JSON to a `fixtures/` directory next to the test. Load it with `readFileSync` and return it from `mock.module`. This keeps tests fast and deterministic without requiring a live token. Re-record when the query shape changes.
