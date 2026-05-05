import { gh } from "../clients/github.ts";
import { withDb } from "../clients/surreal.ts";
import { StringRecordId } from "surrealdb";
import { createContent, updateSet } from "../clients/surreal_helpers.ts";
import { fetchLabelsCatalog, persistLabelCatalog } from "../ingest/labels.ts";
import { fetchIssues, persistIssue } from "../ingest/issue.ts";
import { fetchPullRequests, persistPullRequest } from "../ingest/pull_request.ts";
import {
  fetchDiscussions,
  persistDiscussion,
  resolveDiscussionAnswerLinks,
} from "../ingest/discussion.ts";
import {
  fetchCommentsForIssue,
  fetchCommentsForPullRequest,
  fetchCommentsForDiscussion,
  persistComment,
  tombstoneMissingComments,
} from "../ingest/comment.ts";
import { extractAndLinkCrossRefs, materializeDanglingReferences } from "../ingest/crossrefs.ts";
import type { RepoRef } from "../ingest/types.ts";

type GitHubOwner = {
  __typename: "Organization" | "User";
  id: string;
  login: string;
  url: string;
  name: string | null;
  avatarUrl: string;
  createdAt: string;
  updatedAt: string;
};

type GitHubRepo = {
  id: string;
  nameWithOwner: string;
  description: string | null;
  url: string;
  isPrivate: boolean;
  createdAt: string;
  updatedAt: string;
  owner: GitHubOwner;
};

const REPO_QUERY = `
  query($owner: String!, $name: String!) {
    repository(owner: $owner, name: $name) {
      id
      nameWithOwner
      description
      url
      isPrivate
      createdAt
      updatedAt
      owner {
        __typename
        ... on Organization {
          id
          login
          url
          name
          avatarUrl
          createdAt
          updatedAt
        }
        ... on User {
          id
          login
          url
          name
          avatarUrl
          createdAt
          updatedAt
        }
      }
    }
  }
`;

function fmtTimestamp(d: Date): string {
  return d.toISOString();
}

