export function parseRepoUrl(repoUrl: string): { owner: string; repo: string } {
  const match = repoUrl.match(/github\.com\/([^/]+)\/([^/]+)/);
  if (!match) {
    throw new Error("Invalid GitHub repository URL");
  }
  const owner = match[1];
  const repo = match[2].replace(/\.git$/, "");
  return { owner, repo };
}

export async function getDefaultBranch(owner: string, repo: string, token: string): Promise<string> {
  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
    headers: {
      "Authorization": `token ${token}`,
      "Accept": "application/vnd.github.v3+json",
      "User-Agent": "goal-issue-fixer"
    }
  });

  if (!response.ok) {
    return "main";
  }

  const data = await response.json() as { default_branch?: string };
  return data.default_branch || "main";
}
