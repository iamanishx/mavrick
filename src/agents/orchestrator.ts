import { anthropic } from "@ai-sdk/anthropic";
import { ToolLoopAgent, stepCountIs, tool, zodSchema } from "ai";
import { z } from "zod";
import { runPlannerAgent, TestPlan } from "./planner";
import { runCoderAgent, CoderOutput } from "./coder";
import { ReviewerAgent } from "./reviewer";
import { DockerSandbox } from "../tools/sandbox";
import { repoDb } from "../tools/db";

const claudeModel = anthropic("claude-sonnet-4-5");

export interface OrchestratorCallOptions {
  repoUrl: string;
  branch: string;
  owner: string;
  repo: string;
  taskInput: string;
  token: string;
  base?: string;
  head?: string;
  repoId?: number;
}

export interface OrchestratorResult {
  summary: string;
  testPlan?: TestPlan;
  coderOutput?: CoderOutput;
  reviewOutput?: any;
  success: boolean;
}

const callOptionsSchema = z.object({
  repoUrl: z.string().describe("GitHub repository URL"),
  branch: z.string().describe("Branch to work on"),
  owner: z.string().describe("Repository owner"),
  repo: z.string().describe("Repository name"),
  taskInput: z.string().describe("User task description"),
  token: z.string().describe("GitHub token for API calls"),
  base: z.string().optional().describe("Base branch for PR comparison"),
  head: z.string().optional().describe("Head branch for PR comparison"),
  repoId: z.number().optional().describe("Repository ID for memory"),
});

