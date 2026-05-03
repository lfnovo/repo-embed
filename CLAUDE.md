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

## Git / PR

- **Conventional commits** (`feat:`, `fix:`, `docs:`, `chore:`, `ci:`, `refactor:`).
- **Never mention Claude or Claude Code** in commit messages or PR descriptions.
- **PR body must include `Closes #N`** so the issue auto-closes on merge.
- Squash-merge to `main`, delete branch.

## Issue pipeline

Issues flow `triage → design → develop → merged`. Each stage is owned by a corresponding skill in the `harny-dev` plugin. By the time an issue is `ready`, the body contains the full implementation spec — execution should not require re-architecting. If you find yourself making architectural choices during develop, stop and ask whether the issue needs to go back to design.
