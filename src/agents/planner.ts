import { openai } from "@ai-sdk/openai";
import { ToolLoopAgent, stepCountIs, tool } from "ai";
import { z } from "zod";
import { ContainedSandbox } from "contained-sandbox";

export interface PlannerInput {
  repoUrl: string;
  branch: string;
  owner: string;
  repo: string;
  token: string;
  base: string;
  head: string;
  containedBinaryPath?: string;
  rootfsPath?: string;
}

export interface TestPlan {
  summary: string;
  filesToTest: string[];
  testStrategy: string;
  coverageAreas: string[];
}

async function fetchDiff(owner: string, repo: string, base: string, head: string, token: string) {
  const GITHUB_API_BASE = "https://api.github.com";
  const response = await fetch(`${GITHUB_API_BASE}/repos/${owner}/${repo}/compare/${base}...${head}`, {
    headers: {
      "Accept": "application/vnd.github.v3+json",
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`GitHub API error: ${response.status} ${response.statusText} - ${error}`);
  }

  const data = await response.json();
  const files = data.files?.map((file: any) => ({
    filename: file.filename,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    patch: file.patch,
  })) || [];

  return {
    total_commits: data.total_commits,
    files,
  };
}

export async function runPlannerAgent(input: PlannerInput): Promise<TestPlan> {
  const sandbox = new ContainedSandbox({
    ...(input.containedBinaryPath ? { binaryPath: input.containedBinaryPath } : {}),
    ...(input.rootfsPath ? { rootfsPath: input.rootfsPath } : {}),
  });

  try {
    await sandbox.init(input.repoUrl, input.token, input.branch);

    const agent = new ToolLoopAgent({
      model: openai("gpt-4.1-mini"),
      instructions: `You are a Planner subagent that analyzes repositories and creates test plans.
Your goal is to understand the codebase structure and identify what needs testing based on PR changes.

Process:
1. First, get the PR diff using gitDiff to understand what files changed
2. Explore the project structure using listDirectory (package.json, src/, tests/ etc.)
3. Read key files to understand the codebase (especially package.json for test framework)
4. Identify the files that were modified and understand their purpose
5. Determine what test coverage is needed
6. Create a test plan with files to test, strategy, and coverage areas`,
      stopWhen: stepCountIs(20),
      tools: {
        readFile: tool({
          description: "Read the complete contents of a file from the repository",
          inputSchema: z.object({
            path: z.string(),
          }),
          execute: async ({ path }) => {
            const content = await sandbox.readFile(path);
            return { content };
          },
        }),

        listDirectory: tool({
          description: "List directory contents to understand project structure",
          inputSchema: z.object({
            path: z.string(),
          }),
          execute: async ({ path }) => {
            const entries = await sandbox.listDirectory(path);
            return { entries };
          },
        }),

        searchCode: tool({
          description: "Search for patterns in code files",
          inputSchema: z.object({
            pattern: z.string(),
            path: z.string().optional(),
          }),
          execute: async ({ pattern, path = "." }) => {
            const files = await sandbox.searchFiles(path, pattern);
            return { files };
          },
        }),

        gitDiff: tool({
          description: "Get the diff/changes from a pull request to understand what needs testing",
          inputSchema: z.object({
            owner: z.string(),
            repo: z.string(),
            base: z.string(),
            head: z.string(),
            token: z.string(),
          }),
          execute: async (args) => {
            return await fetchDiff(args.owner, args.repo, args.base, args.head, args.token);
          },
        }),
      },
    });

    const diffResult: any = await fetchDiff(input.owner, input.repo, input.base, input.head, input.token);

    const changedFiles = diffResult?.files?.map((f: any) => f.filename) || [];

    const packageJsonResult = await sandbox.readFile("package.json");
    const srcEntries = await sandbox.listDirectory("src").catch(() => [] as Array<{ name: string }>);
    const testEntries = await sandbox.listDirectory("tests").catch(() => [] as Array<{ name: string }>);
    const testSrcEntries = await sandbox.listDirectory("__tests__").catch(() => [] as Array<{ name: string }>);

    const changedFilesSummary = changedFiles.length > 0
      ? changedFiles.join("\n- ")
      : "No files changed";

    const testPlanContent = `
PR #${input.head} Analysis:
Changed files:
- ${changedFilesSummary}

Project structure:
 - src/: ${srcEntries.map((e) => e.name).join(", ") || "N/A"}
 - tests/: ${testEntries.map((e) => e.name).join(", ") || "N/A"}
 - __tests__/: ${testSrcEntries.map((e) => e.name).join(", ") || "N/A"}

Package.json:
${packageJsonResult}

Based on the above analysis, create a test plan identifying:
1. Which files need tests
2. What test strategy to use (unit, integration, e2e)
3. What coverage areas are important`.trim();

    await agent.generate({
      prompt: testPlanContent,
    });

    const summary = `Analyzed ${changedFiles.length} changed files in ${input.owner}/${input.repo}. Identified test coverage needs for: ${changedFiles.slice(0, 5).join(", ")}${changedFiles.length > 5 ? "..." : ""}`;

    const filesToTest = changedFiles.filter((f: string) =>
      !f.includes("package.json") && !f.includes("README")
    );

    const testStrategy = changedFiles.some((f: string) => f.includes("api") || f.includes("server"))
      ? "Integration tests with API mocking"
      : "Unit tests with Jest/Vitest";

    const coverageAreasSet = new Set(changedFiles.map((f: string) => {
      if (f.includes("src/")) {
        const parts = f.replace("src/", "").split("/");
        return parts[0] || "core";
      }
      return "root";
    }));
    const coverageAreas = Array.from(coverageAreasSet) as string[];

    return {
      summary,
      filesToTest,
      testStrategy,
      coverageAreas,
    };
  } finally {
    await sandbox.destroy();
  }
}