export async function runOrchestratorAgent(
  options: OrchestratorCallOptions,
  abortSignal?: AbortSignal
): Promise<OrchestratorResult> {
  const {
    repoUrl,
    branch,
    owner,
    repo,
    taskInput,
    token,
    base = "main",
    head = branch,
    repoId,
  } = options;

  let testPlan: TestPlan | undefined;
  let coderOutput: CoderOutput | undefined;
  let reviewOutput: any;

  const planTaskTool = tool({
    description: "Delegate to Planner subagent to analyze the repository and create a test plan",
    inputSchema: zodSchema(
      z.object({
        repoUrl: z.string(),
        branch: z.string(),
        owner: z.string(),
        repo: z.string(),
        token: z.string(),
        base: z.string(),
        head: z.string(),
      })
    ),
    execute: async (args: {
      repoUrl: string;
      branch: string;
      owner: string;
      repo: string;
      token: string;
      base: string;
      head: string;
    }) => {
      const result = await runPlannerAgent({
        repoUrl: args.repoUrl,
        branch: args.branch,
        owner: args.owner,
        repo: args.repo,
        token: args.token,
        base: args.base,
        head: args.head,
      });
      testPlan = result;
      return {
        summary: result.summary,
        filesToTest: result.filesToTest,
        testStrategy: result.testStrategy,
        coverageAreas: result.coverageAreas,
      };
    },
  });

  const generateTestsTool = tool({
    description: "Delegate to Coder subagent to generate integration tests based on the test plan",
    inputSchema: zodSchema(
      z.object({
        testPlan: z.string().describe("The test plan from the planner"),
        repoUrl: z.string(),
        token: z.string(),
        branch: z.string(),
      })
    ),
    execute: async (args: { testPlan: string; repoUrl: string; token: string; branch: string }) => {
      const result = await runCoderAgent({
        testPlan: args.testPlan,
        repoUrl: args.repoUrl,
        token: args.token,
        branch: args.branch,
      });
      coderOutput = result;
      return {
        summary: result.summary,
        testsGenerated: result.testsGenerated,
        testsPassed: result.testsPassed,
      };
    },
  });

  const reviewOutputTool = tool({
    description: "Delegate to Reviewer subagent to validate generated tests for quality and correctness",
    inputSchema: zodSchema(
      z.object({
        testFiles: z.array(z.string()).describe("Array of test file paths to review"),
        repoPath: z.string().optional().describe("Repository path in sandbox"),
      })
    ),
    execute: async (args: { testFiles: string[]; repoPath?: string }) => {
      const sandbox = new DockerSandbox();
      try {
        await sandbox.init(repoUrl, token, branch);
        const reviewer = new ReviewerAgent(sandbox);
        const result = await reviewer.review({
          testFiles: args.testFiles,
          repoPath: args.repoPath,
        });
        reviewOutput = result;
        return {
          passed: result.passed,
          summary: result.summary,
          issues: result.issues,
        };
      } finally {
        await sandbox.destroy();
      }
    },
  });

  const memoryTool = tool({
    description: "Save and retrieve persistent memory for the repository",
    inputSchema: zodSchema(
      z.object({
        action: z.enum(["save", "get", "getAll"]).describe("The memory action"),
        key: z.string().optional().describe("Memory key"),
        value: z.string().optional().describe("Memory value (for save)"),
      })
    ),
    execute: async (args: { action: "save" | "get" | "getAll"; key?: string; value?: string }) => {
      if (!repoId) {
        return { error: "repoId is required for memory operations" };
      }
      switch (args.action) {
        case "save": {
          if (!args.key || !args.value) {
            throw new Error("key and value are required for save");
          }
          repoDb.setMemory(repoId, args.key, args.value);
          return { success: true, message: `Saved: ${args.key}` };
        }
        case "get": {
          if (!args.key) throw new Error("key is required for get");
          const value = repoDb.getMemory(repoId, args.key);
          return { key: args.key, value: value ?? null };
        }
        case "getAll": {
          const memories = repoDb.getAllMemory(repoId);
          return { memories };
        }
        default:
          throw new Error(`Unknown action: ${args.action}`);
      }
    },
  });

  const agent = new ToolLoopAgent({
    model: claudeModel,
    callOptionsSchema,
    instructions: `You are the Orchestrator agent - the central coordinator for the AxeAI test generation system.

Your role is to coordinate the workflow between subagents to generate integration tests for GitHub PRs.

Workflow:
1. First, use the 'planTask' tool to analyze the repository and create a test plan based on PR changes
2. Then, use 'generateTests' tool to delegate to the Coder subagent to generate tests based on the plan
3. Finally, use 'reviewOutput' tool to validate the generated tests for quality
4. Optionally, use 'memory' tool to save/retrieve context across sessions

Call options (provided at runtime):
- repoUrl: GitHub repository URL
- branch: Branch to work on
- owner: Repository owner
- repo: Repository name  
- taskInput: User's task description
- token: GitHub token
- base: Base branch for comparison (default: main)
- head: Head branch for comparison (default: current branch)
- repoId: Repository ID for memory operations

Important:
- Coordinate the workflow but don't do the work yourself - delegate to subagents`,
    stopWhen: stepCountIs(30),
    tools: {
      planTask: planTaskTool,
      generateTests: generateTestsTool,
      reviewOutput: reviewOutputTool,
      memory: memoryTool,
    },
  });

  const testPlanStr = testPlan
    ? `Summary: ${testPlan.summary}\nFiles: ${testPlan.filesToTest.join(", ")}\nStrategy: ${testPlan.testStrategy}`
    : "No test plan yet";

  const prompt = `Task: ${taskInput}

Repository: ${owner}/${repo}
Branch: ${branch}
Base: ${base}
Head: ${head}

${testPlanStr}

Please coordinate the test generation workflow:
1. If no test plan exists, call planTask to analyze the repo and create a test plan
2. Once you have a test plan, call generateTests to create the tests
3. After tests are generated, call reviewOutput to validate them
4. Use memory tool to save important context

Execute the workflow step by step.`;

  const result = await agent.generate({
    options,
    prompt,
    abortSignal,
  });

  const output = result as unknown as {
    text: string;
    toolResults?: Array<{
      toolName: string;
      result?: any;
    }>;
  };

  return {
    summary: output.text || "Orchestrator completed workflow",
    testPlan,
    coderOutput,
    reviewOutput,
    success: !!coderOutput?.testsPassed,
  };
}
