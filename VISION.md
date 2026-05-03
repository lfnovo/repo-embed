# VISION

## Purpose

A **read-only GitHub knowledge-base mirror** stored as a graph in SurrealDB, exposed as a **CLI tool**. Installed once per machine, it can mirror and serve **multiple repositories**. Its job is to mirror the *discussion and decision artifacts* of those repos — issues, pull requests, comments, commits, and discussions — so they can be cleaned, connected, embedded, and queried as a living project memory.

The primary consumer is **AI agents** that call the CLI to retrieve related context while working on a repo. A concrete delivery surface is **Claude Code hooks** — the CLI is invoked on every relevant hook event, even when it decides not to act. This makes **invocation latency a first-class concern**. A longer-term capability is **automatic context injection**: the tool surfaces relevant discussions proactively based on the subject the agent is working on, without requiring an explicit query.

### CLI shape (intended)
```
tool list                                  # list mirrored repos
tool search "query"                        # search the repo of the current working dir
tool search "query" --repo owner/name      # search a specific repo from anywhere
```

This is **not** a code-mapping project. Files, symbols, call graphs, and imports are explicitly out of scope. What we want is "what has already been discussed, decided, or attempted in this repo" — the organizational history, not the source tree.

## Why

Valuable context about a project lives in its issues and PRs: architectural discussions, rejected approaches, known bugs, adjacent work, half-finished attempts. It is hard to retrieve by normal GitHub search because:

- Search is keyword-based, not semantic.
- Relationships between items ("Fixes #123", "duplicate of", cross-repo mentions) are not navigable as a graph.
- Closed/old discussions are effectively invisible even when highly relevant.

A searchable, semantically-indexed graph mirror makes that memory retrievable when you (or an agent) need it.

## Scope

### In scope
- Mirror of discussion artifacts from **multiple GitHub repositories per installation**, managed independently.
- Graph model preserving authorship, references, labels, and parent/child relationships — across all mirrored repos.
- Embeddings for semantic search over the textual content.
- Incremental sync with batch cadence (hours of delay is fine).
- Soft-deletion (tombstone) for items removed upstream.
- CLI interface for registering repos, running sync, and running queries.

### Out of scope
- Source code, file trees, symbols, call graphs, dependency graphs.
- Near-real-time ingestion (no webhooks, no queue workers).
- Writing back to GitHub. This mirror is strictly read-only from GitHub's perspective.
- Mirroring entire organizations as a single operation. Repos are registered individually; the graph connects them naturally when they happen to be mirrored.

## Main Objects

Primary node types:
- **Org** — GitHub organization or user account that owns repos.
- **Repo** — a GitHub repository.
- **Issue** — a GitHub issue.
- **PullRequest** — a GitHub PR.
- **Discussion** — a GitHub Discussion (GraphQL-only).
- **Comment** — a comment on any of the three above.
- **Commit** — only commits **referenced by a PR** (plus their metadata). Full repo history is not mirrored.
- **User** — a GitHub account that authored any of the above.
- **Label** — a label applied to issues/PRs/discussions.

## Graph Model

```
Org       -OWNS->          Repo
Repo      -HAS->           Issue | PullRequest | Discussion | Commit
Issue     -HAS_COMMENT->   Comment
PR        -HAS_COMMENT->   Comment
Discussion-HAS_COMMENT->   Comment
PR        -CLOSES|FIXES->  Issue
Issue|PR  -REFERENCES->    Issue | PR          (incl. cross-repo)
PR        -CONTAINS->      Commit
User      -AUTHORED->      Issue | PR | Discussion | Comment | Commit
*         -HAS_LABEL->     Label
```

Cross-repo references (`owner/repo#N`) resolve to the correct node when both repos are mirrored; otherwise they are recorded as dangling references with enough metadata to link later.

## Architecture

Two processes with a clean split of concerns:

```
           ┌────────────────────────────┐
           │  Embedder daemon (Ollama)  │   ← stays warm, serves embeddings via HTTP
           │  model: nomic-embed-text   │
           └────────────┬───────────────┘
                        │ HTTP
                        ▼
┌──────────────────────────────────────┐        ┌─────────────┐
│        Bun CLI (single binary)       │ ◀────▶ │  SurrealDB  │
│  • thin, fast cold-start             │        │  (graph +   │
│  • sync (batch) and query (hot path) │        │   vectors)  │
└──────────────────┬───────────────────┘        └─────────────┘
                   │
                   ▼
        Claude Code hooks  +  manual CLI usage
```

The **CLI** is a single Bun binary. It handles both hot-path queries (fired by hooks) and cold-path sync jobs (fetch → normalize → persist → embed). It is intentionally thin — all heavy lifting is in SurrealDB and the embedder daemon.

The **embedder** is a separate long-running local service. This keeps the embedding model warm across invocations, which matters because the hook path fires frequently. Ollama is the default; any HTTP-compatible embedder can be swapped in via config.

## Pipeline Stages

```
fetch (GraphQL)  →  normalize  →  persist (graph)  →  embed  →  search
                                                       ↓
                                                  (future) post-processing:
                                                    clustering, extraction,
                                                    cleanup, validation
```

Each stage is independent and idempotent. Re-running any stage with the same input produces the same output. Post-processing is intentionally a separate, open-ended stage — we do not pre-design its architecture.

