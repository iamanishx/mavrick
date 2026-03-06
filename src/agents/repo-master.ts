import { anthropic } from "@ai-sdk/anthropic";
import { ToolLoopAgent, stepCountIs, tool } from "ai";
import { z } from "zod";
import { ContainedSandbox } from "contained-sandbox";
import { runPlannerAgent, TestPlan } from "./planner.js";
import { runCoderAgent, CoderOutput } from "./coder.js";
import { ReviewerAgent, ReviewResult } from "./reviewer.js";
import type { TaskProgress } from "../tools/cat-client.js";

const model = anthropic("claude-sonnet-4-5");

export interface RepoMasterCallOptions {
  owner: string;
  repo: string;
  repoUrl: string;
  branch: string;
  taskInput: string;
  token: string;
  repoId?: number;
  base?: string;
  head?: string;
  rootRunId?: string;
  runId?: string;
  onProgress?: (progress: TaskProgress) => void;
}

export interface RepoMasterResult {
  summary: string;
  plan?: TestPlan;
  coder?: CoderOutput;
  review?: ReviewResult;
  success: boolean;
}

const callOptionsSchema = z.object({
  owner: z.string().describe("Repository owner"),
  repo: z.string().describe("Repository name"),
  repoUrl: z.string().describe("GitHub repository URL"),
  branch: z.string().describe("Branch to work on"),
  taskInput: z.string().describe("User task description"),
  token: z.string().describe("GitHub token for API calls"),
  repoId: z.number().optional().describe("Repository ID"),
  base: z.string().optional().describe("Base branch for comparison"),
  head: z.string().optional().describe("Head branch for comparison"),
  rootRunId: z.string().optional().describe("Root run identifier"),
  runId: z.string().optional().describe("Current run identifier"),
});

export async function runRepoMasterAgent(
  options: RepoMasterCallOptions,
  abortSignal?: AbortSignal
): Promise<RepoMasterResult> {
  const { owner, repo, repoUrl, branch, taskInput, token, base = "main", head = branch } = options;
  let plan: TestPlan | undefined;
  let coder: CoderOutput | undefined;
  let review: ReviewResult | undefined;

  const planTaskTool = tool({
    description: "Delegate repository analysis and test planning to Planner agent",
    inputSchema: z.object({
      repoUrl: z.string(),
      branch: z.string(),
      owner: z.string(),
      repo: z.string(),
      token: z.string(),
      base: z.string(),
      head: z.string(),
    }),
    execute: async (args: {
      repoUrl: string;
      branch: string;
      owner: string;
      repo: string;
      token: string;
      base: string;
      head: string;
    }) => {
      plan = await runPlannerAgent(args);
      return {
        summary: plan.summary,
        filesToTest: plan.filesToTest,
        testStrategy: plan.testStrategy,
        coverageAreas: plan.coverageAreas,
      };
    },
  });

  const generateTestsTool = tool({
    description: "Delegate test generation and execution to Coder agent",
    inputSchema: z.object({
      testPlan: z.string(),
      repoUrl: z.string(),
      token: z.string(),
      branch: z.string(),
    }),
    execute: async (args: { testPlan: string; repoUrl: string; token: string; branch: string }) => {
      coder = await runCoderAgent({ ...args, onProgress: options.onProgress });
      return {
        summary: coder.summary,
        testsGenerated: coder.testsGenerated,
        testsPassed: coder.testsPassed,
      };
    },
  });

  const reviewOutputTool = tool({
    description: "Delegate generated test quality validation to Reviewer agent",
    inputSchema: z.object({
      testFiles: z.array(z.string()),
      repoPath: z.string().optional(),
    }),
    execute: async (args: { testFiles: string[]; repoPath?: string }) => {
      const sandbox = new ContainedSandbox();
      try {
        await sandbox.init(repoUrl, token, branch);
        const reviewer = new ReviewerAgent(sandbox);
        review = await reviewer.review(args);
        return {
          passed: review.passed,
          summary: review.summary,
          issues: review.issues,
        };
      } finally {
        await sandbox.destroy();
      }
    },
  });

  const agent = new ToolLoopAgent({
    model,
    callOptionsSchema,
    instructions: `You are Repo Master. Coordinate planner, coder, and reviewer subagents.

Required workflow:
1. Run planTask.
2. Run generateTests with the planner output.
3. Run reviewOutput using generated test files.
4. Return a concise final summary.`,
    stopWhen: stepCountIs(30),
    tools: {
      planTask: planTaskTool,
      generateTests: generateTestsTool,
      reviewOutput: reviewOutputTool,
    },
  });

  const prompt = `Task: ${taskInput}
Repository: ${owner}/${repo}
Branch: ${branch}
Base: ${base}
Head: ${head}

Coordinate planner, coder, and reviewer in order and return the final status.`;

  const result = await agent.generate({
    options,
    prompt,
    abortSignal,
  });

  const output = result as unknown as { text?: string };
  const success = review?.passed ?? coder?.testsPassed ?? false;

  return {
    summary: output.text || review?.summary || coder?.summary || plan?.summary || "Repo Master completed",
    plan,
    coder,
    review,
    success,
  };
}
