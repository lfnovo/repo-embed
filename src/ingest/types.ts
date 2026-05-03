export type RepoRef = {
  id: string;
  name_with_owner: string;
};

export type ParsedUser = {
  github_node_id: string;
  login: string;
  is_bot: boolean;
  github_url: string;
};

export type ParsedLabel = {
  github_node_id: string;
  name: string;
  color: string;
  description: string | null;
};
