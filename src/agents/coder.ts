import { anthropic } from "@ai-sdk/anthropic";
import { ToolLoopAgent, stepCountIs, tool, zodSchema } from "ai";
import { z } from "zod";
import { DockerSandbox } from "../tools/sandbox";

const model = anthropic("claude-sonnet-4-5");

export interface CoderInput {
  testPlan: string;
  repoUrl: string;
  token: string;
  branch: string;
}

export interface CoderOutput {
  summary: string;
  testsGenerated: string[];
  testsPassed: boolean;
}

export async function runCoderAgent(input: CoderInput): Promise<CoderOutput> {
  const sandbox = new DockerSandbox();
  const generatedFiles: string[] = [];
  let testsPassed = false;

  try {
    await sandbox.init(input.repoUrl, input.token, input.branch);

    const agent = new ToolLoopAgent({
      model,
      instructions: `You are a Coder subagent that generates integration tests based on a test plan.
Working directory: /app (the cloned repository).
Your goal: Write integration tests, run them, and iterate until they pass.

Process:
1. Read the test plan provided to understand what needs to be tested.
2. Explore the codebase to understand existing patterns, test files, and structure.
3. Write test files using the 'writeFile' tool.
4. Install dependencies if needed using 'installDeps'.
5. Run the tests using 'runTests'.
6. If tests fail, analyze errors, fix the tests, and retry.
7. When all tests pass, summarize the results.

Tools available:
- writeFile: Write test files to the sandbox
- readFile: Read existing code to understand patterns  
- runInSandbox: Execute shell commands
- installDeps: Install npm dependencies
- runTests: Run the test suite

Important: All file operations must use the sandbox (not host filesystem).`,
      stopWhen: stepCountIs(20),
      tools: {
        writeFile: tool({
          description: "Write a file to the sandbox. Use this to create test files.",
          inputSchema: zodSchema(
            z.object({
              path: z.string(),
              content: z.string(),
            })
          ),
          execute: async (args: any) => {
            await sandbox.writeFile(args.path, args.content);
            generatedFiles.push(args.path);
            return { success: true, path: args.path };
          },
        }),
        readFile: tool({
          description: "Read a file from the sandbox to understand code patterns.",
          inputSchema: zodSchema(
            z.object({
              path: z.string(),
            })
          ),
          execute: async (args: any) => {
            const content = await sandbox.readFile(args.path);
            return { content };
          },
        }),
        runInSandbox: tool({
          description: "Execute a shell command in the sandbox.",
          inputSchema: zodSchema(
            z.object({
              command: z.string(),
            })
          ),
          execute: async (args: any) => {
            const result = await sandbox.exec(args.command);
            return {
              stdout: result.stdout,
              stderr: result.stderr,
              exitCode: result.exitCode,
            };
          },
        }),
        installDeps: tool({
          description: "Install npm dependencies in the sandbox.",
          inputSchema: zodSchema(
            z.object({
              packages: z.string().optional(),
            })
          ),
          execute: async (args: any) => {
            const command = args.packages
              ? `npm install ${args.packages}`
              : `npm install`;
            const result = await sandbox.exec(`cd /app && ${command}`);
            return {
              success: result.exitCode === 0,
              stdout: result.stdout,
              stderr: result.stderr,
            };
          },
        }),
        runTests: tool({
          description: "Run the test suite in the sandbox.",
          inputSchema: zodSchema(
            z.object({
              command: z.string().optional(),
            })
          ),
          execute: async (args: any) => {
            const testCmd = args.command || `npm test`;
            const result = await sandbox.exec(`cd /app && ${testCmd}`);
            testsPassed = result.exitCode === 0;
            return {
              passed: result.exitCode === 0,
              stdout: result.stdout,
              stderr: result.stderr,
              exitCode: result.exitCode,
            };
          },
        }),
      } as any,
    });

    const result = await agent.generate({
      prompt: `Test Plan:
${input.testPlan}

Generate and run integration tests based on the test plan above. Write test files, install dependencies if needed, and run the tests. Iterate until tests pass.`,
    });

    const output = result as unknown as {
      text: string;
      toolResults?: Array<{
        toolName: string;
        result?: { path?: string; passed?: boolean };
      }>;
    };

    const toolResults = output.toolResults;
    const filesCreated = toolResults
      ?.filter((r) => r.toolName === "writeFile")
      .map((r) => r.result?.path)
      .filter(Boolean) as string[];

    const testRun = toolResults?.find((r) => r.toolName === "runTests");
    const passed = testRun?.result?.passed ?? testsPassed;

    return {
      summary:
        output.text ||
        `Generated ${filesCreated?.length || 0} test files. Tests ${
          passed ? "PASSED" : "need review"
        }.`,
      testsGenerated: filesCreated || generatedFiles,
      testsPassed: passed,
    };
  } finally {
    await sandbox.destroy();
  }
}
