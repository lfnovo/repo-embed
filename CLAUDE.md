# CLAUDE.md

Guidance for Claude (and harny) when working in this repo.

## What this is

`github-embedder-surrealdb` is a read-only GitHub knowledge-base mirror, stored as a graph in SurrealDB and exposed as a Bun CLI. It mirrors **discussion artifacts** of one or more GitHub repos — issues, PRs, discussions, comments, and PR-referenced commits — so an AI agent can semantically retrieve project memory ("what has already been discussed, decided, or attempted here").

Primary consumer is **AI agents** invoked via Claude Code hooks. Cold-start latency is a first-class concern.

For the full vision (purpose, scope, graph model, sync strategy, open questions): see `VISION.md`.

## Read these before changing anything

1. **`ARCHITECTURE.md`** — accumulated architectural principles. The principle store. Anything that touches lifecycle, edges, ingest stages, embedding, or failure handling has a relevant principle there. Not optional.
2. **`VISION.md`** — the product vision. What the CLI does, what's in/out of scope, why the data model looks the way it does.
3. **The closest existing implementation.** The codebase favors single-file modules per concept (`src/clients/<x>.ts`, `src/ingest/<entity>.ts`, `src/commands/<name>.ts`). Mirror what's already there before inventing patterns.

## Stack

- **Runtime**: Bun (single binary; `bun build --compile` is the distribution target).
- **Language**: TypeScript, `strict: true`, `moduleResolution: "bundler"`, no emit (`bun run` direct).
- **Storage**: SurrealDB on `localhost:8018` (namespace `githubembed`, db `main`, root/root in dev).
- **GitHub API**: `@octokit/graphql` v9. **GraphQL only**, no REST mixing.
- **Embeddings**: Ollama on `localhost:11434`, model `nomic-embed-text`, 768-dim. Hard schema decision.
- **Validation**: Zod (env, GraphQL payloads).

No CLI framework, no logger, no HTTP client beyond `fetch`. Per the "defer until it hurts" principle in `ARCHITECTURE.md`.

## Repo layout

```
src/
  index.ts              # argv dispatcher (hand-rolled)
  config.ts             # zod-validated env loader
  clients/              # reusable connections (surreal, ollama, github)
  commands/             # one file per `tool <name>` command
  ingest/               # one file per entity (issue, pull_request, ...) + shared helpers
  smoke/                # manual external-infra reachability checks (NOT bun test)
  test_utils/           # in-memory test helpers
schemas.surrealql       # full schema, idempotent, never destructive
ARCHITECTURE.md         # principle store
VISION.md               # product vision
QUERIES.md              # documented SurrealQL examples (lands with #12)
README.md               # project overview + Testing conventions
```

## Validator

The canonical validator for any change:

```
bun run typecheck && bun test
```

Both must exit 0. CI (when it exists) will run the same.

Smoke tests (`bun run smoke:*`) are **manual** — they require live SurrealDB, Ollama, and `GITHUB_TOKEN`. Don't run them inside isolated worktrees and don't add them to the validator chain.

## Conventions

- **Co-located tests**: `*.test.ts` next to the source file. No separate `tests/` tree.
- **In-memory infra in tests**: SurrealDB tests use `withTestDb` (in-memory `mem://`); GitHub calls are mocked via `mock.module` from `bun:test`. Don't connect to localhost SurrealDB or hit live GitHub from tests.
- **One file per concept** until it crosses ~300 lines. Then split.
- **Logs**: `console.log` / `console.error` with `✓` / `✗` / `!` prefixes. No logger.
- **Read-style commands ship `--json` from day one** (per `ARCHITECTURE.md`). Action commands (`add`, `sync`, `embed`, etc.) emit human progress text only.
- **Schema applies are non-destructive**: `IF NOT EXISTS` everywhere in `schemas.surrealql`. Real data lives there; do not add `REMOVE TABLE` statements.

## Where the gotchas are

- **SurrealDB v2 client uses `authentication: { username, password }`** (not `auth`). The shape changed from v1; existing code uses the right one — mirror it. Verify at `node_modules/surrealdb/dist/surrealdb.d.ts` if in doubt.
- **`references` is a reserved word in SurrealQL** — the cross-reference edge table is `references_ref` for that reason. Don't rename it back.
- **GraphQL author union is mandatory**: every author site must use `... on User { ... } ... on Bot { ... }` so `__typename` is available for `isBot()` (per the bot detection principle).
- **`embedded_content_hash` vs `content_hash`**: `content_hash` is computed on persist; `embedded_content_hash` is set on embed. The trigger to re-embed is `content_hash != embedded_content_hash`. Don't conflate them.
- **The `paginate` helper injects a variable named `cursor`.** Every paginated GraphQL query MUST declare `$cursor: String` and use it in the `after:` argument. Variable name mismatch is silent — GraphQL ignores undeclared vars and starts every page from the first.

### SurrealDB v2 + WASM (in-memory mode) gotchas

The in-memory engine used by `withTestDb` is `@surrealdb/wasm`. It diverges from the documented patterns in subtle ways. Check these before assuming an API works:

