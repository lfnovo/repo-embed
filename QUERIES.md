# QUERIES.md

Documented SurrealQL examples for `github-embedder-surrealdb`.

> **Note:** Examples are tested against the schema only (no live data at PR time). Run `surreal sql --conn http://localhost:8018 --user root --pass root --ns githubembed --db main` to execute interactively.

---

## 1. Counts and Coverage

### Total non-tombstoned items per type for a repo

Fetch the repo record first, then count per table. Replace `'lfnovo/esperanto'` with any `name_with_owner` value.

```surql
LET $repo = (SELECT id FROM repo WHERE name_with_owner = 'lfnovo/esperanto' AND registered_at != NONE)[0];

SELECT count() AS total FROM issue          WHERE repo = $repo.id AND deleted_at IS NONE GROUP ALL;
SELECT count() AS total FROM pull_request   WHERE repo = $repo.id AND deleted_at IS NONE GROUP ALL;
SELECT count() AS total FROM discussion     WHERE repo = $repo.id AND deleted_at IS NONE GROUP ALL;
SELECT count() AS total FROM comment
  WHERE (parent_issue.repo = $repo.id OR parent_pr.repo = $repo.id OR parent_discussion.repo = $repo.id)
    AND deleted_at IS NONE
  GROUP ALL;
```

> ```json
> [{ "total": 42 }]
> [{ "total": 17 }]
> [{ "total": 3 }]
> [{ "total": 128 }]
> ```

### Embedding coverage per type

Shows how many items are embeddable (non-bot, non-tombstoned) and how many have been embedded. Bot-authored content is excluded per the bot policy (bots are ingested but not embedded).

```surql
LET $repo = (SELECT id FROM repo WHERE name_with_owner = 'lfnovo/esperanto' AND registered_at != NONE)[0];

SELECT
  count()                                            AS total,
  count(WHERE author.is_bot != true)                 AS embeddable,
  count(WHERE embedding != NONE AND author.is_bot != true) AS embedded
FROM issue
WHERE repo = $repo.id AND deleted_at IS NONE
GROUP ALL;
```

> ```json
> [{ "total": 42, "embeddable": 39, "embedded": 35 }]
> ```

Repeat replacing `issue` with `pull_request`, `discussion`, or `comment` as needed.

---

## 2. Joins via Record Link

SurrealDB resolves record links in `SELECT` automatically — no explicit `JOIN` syntax required.

### All comments on issue #N

`comment.parent_issue` is a direct record link to `issue`; the dot notation traverses it in place.

```surql
SELECT *
FROM comment
WHERE parent_issue.number = 5
  AND parent_issue.repo.name_with_owner = 'lfnovo/esperanto'
  AND deleted_at IS NONE;
```

> ```json
> [
>   {
>     "id": "comment:abc123",
>     "body": "Looks good to me.",
>     "author": "user:jsmith",
>     "created_at": "2026-01-15T10:00:00Z"
>   }
> ]
> ```

### Organization of an issue

`repo.owner` is a record link to `org`; dot-chaining resolves both links in one query.

```surql
SELECT title, repo.owner.login AS org
FROM issue
WHERE number = 5
  AND repo.name_with_owner = 'lfnovo/esperanto';
```

> ```json
> [{ "title": "Fix null pointer in config loader", "org": "lfnovo" }]
> ```

### All labels for an issue

`has_label` is an edge table (`issue → label`). The `->edge->target` graph traversal syntax walks it.

```surql
SELECT title, ->has_label->label.name AS labels
FROM issue
WHERE number = 5
  AND repo.name_with_owner = 'lfnovo/esperanto';
```

> ```json
> [{ "title": "Fix null pointer in config loader", "labels": ["bug", "good first issue"] }]
> ```

_Relies on the `has_label` relation: `issue | pull_request | discussion → label`._

---

## 3. Vector Similarity (Semantic Search)

The HNSW indexes are defined as:
```
DEFINE INDEX issue_embedding_hnsw ON TABLE issue FIELDS embedding HNSW DIMENSION 768 DIST COSINE TYPE F32;
```
(and equivalently for `pull_request`, `discussion`, `comment`.)

### Find issues most similar to a query embedding

`$query_vec` is a 768-dimension float array produced by Ollama `nomic-embed-text`. Two equivalent forms are shown.

**Function form** — explicit scoring, useful when you need the score column:

```surql
SELECT id, number, title,
       vector::similarity::cosine(embedding, $query_vec) AS score
FROM issue
WHERE embedding != NONE
  AND deleted_at IS NONE
ORDER BY score DESC
LIMIT 10;
-- $query_vec: 768-dim float array from Ollama nomic-embed-text
```

> ```json
> [
>   { "id": "issue:1", "number": 23, "title": "Add retry logic to sync", "score": 0.94 },
>   { "id": "issue:2", "number": 7,  "title": "Sync stalls on large repos", "score": 0.91 }
> ]
> ```

**ANN shorthand** — `<|K,COSINE|>` operator uses the HNSW index directly for approximate nearest-neighbour search:

```surql
SELECT id, number, title
FROM issue
WHERE embedding <|10,COSINE|> $query_vec
  AND deleted_at IS NONE;
-- $query_vec: 768-dim float array from Ollama nomic-embed-text
```

