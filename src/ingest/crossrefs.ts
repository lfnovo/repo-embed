// TODO(#8): full implementation per issue #8

export type CrossRef = {
  owner: string | null;
  repo: string | null;
  number: number;
  isClosing: boolean;
};

export function extractReferences(
  body: string,
  context?: { owner: string; name: string; number: number }
): CrossRef[] {
  // Strip fenced code blocks
  let text = body.replace(/```[\s\S]*?```/g, "");
  // Strip URLs
  text = text.replace(/https?:\/\/\S+/g, "");

  const results: CrossRef[] = [];
  const seen = new Set<string>();
  const closingKeyword = /(?:Fixes|Closes|Resolves)\s+$/i;

  // Cross-repo: owner/repo#N
  const crossRepoRe = /\b([\w-]+)\/([\w.-]+)#(\d+)\b/g;
  let m: RegExpExecArray | null;
  while ((m = crossRepoRe.exec(text)) !== null) {
    const owner = m[1];
    const repo = m[2];
    const num = parseInt(m[3], 10);
    const isClosing = closingKeyword.test(text.slice(0, m.index));
    const key = `${owner}/${repo}#${num}`;
    if (!seen.has(key)) {
      seen.add(key);
      results.push({ owner, repo, number: num, isClosing });
    }
  }

  // Same-repo: #N (not part of a cross-repo pattern or URL path)
  const sameRepoRe = /(?<![/\w])#(\d+)\b/g;
  while ((m = sameRepoRe.exec(text)) !== null) {
    const num = parseInt(m[1], 10);
    if (context && context.number === num) continue;
    const isClosing = closingKeyword.test(text.slice(0, m.index));
    const key = `null/null#${num}`;
    if (!seen.has(key)) {
      seen.add(key);
      results.push({ owner: null, repo: null, number: num, isClosing });
    }
  }

  return results;
}
