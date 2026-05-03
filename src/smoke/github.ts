import { gh } from "../clients/github.ts";

const query = `
  query($owner: String!, $name: String!) {
    repository(owner: $owner, name: $name) {
      name
      description
      owner { login }
    }
  }
`;

type QueryResult = {
  repository: {
    name: string;
    description: string | null;
    owner: { login: string };
  };
};

try {
  const result = await gh<QueryResult>(query, {
    owner: "lfnovo",
    name: "esperanto",
  });
  const repo = result.repository;

  console.log("✓ GitHub GraphQL reachable.");
  console.log(`  ${repo.owner.login}/${repo.name}`);
  if (repo.description) console.log(`  ${repo.description}`);
  process.exit(0);
} catch (err) {
  console.error("✗ GitHub smoke test failed.");
  console.error(err);
  process.exit(1);
}