export default async function run(args: string[]): Promise<void> {
  const fullFlag = args.includes('--full');
  const repoArg = args.find(a => !a.startsWith('--'));
  const input = repoArg;
  if (!input || !/^[^/]+\/[^/]+$/.test(input)) {
    console.error("✗ Usage: tool sync <owner/name>");
    process.exit(1);
  }

  const [owner, name] = input.split("/");

  await withDb(async (db) => {
    // Captured at sync start so the watermark can never advance past
    // updates that happened during this run; we'd miss them next time.
    const syncStartedAt = new Date();

    // 1. Load repo node
    const [repoRows] = await db.query<
      [Array<{ id: unknown; name_with_owner: string; registered_at: unknown; last_synced_at: unknown }>]
    >("SELECT id, name_with_owner, registered_at, last_synced_at FROM repo WHERE name_with_owner = $nwo", {
      nwo: input,
    });
    const repoRow = repoRows[0];
    if (!repoRow || repoRow.registered_at == null) {
      throw new Error("repo not registered — use `tool add` first");
    }
    const repoRef: RepoRef = {
      id: String(repoRow.id),
      name_with_owner: repoRow.name_with_owner,
    };

    const mode: 'full' | 'incremental' =
      fullFlag || repoRow.last_synced_at == null ? 'full' : 'incremental';
    const since: Date | undefined =
      mode === 'incremental' ? new Date(repoRow.last_synced_at as string) : undefined;

    if (mode === 'incremental') {
      console.log(`Sync mode: incremental (since ${since!.toISOString()})`);
    } else {
      console.log('Sync mode: full');
    }

    // 2. Refresh metadata
    const data = await gh<{ repository: GitHubRepo }>(REPO_QUERY, { owner, name });
    const { repository } = data;
    const ownerData = repository.owner;

    const [existingOrgs] = await db.query<[Array<{ id: unknown }>]>(
      "SELECT id FROM org WHERE github_node_id = $github_node_id",
      { github_node_id: ownerData.id },
    );

    let orgId: unknown;
    if (existingOrgs.length === 0) {
      const orgContent = createContent({
        github_node_id: ownerData.id,
        github_url: ownerData.url,
        login: ownerData.login,
        name: ownerData.name,
        kind: ownerData.__typename,
        created_at: new Date(ownerData.createdAt),
        updated_at: new Date(ownerData.updatedAt),
        deleted_at: null,
      });
      const [created] = await db.query<[Array<{ id: unknown }>]>(
        `CREATE org CONTENT ${orgContent.sql}`,
        orgContent.params,
      );
      orgId = created[0].id;
    } else {
      orgId = existingOrgs[0].id;
      const orgSet = updateSet({
        github_url: ownerData.url,
        login: ownerData.login,
        name: ownerData.name,
        kind: ownerData.__typename,
        updated_at: new Date(ownerData.updatedAt),
      });
      await db.query(
        `UPDATE $id ${orgSet.sql}`,
        { id: orgId, ...orgSet.params },
      );
    }

    const [existingRepos] = await db.query<[Array<{ id: unknown }>]>(
      "SELECT id FROM repo WHERE github_node_id = $github_node_id",
      { github_node_id: repository.id },
    );

    if (existingRepos.length === 0) {
      const repoContent = createContent({
        github_node_id: repository.id,
        github_url: repository.url,
        name,
        name_with_owner: repository.nameWithOwner,
        description: repository.description,
        is_private: repository.isPrivate,
        owner: orgId as object,
        created_at: new Date(repository.createdAt),
        updated_at: new Date(repository.updatedAt),
      });
      await db.query(
        `CREATE repo CONTENT ${repoContent.sql.slice(0, -2)}, registered_at: time::now() }`,
        repoContent.params,
      );
    } else {
      const repoSet = updateSet({
        github_url: repository.url,
        name,
        name_with_owner: repository.nameWithOwner,
        description: repository.description,
        is_private: repository.isPrivate,
        owner: orgId as object,
        created_at: new Date(repository.createdAt),
        updated_at: new Date(repository.updatedAt),
      });
      await db.query(
        `UPDATE $id ${repoSet.sql}`,
        { id: existingRepos[0].id, ...repoSet.params },
      );
    }

    // 3. Labels
    let labelCount = 0;
    for await (const parsed of fetchLabelsCatalog(owner, name)) {
      await persistLabelCatalog(db, repoRef, parsed);
      labelCount++;
    }
    console.log(`✓ Labels (catalog): ${labelCount} persisted`);

    // 4. Issues
    let issueCount = 0;
    for await (const parsed of fetchIssues(owner, name, since)) {
      await persistIssue(db, repoRef, parsed);
      issueCount++;
    }
    console.log(`✓ Issues: ${issueCount} persisted`);

    // 5. Pull requests
    let prCount = 0;
    let commitCount = 0;
    for await (const parsed of fetchPullRequests(owner, name, since)) {
      commitCount += parsed.commits.length;
      await persistPullRequest(db, repoRef, parsed);
      prCount++;
    }
    console.log(`✓ Pull requests: ${prCount} persisted (${commitCount} commits)`);

    // 6. Discussions
    let discussionCount = 0;
    for await (const parsed of fetchDiscussions(owner, name, since)) {
      await persistDiscussion(db, repoRef, parsed);
      discussionCount++;
    }
    console.log(`✓ Discussions: ${discussionCount} persisted`);

    // 7. Comments — three sequential sub-passes
    const kinds = ["issue", "pull_request", "discussion"] as const;
    for (const kind of kinds) {
      let commentCount = 0;
      let tombstoneCount = 0;

      const fetchFn =
        kind === "issue"
          ? fetchCommentsForIssue
          : kind === "pull_request"
            ? fetchCommentsForPullRequest
            : fetchCommentsForDiscussion;

      const kindLabel =
        kind === "issue" ? "issues" : kind === "pull_request" ? "PRs" : "discussions";

      const sinceFilter = since ? ' AND updated_at > $since' : '';
      const [parents] = await db.query<
        [Array<{ id: unknown; number: number; github_node_id: string }>]
      >(
        `SELECT id, number, github_node_id FROM ${kind} WHERE repo = $repoRef AND deleted_at IS NONE${sinceFilter}`,
        { repoRef: new StringRecordId(repoRef.id), ...(since ? { since } : {}) },
      );

      for (const parent of parents) {
        const remoteIds: string[] = [];
        for await (const c of fetchFn(owner, name, parent.number, since)) {
          await persistComment(db, c);
          remoteIds.push(c.github_node_id);
          commentCount++;
        }
        const { tombstoned } = await tombstoneMissingComments(
          db,
          parent.github_node_id,
          kind,
          remoteIds,
        );
        tombstoneCount += tombstoned;
      }

      console.log(
        `✓ Comments (${kindLabel}): ${commentCount} persisted, ${tombstoneCount} tombstoned`,
      );
    }

    // 8. Cross-refs
    const {
      same_repo_refs: S,
      cross_repo_refs_resolved: X,
      cross_repo_refs_dangling: D,
    } = await extractAndLinkCrossRefs(db, repoRef);
    console.log(`✓ Cross-refs: ${S} same-repo, ${X} cross-repo, ${D} dangling`);

    // 9. Discussion answer links
    const { resolved: R, pending: P } = await resolveDiscussionAnswerLinks(db, repoRef);
    console.log(`✓ Answer links: ${R} resolved, ${P} pending`);

    // 10. Materialize dangling refs
    const { materialized: M } = await materializeDanglingReferences(db, repoRef);
    console.log(`✓ Dangling materialized: ${M}`);

    // 11. Set last_synced_at to the timestamp captured at sync start
    await db.query("UPDATE $id SET last_synced_at = $syncStartedAt", {
      id: new StringRecordId(repoRef.id),
      syncStartedAt,
    });
    const ts = fmtTimestamp(syncStartedAt);
    console.log(`✓ Sync complete: ${repoRef.name_with_owner} @ ${ts}`);
  });
}