> ```json
> [
>   { "id": "issue:1", "number": 23, "title": "Add retry logic to sync" },
>   { "id": "issue:2", "number": 7,  "title": "Sync stalls on large repos" }
> ]
> ```

_The `<|K,COSINE|>` operator triggers the `issue_embedding_hnsw` index and returns up to K approximate nearest neighbours._

### Find PRs similar to a given issue

Reuse the issue's stored embedding — no re-query to Ollama needed.

```surql
LET $emb = (
  SELECT embedding
  FROM issue
  WHERE number = 5
    AND repo.name_with_owner = 'lfnovo/esperanto'
)[0].embedding;

SELECT id, number, title,
       vector::similarity::cosine(embedding, $emb) AS score
FROM pull_request
WHERE embedding != NONE
  AND deleted_at IS NONE
ORDER BY score DESC
LIMIT 5;
```

> ```json
> [
>   { "id": "pull_request:8", "number": 12, "title": "Implement retry in fetcher", "score": 0.89 },
>   { "id": "pull_request:3", "number": 4,  "title": "Add pagination guard",       "score": 0.82 }
> ]
> ```

_Uses the `pr_embedding_hnsw` index. Both issue and pull_request share the same 768-dim space, so cross-table comparison is meaningful._

---

## 4. Cross-References

### All PRs that close issue #N

The `closes` edge goes `pull_request → issue`. The inner subquery resolves the issue id; the outer query walks the edge in reverse.

```surql
SELECT id, number, title
FROM pull_request
WHERE id IN (
  SELECT in FROM closes
  WHERE out = (
    SELECT id FROM issue
    WHERE number = 5
      AND repo.name_with_owner = 'lfnovo/esperanto'
  )[0].id
);
```

> ```json
> [{ "id": "pull_request:7", "number": 11, "title": "Fix #5: null pointer in config" }]
> ```

_Relies on the `closes` relation: `pull_request → issue`. The `in` field on an edge record is the source (PR), `out` is the target (issue)._

### All dangling references targeting a repo

Dangling references are cross-references to issues or PRs in repos that have not been mirrored yet.

```surql
SELECT *
FROM dangling_reference
WHERE target_owner = 'lfnovo'
  AND target_repo = 'esperanto';
```

> ```json
> [
>   {
>     "id": "dangling_reference:xyz",
>     "parent": "issue:42",
>     "target_owner": "lfnovo",
>     "target_repo": "esperanto",
>     "target_number": 99,
>     "ref_kind": "closes",
>     "detected_at": "2026-05-01T09:00:00Z"
>   }
> ]
> ```

_Uses the `dangling_target` index on `(target_owner, target_repo)`. Run `tool mirror add lfnovo/esperanto` then re-sync to resolve these._

---

## 5. Recent Activity

### Top-10 most recently updated issues across all repos

```surql
SELECT number, title, updated_at, repo.name_with_owner AS repo
FROM issue
WHERE deleted_at IS NONE
ORDER BY updated_at DESC
LIMIT 10;
```

> ```json
> [
>   { "number": 55, "title": "Stale embedding after body edit", "updated_at": "2026-05-02T18:30:00Z", "repo": "lfnovo/esperanto" },
>   { "number": 23, "title": "Add retry logic to sync",         "updated_at": "2026-05-01T14:00:00Z", "repo": "lfnovo/other-repo" }
> ]
> ```

_`repo.name_with_owner` is resolved in a single pass via the record link — no join syntax needed._

---

## 6. Bot Policy

These queries confirm that no bot-authored content has been embedded. The expected count is 0 for all tables — embedding is skipped for bot authors at the embed stage.

### Issues

```surql
SELECT count() AS bot_with_embeddings
FROM issue
WHERE embedding != NONE AND author.is_bot = true
GROUP ALL;
-- Expected: [{ "bot_with_embeddings": 0 }]
```

> ```json
> [{ "bot_with_embeddings": 0 }]
> ```

### Pull requests

```surql
SELECT count() AS bot_with_embeddings
FROM pull_request
WHERE embedding != NONE AND author.is_bot = true
GROUP ALL;
-- Expected: [{ "bot_with_embeddings": 0 }]
```

> ```json
> [{ "bot_with_embeddings": 0 }]
> ```

### Discussions

```surql
SELECT count() AS bot_with_embeddings
FROM discussion
WHERE embedding != NONE AND author.is_bot = true
GROUP ALL;
-- Expected: [{ "bot_with_embeddings": 0 }]
```

> ```json
> [{ "bot_with_embeddings": 0 }]
> ```

### Comments

```surql
SELECT count() AS bot_with_embeddings
FROM comment
WHERE embedding != NONE AND author.is_bot = true
GROUP ALL;
-- Expected: [{ "bot_with_embeddings": 0 }]
```

> ```json
> [{ "bot_with_embeddings": 0 }]
> ```

_The `user.is_bot` flag is set at ingest time from GitHub's `User.type == "Bot"` field and the `[bot]` login suffix. The embed stage reads this flag and skips bot-authored items entirely._