### Embedding granularity
Chunk per comment (and per issue/PR/discussion body), with metadata linking back to the parent thread. This gives good recall for "what have we discussed about X" queries while still allowing thread-level reranking at retrieval time.

Only chunks whose content hash changed are re-embedded on sync.

## Sync Strategy

### Incremental (default, hourly-ish)
- Query GraphQL with `updatedAt > last_sync` per object type.
- Because a comment edit may not bump the parent issue's `updatedAt` reliably, also fetch objects whose *comments* changed since `last_sync`.
- Re-ingest only what changed.

### Deletion detection
GitHub does not emit deletion events for standard repos. Strategy:
- **On update re-sync**: when an issue/PR/discussion is re-fetched, reconcile its comment list by ID. IDs present locally but missing remotely → mark tombstoned.
- **Full reconciliation pass**: on a low-frequency schedule (weekly), paginate all IDs per type per repo from GraphQL, diff against local, tombstone the delta.
- **Soft-delete only**: every node carries a `deleted_at` flag. Never hard-delete — it breaks historical context and dangling references.

Enterprise audit logs and the Events API are not relied on (incomplete coverage for normal repos).

## Current Focus

**Get data into the graph cleanly and make it easy to query.** That is the entire near-term goal. Nothing else is being planned.

Concretely, this means:
- A GraphQL fetcher that pulls Issues, PRs, Discussions, Comments, Commits, Labels, Users for a registered repo.
- Normalization and persistence as a well-linked graph in SurrealDB.
- Incremental sync via `updatedAt` + deletion reconciliation (soft-delete).
- Embeddings on textual content so the data is semantically queryable.
- A query surface (SurrealQL and/or a thin helper layer) that makes traversal + vector search pleasant.

The CLI, retrieval UX, context injection, and any post-processing (clustering, extraction, cleanup, validation) stay part of the **vision** but are not being planned or scoped yet. They come when the data layer earns them.

## Technical Decisions (confirmed)

- **Language / runtime**: **Bun + TypeScript**. Chosen for fast cold-start (critical for the Claude Code hook use case), single-binary distribution (`bun build --compile`), and excellent GitHub GraphQL tooling (`@octokit/graphql`).
- **Storage**: SurrealDB running locally on `localhost:8018`, user `root`, password `root`, namespace `githubembed` (database name within it TBD).
- **GitHub API**: GraphQL for everything. Discussions require it, and a single client path is simpler than mixing REST + GraphQL.
- **Embedder**: **Ollama** as local daemon, serving the **`nomic-embed-text`** model (768 dimensions, 8K context). Keeps the model warm across CLI invocations; any HTTP-compatible embedder can replace it via config later. The vector column in SurrealDB is sized at **768d** and treated as a hard schema decision.
- **Initial test repo**: `lfnovo/esperanto` — small enough to iterate quickly on the pipeline end-to-end.
- **Commit scope**: only commits referenced by a PR. No full-history mirroring.
- **Bot policy**: bot-authored issues/PRs/comments are **ingested into the graph** so the structure stays complete, but are **not embedded by default** (flagged at ingest so the embedding stage skips them). A heuristic to selectively embed useful bot content is a future concern.
- **Query surface (MVP)**: raw SurrealQL via the Surreal shell. The bar is "a well-linked graph with a clean schema, where common questions have natural queries." A helper library can come later once real usage patterns emerge.
- **Repo registration**: the list of mirrored repos lives **in SurrealDB itself** (as state on the `Repo` nodes — e.g., `registered_at` timestamp). The CLI operations `list`, `add`, `remove` all operate against SurrealDB as the source of truth.
- **Attachments**: stored as **URLs only**. No mirroring of attachment content.

## Open Questions

What still genuinely affects the data layer. Purely-future UX concerns are not listed.

1. **Chunking granularity.** Start with per-item (one chunk per issue/PR/discussion body, one chunk per comment) and expand only when retrieval quality on real queries pushes us to. Long-comment splitting and thread-level summary chunks are candidates but not committed to. Note: `nomic-embed-text` supports 8K tokens, so most items fit in a single chunk without splitting.
2. **Auth token management.** A single GitHub token at the install level is the simplest starting point; per-repo tokens (needed for private repos under different accounts) can come later. No decision yet.
3. **Bot detection heuristic.** Which senders count as "bots" for the no-embed policy. GitHub's `User.type == Bot` covers most, but named accounts (`dependabot[bot]`, `github-actions[bot]`) and human bots-in-disguise need a small rule set. MVP can start with `type == Bot` + account-name suffix `[bot]`.
4. **Reconciliation cadence.** "Weekly-ish" full-diff passes is a guess — revisit once we see how often deletions actually happen in practice.
5. **Rate limits across multiple repos.** 5k req/h on a single token is a soft ceiling; with few active repos it probably isn't a real problem. Naive sequential sync first.
6. **Embedder-offline fallback behavior.** When Ollama is not running, does the CLI (a) fail fast, (b) degrade gracefully to keyword + graph search, or (c) queue items for embedding on next sync? Leaning toward (b) for queries and (c) for sync.

## Non-goals (reiterated)

- Not mapping source code.
- Not real-time.
- Not writing to GitHub.
- Not building a generic "GitHub analytics" product — this is a focused KB for retrieval.
