import { createTool } from "@cline/sdk";

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

export const getDiff = createTool<{ owner: string; repo: string; base: string; head: string; token: string }, { success: boolean; total_commits?: number; files?: any[]; error?: string }>({
  name: "get_diff",
  description: "Get the diff of a pull request from GitHub",
  inputSchema: {
    type: "object",
    properties: {
      owner: { type: "string" },
      repo: { type: "string" },
      base: { type: "string" },
      head: { type: "string" },
      token: { type: "string" },
    },
    required: ["owner", "repo", "base", "head", "token"],
  },
  execute: async ({ owner, repo, base, head, token }) => {
    try {
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
        success: true,
        total_commits: response.total_commits,
        files,
      };
    } catch (err: any) {
      return { success: false, error: err.message || String(err) };
    }
  },
});

export const createPullRequest = createTool<{ owner: string; repo: string; title: string; body: string; head: string; base: string; token: string }, { success: boolean; number?: number; url?: string; state?: string; error?: string }>({
  name: "create_pull_request",
  description: "Create a pull request on GitHub",
  inputSchema: {
    type: "object",
    properties: {
      owner: { type: "string" },
      repo: { type: "string" },
      title: { type: "string" },
      body: { type: "string" },
      head: { type: "string" },
      base: { type: "string" },
      token: { type: "string" },
    },
    required: ["owner", "repo", "title", "body", "head", "base", "token"],
  },
  execute: async ({ owner, repo, title, body, head, base, token }) => {
    try {
      const pr = await githubFetch(
        `/repos/${owner}/${repo}/pulls`,
        token,
        {
          method: "POST",
          body: JSON.stringify({ title, body, head, base }),
        }
      );

      return {
        success: true,
        number: pr.number,
        url: pr.html_url,
        state: pr.state,
      };
    } catch (err: any) {
      return { success: false, error: err.message || String(err) };
    }
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

import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";

const execAsync = promisify(exec);

export async function ensureGitWorkspace(options: {
  owner: string;
  repo: string;
  token: string;
  branch: string;
  repoUrl?: string;
  workspaceDir: string;
}): Promise<void> {
  const { owner, repo, token, branch, repoUrl, workspaceDir } = options;
  await fs.mkdir(path.dirname(workspaceDir), { recursive: true });

  let exists = false;
  try {
    await fs.access(workspaceDir);
    exists = true;
  } catch {}

  if (!exists) {
    const remoteUrl = repoUrl || `https://github.com/${owner}/${repo}`;
    const authedUrl = remoteUrl.replace("https://", `https://x-access-token:${token}@`);
    await execAsync(`git clone -b ${branch} ${authedUrl} "${workspaceDir}"`);
  } else {
    await execAsync(`git fetch origin && git checkout ${branch} && git pull origin ${branch}`, { cwd: workspaceDir });
  }
}

