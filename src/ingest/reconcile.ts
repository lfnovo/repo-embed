import { StringRecordId } from "surrealdb";
import type { Surreal } from "surrealdb";
import type { RepoRef } from "./types.ts";

type GhFn = <T>(query: string, params?: Record<string, unknown>) => Promise<T>;

type Connection = {
  nodes: Array<{ id: string }>;
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
};

const ISSUE_IDS_QUERY = `
  query FetchIssueIds($owner: String!, $name: String!, $cursor: String) {
    repository(owner: $owner, name: $name) {
      issues(first: 100, after: $cursor, states: [OPEN, CLOSED]) {
        pageInfo { hasNextPage endCursor }
        nodes { id }
      }
    }
  }
`;

const PR_IDS_QUERY = `
  query FetchPrIds($owner: String!, $name: String!, $cursor: String) {
    repository(owner: $owner, name: $name) {
      pullRequests(first: 100, after: $cursor, states: [OPEN, CLOSED, MERGED]) {
        pageInfo { hasNextPage endCursor }
        nodes { id }
      }
    }
  }
`;

const DISCUSSION_IDS_QUERY = `
  query FetchDiscussionIds($owner: String!, $name: String!, $cursor: String) {
    repository(owner: $owner, name: $name) {
      discussions(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { id }
      }
    }
  }
`;

async function fetchAllRemoteIds(
  gh: GhFn,
  query: string,
  owner: string,
  name: string,
  selectConn: (data: unknown) => Connection,
): Promise<Set<string>> {
  const ids = new Set<string>();
  let cursor: string | null = null;
  while (true) {
    const data = await gh<unknown>(query, { owner, name, cursor });
    const conn = selectConn(data);
    for (const node of conn.nodes) {
      ids.add(node.id);
    }
    if (!conn.pageInfo.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }
  return ids;
}

export async function reconcileTopLevel(
  db: Surreal,
  repo: RepoRef,
  owner: string,
  name: string,
  gh: GhFn,
): Promise<{ issues_tombstoned: number; prs_tombstoned: number; discussions_tombstoned: number }> {
  const repoId = new StringRecordId(repo.id);

  // issues
  const remoteIssueIds = await fetchAllRemoteIds(
    gh,
    ISSUE_IDS_QUERY,
    owner,
    name,
    (d) => (d as { repository: { issues: Connection } }).repository.issues,
  );
  const [localIssues] = await db.query<[Array<{ id: unknown; github_node_id: string }>]>(
    "SELECT id, github_node_id FROM issue WHERE repo = $repo AND deleted_at IS NONE",
    { repo: repoId },
  );
  let issues_tombstoned = 0;
  for (const row of localIssues) {
    if (!remoteIssueIds.has(row.github_node_id)) {
      await db.query("UPDATE $id SET deleted_at = time::now()", {
        id: new StringRecordId(String(row.id)),
      });
      issues_tombstoned++;
    }
  }
  console.log(`✓ Reconciled issue: ${issues_tombstoned} tombstoned`);

  // pull_requests
  const remotePrIds = await fetchAllRemoteIds(
    gh,
    PR_IDS_QUERY,
    owner,
    name,
    (d) => (d as { repository: { pullRequests: Connection } }).repository.pullRequests,
  );
  const [localPRs] = await db.query<[Array<{ id: unknown; github_node_id: string }>]>(
    "SELECT id, github_node_id FROM pull_request WHERE repo = $repo AND deleted_at IS NONE",
    { repo: repoId },
  );
  let prs_tombstoned = 0;
  for (const row of localPRs) {
    if (!remotePrIds.has(row.github_node_id)) {
      await db.query("UPDATE $id SET deleted_at = time::now()", {
        id: new StringRecordId(String(row.id)),
      });
      prs_tombstoned++;
    }
  }
  console.log(`✓ Reconciled pull_request: ${prs_tombstoned} tombstoned`);

  // discussions — skip if disabled on this repo
  let discussions_tombstoned = 0;
  try {
    const remoteDiscIds = await fetchAllRemoteIds(
      gh,
      DISCUSSION_IDS_QUERY,
      owner,
      name,
      (d) => (d as { repository: { discussions: Connection } }).repository.discussions,
    );
    const [localDiscs] = await db.query<[Array<{ id: unknown; github_node_id: string }>]>(
      "SELECT id, github_node_id FROM discussion WHERE repo = $repo AND deleted_at IS NONE",
      { repo: repoId },
    );
    for (const row of localDiscs) {
      if (!remoteDiscIds.has(row.github_node_id)) {
        await db.query("UPDATE $id SET deleted_at = time::now()", {
          id: new StringRecordId(String(row.id)),
        });
        discussions_tombstoned++;
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/discuss/i.test(msg) || /disabled/i.test(msg) || /not enabled/i.test(msg)) {
      console.log(`! Discussions not available for ${owner}/${name}, skipping`);
    } else {
      throw err;
    }
  }
  console.log(`✓ Reconciled discussion: ${discussions_tombstoned} tombstoned`);

  return { issues_tombstoned, prs_tombstoned, discussions_tombstoned };
}
