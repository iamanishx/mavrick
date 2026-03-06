import { anthropic } from "@ai-sdk/anthropic";
import { ToolLoopAgent, stepCountIs, tool } from "ai";
import { z } from "zod";
import { runRepoMasterAgent, RepoMasterResult } from "./repo-master.js";
import type { TaskProgress } from "../tools/cat-client.js";

const model = anthropic("claude-sonnet-4-5");

export interface SuperOrchestratorCallOptions {
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

export interface SuperOrchestratorResult {
  summary: string;
  repoMaster?: RepoMasterResult;
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

export async function runSuperOrchestratorAgent(
  options: SuperOrchestratorCallOptions,
  abortSignal?: AbortSignal
): Promise<SuperOrchestratorResult> {
  const { owner, repo, repoUrl, branch, taskInput, token, repoId, base, head, rootRunId, runId } = options;
  let repoMaster: RepoMasterResult | undefined;

  const delegateTool = tool({
    description: "Delegate repository execution to Repo Master agent",
    inputSchema: z.object({
      owner: z.string(),
      repo: z.string(),
      repoUrl: z.string(),
      branch: z.string(),
      taskInput: z.string(),
      token: z.string(),
      repoId: z.number().optional(),
      base: z.string().optional(),
      head: z.string().optional(),
      rootRunId: z.string().optional(),
      runId: z.string().optional(),
    }),
    execute: async (args: SuperOrchestratorCallOptions) => {
      repoMaster = await runRepoMasterAgent(args, abortSignal);
      return {
        summary: repoMaster.summary,
        success: repoMaster.success,
      };
    },
  });

  const agent = new ToolLoopAgent({
    model,
    callOptionsSchema,
    instructions: `You are Super Orchestrator. Route requests to Repo Master and return its final summary.

Required workflow:
1. Call delegateToRepoMaster exactly once.
2. Return a concise summary of the delegated result.`,
    stopWhen: stepCountIs(30),
    tools: {
      delegateToRepoMaster: delegateTool,
    },
  });

  const prompt = `Task: ${taskInput}
Repository: ${owner}/${repo}
Branch: ${branch}

Route this task to Repo Master and provide the final summary.`;

  const result = await agent.generate({
    options: {
      owner,
      repo,
      repoUrl,
      branch,
      taskInput,
      token,
      repoId,
      base,
      head,
      rootRunId,
      runId,
    },
    prompt,
    abortSignal,
  });

  const output = result as unknown as { text?: string };

  return {
    summary: repoMaster?.summary || output.text || "Super Orchestrator completed",
    repoMaster,
    success: repoMaster?.success ?? false,
  };
}
