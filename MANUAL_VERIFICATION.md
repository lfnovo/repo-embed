## Manual verification

Performed against `lfnovo/circle-bilu` (a real private repository under the operator's account), using the GitHub token configured in the environment.

### Step 1 — `tool add`

```
$ bun run src/index.ts add lfnovo/circle-bilu
✓ Registered lfnovo/circle-bilu (repo:44lipo7htj1xy05baian)
```

### Step 2 — `tool sync`

```
$ bun run src/index.ts sync lfnovo/circle-bilu
Sync mode: full
✓ Labels (catalog): 9 persisted
✓ Issues: 0 persisted
✓ Pull requests: 0 persisted (0 commits)
✓ Discussions: 0 persisted
✓ Comments (issues): 0 persisted, 0 tombstoned
✓ Comments (PRs): 0 persisted, 0 tombstoned
✓ Comments (discussions): 0 persisted, 0 tombstoned
✓ Cross-refs: 0 same-repo, 0 cross-repo, 0 dangling
✓ Answer links: 0 resolved, 0 pending
✓ Dangling materialized: 0
✓ Sync complete: lfnovo/circle-bilu @ 2026-05-07T01:07:30.760Z
```

### Step 3 — SurrealDB query

```sql
SELECT name_with_owner, is_private FROM repo WHERE name_with_owner = "lfnovo/circle-bilu"
```

Result:

```json
[{"result":[{"is_private":true,"name_with_owner":"lfnovo/circle-bilu"}],"status":"OK","time":"335.458µs"}]
```

`is_private: true` confirmed on the persisted row.

### Step 4 — 401 hint with invalid token

```
$ GITHUB_TOKEN=bad_token_intentionally_invalid bun run src/index.ts add lfnovo/circle-bilu
error: ✗ GitHub access denied for lfnovo/circle-bilu: Bad credentials - https://docs.github.com/rest
  Hint: token may be expired, missing required scope, or not authorized
        for this org. See README "Private repos" for required scopes.
      at gh (.../src/clients/github.ts:30:17)
      at async run (.../src/commands/add.ts:71:22)
(exit code 1)
```
