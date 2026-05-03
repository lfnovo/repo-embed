# ARCHITECTURE

Reusable architectural principles for `github-embedder-surrealdb`.

This file is the **principle store**. Every design session starts by reading it. When a design decision is reusable across future issues, it gets recorded here so the next session is "look it up" rather than "debate from scratch."

For the *what* and *why* of the project, see `VISION.md`. This file is about *how we make decisions*.

---

## Runtime & Distribution

### Single Bun binary, single language

The CLI is a single Bun + TypeScript binary, distributed via `bun build --compile`. No mixed runtimes, no Python sidecars.

**Why:** Cold-start latency is a first-class concern (Claude Code hooks fire frequently). Single-binary install is the lowest-friction shape for users.

**Scope:** All CLI code, sync code, embedder orchestration. Exception: the embedder daemon itself (Ollama) is external — but the CLI never embeds in-process.

**Origin:** VISION.md, 2026-05-03.

---

## Storage

### SurrealDB is the only stateful system

State lives in SurrealDB. No separate Redis/Postgres/SQLite for queues, locks, or caches. Repo registration, content hashes, embeddings, last-sync timestamps — all on SurrealDB nodes.

**Why:** One source of truth, one connection to manage, one schema to evolve. SurrealDB has graph + vectors + records in one engine; bringing a second store would be premature.

**Scope:** All persistent state. Ephemeral per-process state (in-memory caches during a single sync run) is fine.

**Origin:** VISION.md, 2026-05-03.

### Soft-delete only — never hard-delete (nodes)

Every node carries a `deleted_at: option<datetime>` field. Tombstone instead of deleting.

**Why:** Hard-deletes break historical context, dangling cross-references, and embeddings that point at vanished nodes. The graph is a memory of what happened, including what was removed.

**Scope:** All node tables (org, repo, issue, pull_request, discussion, comment, commit, user, label).

**Origin:** VISION.md, 2026-05-03.

### Nodes are historical; edges are relational truth — except structural edges

Nodes carry `deleted_at` and are never hard-deleted — they preserve history of what existed and was authored. Most edges, by contrast, reflect the current relation between two nodes; when upstream removes the relation (a label unstuck, a "Closes #N" edited away, a referenced commit dropped from a PR), the local edge is hard-deleted outright. No `deleted_at` on edges.

**Carve-out — structural edges:** Edges that express identity or parentage are an exception. They are created once at first persist and never recomputed or deleted, so traversals to tombstoned nodes still work. Structural edges include: `has` (repo → child), `has_comment` (issue/pr/discussion → comment), `contains_commit` (pr → commit), `authored` (user → anything), `merged_by`-style links. Everything else is relational and follows recompute-on-sync semantics.

**Why:** A relational edge that no longer exists upstream is not history — it's a stale fact. Filtering by `deleted_at` on every traversal would poison query patterns and grow indexes forever. Structural edges, however, encode "this comment was born on this issue" — that fact doesn't change when the comment is later tombstoned. Without the structural carve-out, traversal from an issue to its deleted comments would silently break.

**Scope:** All edge tables. Relational: `has_label`, `closes`, `fixes`, `references_ref`, `in_category`, future cross-references. Structural: `has`, `has_comment`, `contains_commit`, `authored`, parent-pointer edges. Does not change node soft-delete semantics — nodes still tombstone forever.

**Origin:** Issue #6, 2026-05-03. Structural carve-out added in #7, 2026-05-03.

### Embedding dimension is a hard schema decision

The vector column is fixed at **768 dimensions**, matching `nomic-embed-text`. Changing dimension means a schema migration.

**Why:** The HNSW index is dimension-bound. Treating the dim as soft would add per-row branching with zero practical benefit; we'd rather force a deliberate schema change if we ever switch models.

**Scope:** All embeddable tables (issue, pull_request, discussion, comment).

**Origin:** VISION.md, 2026-05-03.

---

## GitHub access

### GraphQL only — no REST mixing

All GitHub API access goes through `@octokit/graphql`. No REST fallbacks.

**Why:** Discussions require GraphQL anyway. A single client path is simpler than two; auth, retry, and rate-limit handling live in one place.

**Scope:** All fetch logic. If a GraphQL endpoint doesn't expose what we need, we adjust the data model rather than dropping to REST.

**Origin:** VISION.md, 2026-05-03.

### Single token at install level (for now)

One `GITHUB_TOKEN` env var, shared across all mirrored repos.