- **`mem://` requires `namespace` and `database`** in `connect()` opts, even though no auth is needed. Skipping them throws `Specify a namespace to use`.
- **`engines` belong in the `Surreal` constructor (`DriverOptions`), NOT in `ConnectOptions`.** The right shape is `new Surreal({ engines: { ...createRemoteEngines(), ...createWasmEngines() } })`. Putting engines in `connect()` silently does nothing.
- **`type::thing(table, id)` is unsupported in WASM.** Use `new StringRecordId("table:id")` from the `surrealdb` package and pass it as a query param. Round-trip: `String(row.id)` → `new StringRecordId(...)` to reuse a record id.
- **`option<string>` fields reject JS `null`** at the SurrealQL boundary. To set a nullable field to none, inline the literal `NONE` in the query string and conditionally spread the param object — don't bind `null` to a `$param`. Pattern:
  ```ts
  const fieldSql = parsed.field !== null ? "$field" : "NONE";
  await db.query(`UPDATE $id SET field = ${fieldSql}`, {
    id, ...(parsed.field !== null ? { field: parsed.field } : {})
  });
  ```
  Issue #22 will extract this into a helper once enough sites have accumulated.
- **`field IN $array` returns 0 silently when the array contains `StringRecordId` values.** No error, just an empty result set — easy to mistake for "no matches." Use `$array CONTAINS field` instead. This bit production once (issue #39 / PR #41); unit tests with in-memory SurrealDB had different semantics and didn't catch it.
- **`DEFINE TABLE ... OVERWRITE` for `TYPE RELATION` is not supported by `@surrealdb/wasm`.** Edge tables can only be defined with `IF NOT EXISTS`; widening their `FROM`/`TO` after creation is not possible without dropping. If you need wider FROM/TO mid-project, document the limitation inline and skip the wider scope (see `references_ref` in `schemas.surrealql`).
- **JS client returns `undefined` (not `null`) for NONE fields on read.** Tests should use loose `== null` (catches both) rather than `=== null`, especially when comparing query result rows.
- **`ORDER BY` on a non-indexed field may be rejected** by `@surrealdb/wasm`. If sorting matters and the field isn't indexed, sort in JS after the query, or add an index.

When in doubt about a SurrealDB API shape, read the type definitions directly:
```bash
grep -E "^\s*(connect|query|close)" node_modules/surrealdb/dist/surrealdb.d.ts
```

## Notes for harny prompts

When writing prompts for harny dispatch (or any subagent doing implementation):

- **Code review for try/catch scope**: validators check that error commands exit 1, but they don't catch a `try` that's wrapped too widely. When a prompt asks for try/catch, also instruct: "write a test that throws inside the protected region (e.g., make the inner function throw on purpose) and verify the real error surfaces, not the catch's fallback message."
- **Verify SDK shapes before asserting them in the prompt.** Past harny runs caught factual errors in architect prompts about SurrealDB and Ollama APIs. Before specifying "the call signature is X," run `Read node_modules/<pkg>/dist/<pkg>.d.ts` (or grep for the symbol) to confirm.
- **Don't pre-decompose tasks the planner could merge.** A 2-task split where t2 strictly depends on t1 buys no parallelism and adds two extra phase transitions. Let the planner own the split.
- **Mock-vs-real engine fidelity:** unit tests use in-memory `@surrealdb/wasm` and mocked Ollama; both diverge from production engines in ways that have already cost two production bugs (issue #11 context-window, issue #39 IN-with-records). When a prompt covers a SurrealDB query that uses an array of records, an unusual operator (`<|N,COSINE|>`, `IN`, `INSIDE`), or any embedding call with realistic input length, **require an explicit live-engine probe**: "After tests pass, the dev must run the new query against a live SurrealDB v2 with seeded data and verify expected cardinality, OR run the new embed call against a real Ollama with the longest realistic input from the corpus." Document the probe result in the PR body.
- **Validators must re-execute spec-claimed verifications.** If a prompt asks the dev to "grep across `src/ingest/` to verify X," the validator must independently re-run the grep and check the result. Trusting the planner's "I confirmed in pre-planning read" leaves a hole — the verification can drop through three layers without anyone actually doing it (issue #9 example).
- **Manual-infra ACs (live SurrealDB / Ollama / GITHUB_TOKEN) must NEVER be in-validator scope.** The validator runs in an isolated worktree with no live services — any AC of the form "run `tool sync --live`" or "verify embed against real Ollama" will mark the validator as `blocked` (terminal — the harness does NOT retry on blocked) and dangle the run as `failed` even when prior tasks committed clean, shippable work. Specs must move such checks to a `## Test plan` checkbox in the PR body labeled "to be run after merge" or "manual verification" — out of the validator's acceptance-criteria block entirely. Pattern observed across review-batch-3 (#22, #15) where 2/6 runs ended `failed` for this reason alone and required architect-side commit + push to ship.
- **Dev-initiated 2nd turns after a planned task's commit dangle without validation.** If a developer phase wraps up t1 with `committing/1`, then takes another `developer/1` turn (often to add follow-up improvements not in the planner's task list), the harness has no commit path for the new work — it sits uncommitted in the worktree and the run terminates `failed`. Two ways to avoid: (a) the design skill pre-decomposes all anticipated scope into explicit planned tasks so the dev never goes "off-plan"; (b) the dev prompt instructs "stop after the planned task's commit even if you see improvements — file them as follow-up issues." Observed in #16 where the unplanned 2nd turn produced 80% of the PR's value but the harness lost it.

## Git / PR

- **Conventional commits** (`feat:`, `fix:`, `docs:`, `chore:`, `ci:`, `refactor:`).
- **Never mention Claude or Claude Code** in commit messages or PR descriptions.
- **PR body must include `Closes #N`** so the issue auto-closes on merge.
- Squash-merge to `main`, delete branch.

## Issue pipeline

Issues flow `triage → design → develop → merged`. Each stage is owned by a corresponding skill in the `harny-dev` plugin. By the time an issue is `ready`, the body contains the full implementation spec — execution should not require re-architecting. If you find yourself making architectural choices during develop, stop and ask whether the issue needs to go back to design.
