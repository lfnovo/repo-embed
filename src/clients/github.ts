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

export function gh<T>(query: string, params?: RequestParameters): Promise<T> {
  return getGh()<T>(query, params);
}

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
    const params: RequestParameters = cursor
      ? { ...variables, after: cursor }
      : { ...variables };
    const data = await gh<unknown>(query, params);
    const connection = selectConnection(data);
    for (const node of connection.nodes) {
      yield node;
    }
    if (!connection.pageInfo.hasNextPage) break;
    cursor = connection.pageInfo.endCursor;
  }
}