**Why:** Simplest viable model. Per-repo tokens (needed for private repos under different accounts) are explicitly deferred to a future milestone (`future` label, issue #17).

**Scope:** First Full Sync milestone. Revisit when private/multi-account becomes a real requirement.

**Origin:** VISION.md, 2026-05-03.

---

## Embeddings

### Ollama is the default embedder; HTTP-compatible swap allowed

`nomic-embed-text` on a local Ollama daemon. The CLI reaches it over HTTP. Any HTTP-compatible embedder can replace it via config (`OLLAMA_URL`, `OLLAMA_EMBED_MODEL`).

**Why:** Keeping the model warm across hot-path invocations matters. Ollama is the lowest-friction local option; the HTTP boundary keeps us from coupling to it.

**Scope:** All embedding calls. We do not embed in-process and we do not bundle a model.

**Origin:** VISION.md, 2026-05-03.

### Bots are ingested but not embedded

Bot-authored issues/PRs/comments enter the graph (so structure stays complete) but skip the embedding stage. Detection: GitHub's `User.type == "Bot"` plus account name suffix `[bot]`.

**Why:** Bot content is mostly noise for retrieval but its *structure* (who closed what, which CI failed) is part of the project memory. Skipping embeddings saves cost without breaking the graph.

**Scope:** Embedding stage only. The bot flag (`user.is_bot`) is set at ingest and read at embed time.

**Origin:** VISION.md, 2026-05-03.

### Skip re-embedding on unchanged content

Each embeddable node carries a `content_hash`. The embed stage skips items whose hash matches the prior embedding.

**Why:** Embedding is the slowest stage. Most syncs touch metadata (labels, state) without changing body text; re-embedding all of them wastes time and compute.

**Scope:** All embeddable tables. Hash is computed over the canonical text the embedder sees.

**Origin:** VISION.md, 2026-05-03.

---

## Pipeline

### Stages are independent and idempotent

`fetch → normalize → persist → embed → search`. Each stage is independent and re-runnable. Re-running any stage with the same input produces the same output.

**Why:** Sync failures should never require a "rollback." Idempotency makes retries cheap and lets stages run on different cadences (embed can lag fetch by hours).

**Scope:** All sync code. Persistence uses upsert-by-`github_node_id`, not insert; embedding is keyed on `content_hash`; etc.

**Origin:** VISION.md, 2026-05-03.

### Schema applies are non-destructive

`schemas.surrealql` uses `IF NOT EXISTS` everywhere. Re-running it never wipes data.

**Why:** Real mirrored data will be loaded soon and is expensive to re-fetch. The skill convention of `REMOVE TABLE IF EXISTS` is appropriate for greenfield exploration; once data lives in the graph, schema apply must be safe to run repeatedly.

**Scope:** `schemas.surrealql` and `src/schema/apply.ts`. Destructive migrations, when needed, get their own explicit script — never folded into apply.

**Origin:** Setup plan execution, 2026-05-03.

---

## Scope discipline

### Source code is out of scope, period

No file trees, no symbols, no call graphs, no AST work. Even when an issue/PR mentions a file, we record the mention as text — we do not parse or link to source.

**Why:** This is a discussion/decision mirror, not a code-mapping product. Drift in scope here would balloon the schema and the sync surface area.

**Scope:** Forever. Reject feature requests that cross this line.

**Origin:** VISION.md, 2026-05-03.

### Read-only from GitHub's perspective

We never POST/PATCH to GitHub. No comments, no labels, no closes, no webhooks registered.

**Why:** Mirror semantics. Writing back is a different product with different risk and auth requirements.

**Scope:** All GitHub interactions.

**Origin:** VISION.md, 2026-05-03.

### Defer until it hurts

CLI framework, linter/formatter, retry policy beyond the obvious, observability — none of these get built until something concrete justifies them. `process.argv` is fine until the CLI surface forces a real router.

**Why:** Premature infrastructure freezes choices that should stay open while the system is small.

**Scope:** Tooling and infra decisions. Does not apply to data-shape decisions, where late changes are expensive (e.g., schema, hash semantics).

**Origin:** Setup plan, 2026-05-03.

### CLI commands manage resource lifecycle by scope, not by singleton

Resources that need open/close (DB connections, HTTP keepalive pools) are acquired and released within the scope of a single command via higher-order wrappers (e.g., `withDb(fn)`), not via module-level singletons.

**Why:** Each CLI invocation is short-lived and self-contained. Singletons push cleanup responsibility onto callers and leak when commands forget to close. HOF wrappers make leaking impossible by construction. When a long-running process (daemon, watcher) eventually appears, it gets its own pattern — we don't backport it onto the CLI path.

**Scope:** All Bun CLI command handlers. Does not apply to in-process daemons or test fixtures, which manage their own lifecycle.

**Origin:** Issue #1, 2026-05-03.

### Paginated remote reads stream by default

Helpers that paginate over remote APIs (GitHub GraphQL connections, SurrealDB live queries, etc.) are async generators yielding items as they arrive. Collect-all variants are only added when a concrete caller needs the full set in memory and can justify the cost.

**Why:** Per-page memory keeps the sync path constant in repo size. Collecting before persisting is fine on `lfnovo/esperanto` and a trap on a 10k-issue repo. Idempotent persisters can flush per page.

**Scope:** All fetch/sync code that talks to external paginated APIs. Does not constrain in-memory transforms after persistence.

**Origin:** Issue #1, 2026-05-03.

### Ingest stages are pure functions; orchestrators glue them

`fetch*` functions are DB-agnostic and yield parsed values via async generators. `persist*` functions are pure infrastructure: they take a DB handle and a parsed value, and emit no side effects beyond the DB. The CLI command (`tool sync`) is the only place these are composed.

Cross-cutting concerns (label upsert, user upsert, bot detection) live in their own module and are owned by a specific issue; other ingest stages depend on the stable call site, not on the implementation, so they can ship before the owner refines.

**Why:** Stage independence (per the principle above) is enforced by signatures — a fetcher that knows about the DB will eventually grow side effects that break idempotency. A persister that fetches will couple stage cadence to network. Cross-cutting concerns inevitably appear in 3+ places; "owner issue + stub call site" lets parallel work proceed without blocking on the cross-cutting design.

**Scope:** All ingest code (issues, pull requests, discussions, comments, labels, users, bots) and the sync orchestrator.

**Origin:** Issue #3, 2026-05-03.
