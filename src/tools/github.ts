import { tool } from "ai";
import { z } from "zod";

const GITHUB_API_BASE = "https://api.github.com";

async function githubFetch(endpoint: string, token: string, options: RequestInit = {}) {
  const response = await fetch(`${GITHUB_API_BASE}${endpoint}`, {
    ...options,
    headers: {
      "Accept": "application/vnd.github.v3+json",
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`GitHub API error: ${response.status} ${response.statusText} - ${error}`);
  }

  return response.json();
}

export const getDiff = tool({
  description: "Get the diff of a pull request from GitHub",
  inputSchema: z.object({
    owner: z.string(),
    repo: z.string(),
    base: z.string(),
    head: z.string(),
    token: z.string(),
  }),
  execute: async ({ owner, repo, base, head, token }) => {
    const response = await githubFetch(
      `/repos/${owner}/${repo}/compare/${base}...${head}`,
      token
    );

    const files = response.files?.map((file: any) => ({
      filename: file.filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      patch: file.patch,
    })) || [];

    return {
      total_commits: response.total_commits,
      files,
    };
  },
});

export const createPullRequest = tool({
  description: "Create a pull request on GitHub",
  inputSchema: z.object({
    owner: z.string(),
    repo: z.string(),
    title: z.string(),
    body: z.string(),
    head: z.string(),
    base: z.string(),
    token: z.string(),
  }),
  execute: async ({ owner, repo, title, body, head, base, token }) => {
    const pr = await githubFetch(
      `/repos/${owner}/${repo}/pulls`,
      token,
      {
        method: "POST",
        body: JSON.stringify({ title, body, head, base }),
      }
    );

    return {
      number: pr.number,
      url: pr.html_url,
      state: pr.state,
    };
  },
});

export const createBranch = (branchName: string) => {
  return `git checkout -b ${branchName}`;
};

export const commit = (files: string[], message: string) => {
  const addFiles = files.length > 0 ? files.join(" ") : ".";
  return `git add ${addFiles} && git commit -F - << 'COMMIT_MSG'\n${message}\nCOMMIT_MSG`;
};

export const push = (remote: string = "origin", branch: string) => {
  return `git push ${remote} ${branch}`;
};

export const githubTools = {
  getDiff,
  createPullRequest,
};
