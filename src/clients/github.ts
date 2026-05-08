import { graphql } from "@octokit/graphql";
import type { RequestParameters } from "@octokit/types";
import { requireGithubToken } from "../config.ts";

let _gh: typeof graphql | null = null;

function getGh(): typeof graphql {
  if (!_gh) {
    const token = requireGithubToken();
    _gh = graphql.defaults({ headers: { authorization: `token ${token}` } });
  }
  return _gh;
}

export async function gh<T>(query: string, params?: RequestParameters): Promise<T> {
  try {
    return await getGh()<T>(query, params);
  } catch (err: unknown) {
    if (
      err !== null &&
      typeof err === "object" &&
      "status" in err &&
      ((err as { status: unknown }).status === 401 ||
        (err as { status: unknown }).status === 403)
    ) {
      const originalMessage = err instanceof Error ? err.message : String(err);
      // GitHub uses 403 for both auth/scope errors AND rate limits
      // (primary and secondary/abuse). Don't paint a scope-hint over
      // a throttle — surface the original error so the operator sees
      // the rate-limit signal instead of a misleading auth message.
      const looksLikeRateLimit = /rate limit|abuse|secondary rate/i.test(originalMessage);
      if (looksLikeRateLimit) {
        throw err;
      }
      const owner = typeof params?.owner === "string" ? params.owner : null;
      const name = typeof params?.name === "string" ? params.name : null;
      const repo = owner && name ? ` for ${owner}/${name}` : "";
      throw new Error(
        `✗ GitHub access denied${repo}: ${originalMessage}\n  Hint: token may be expired, missing required scope, or not authorized\n        for this org. See README "Private repos" for required scopes.`,
        { cause: err },
      );
    }
    throw err;
  }
}

/**
 * Walks a paginated GraphQL connection, yielding nodes one at a time.
 *
 * The cursor is injected into `variables` under the key `cursor` —
 * your query MUST declare `$cursor: String` and reference it via
 * the connection's `after:` argument. Mismatched variable names are
 * silent in GraphQL: undeclared vars are ignored and the connection
 * restarts from the first page on every iteration, producing an
 * infinite loop.
 *
 * Example:
 * ```graphql
 * query($owner: String!, $name: String!, $cursor: String) {
 *   repository(owner: $owner, name: $name) {
 *     issues(first: 100, after: $cursor) { ... }
 *   }
 * }
 * ```
 */
export async function* paginate<T>(
  query: string,
  variables: Record<string, unknown>,
  selectConnection: (data: unknown) => {
    nodes: T[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  },
): AsyncGenerator<T> {
  let cursor: string | null = null;
  while (true) {
    const params: RequestParameters = { ...variables, cursor };
    const data = await gh<unknown>(query, params);
    const connection = selectConnection(data);
    for (const node of connection.nodes) {
      yield node;
    }
    if (!connection.pageInfo.hasNextPage) break;
    cursor = connection.pageInfo.endCursor;
  }
}
