import { gh } from "../clients/github.ts";
import { withDb } from "../clients/surreal.ts";

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

export default async function run(args: string[]): Promise<void> {
  const input = args[0];
  if (!input || !/^[^/]+\/[^/]+$/.test(input)) {
    console.error("✗ Usage: tool add <owner/name>");
    process.exit(1);
  }

  const [ownerLogin, repoName] = input.split("/");

  const data = await gh<{ repository: GitHubRepo }>(REPO_QUERY, {
    owner: ownerLogin,
    name: repoName,
  });
  const { repository } = data;
  const owner = repository.owner;

  await withDb(async (db) => {
    // Upsert org
    const [existingOrgs] = await db.query<[Array<{ id: unknown }>]>(
      "SELECT id FROM org WHERE github_node_id = $github_node_id",
      { github_node_id: owner.id },
    );

    let orgId: unknown;
    if (existingOrgs.length === 0) {
      const [created] = await db.query<[Array<{ id: unknown }>]>(
        `CREATE org CONTENT {
          github_node_id: $github_node_id,
          github_url: $github_url,
          login: $login,
          name: $name,
          kind: $kind,
          created_at: $created_at,
          updated_at: $updated_at,
          deleted_at: NONE
        }`,
        {
          github_node_id: owner.id,
          github_url: owner.url,
          login: owner.login,
          name: owner.name,
          kind: owner.__typename,
          created_at: new Date(owner.createdAt),
          updated_at: new Date(owner.updatedAt),
        },
      );
      orgId = created[0].id;
    } else {
      orgId = existingOrgs[0].id;
      await db.query(
        `UPDATE $id SET
          github_url = $github_url,
          login = $login,
          name = $name,
          kind = $kind,
          updated_at = $updated_at`,
        {
          id: orgId,
          github_url: owner.url,
          login: owner.login,
          name: owner.name,
          kind: owner.__typename,
          updated_at: new Date(owner.updatedAt),
        },
      );
    }

    // Upsert repo
    const [existingRepos] = await db.query<
      [Array<{ id: unknown; registered_at: unknown }>]
    >(
      "SELECT id, registered_at FROM repo WHERE github_node_id = $github_node_id",
      { github_node_id: repository.id },
    );

    let repoId: unknown;
    if (existingRepos.length === 0) {
      const [created] = await db.query<[Array<{ id: unknown }>]>(
        `CREATE repo CONTENT {
          github_node_id: $github_node_id,
          github_url: $github_url,
          name: $name,
          name_with_owner: $name_with_owner,
          description: $description,
          is_private: $is_private,
          owner: $owner,
          created_at: $created_at,
          updated_at: $updated_at,
          registered_at: time::now()
        }`,
        {
          github_node_id: repository.id,
          github_url: repository.url,
          name: repoName,
          name_with_owner: repository.nameWithOwner,
          description: repository.description,
          is_private: repository.isPrivate,
          owner: orgId,
          created_at: new Date(repository.createdAt),
          updated_at: new Date(repository.updatedAt),
        },
      );
      repoId = created[0].id;
    } else {
      const existingRepo = existingRepos[0];
      repoId = existingRepo.id;
      const hasRegisteredAt = existingRepo.registered_at != null;

      if (hasRegisteredAt) {
        // Preserve existing registered_at — do not overwrite
        await db.query(
          `UPDATE $id SET
            github_url = $github_url,
            name = $name,
            name_with_owner = $name_with_owner,
            description = $description,
            is_private = $is_private,
            owner = $owner,
            created_at = $created_at,
            updated_at = $updated_at`,
          {
            id: repoId,
            github_url: repository.url,
            name: repoName,
            name_with_owner: repository.nameWithOwner,
            description: repository.description,
            is_private: repository.isPrivate,
            owner: orgId,
            created_at: new Date(repository.createdAt),
            updated_at: new Date(repository.updatedAt),
          },
        );
      } else {
        // registered_at was NONE — set it now to re-register
        await db.query(
          `UPDATE $id SET
            github_url = $github_url,
            name = $name,
            name_with_owner = $name_with_owner,
            description = $description,
            is_private = $is_private,
            owner = $owner,
            created_at = $created_at,
            updated_at = $updated_at,
            registered_at = time::now()`,
          {
            id: repoId,
            github_url: repository.url,
            name: repoName,
            name_with_owner: repository.nameWithOwner,
            description: repository.description,
            is_private: repository.isPrivate,
            owner: orgId,
            created_at: new Date(repository.createdAt),
            updated_at: new Date(repository.updatedAt),
          },
        );
      }
    }

    console.log(`✓ Registered ${repository.nameWithOwner} (${String(repoId)})`);
  });
}
