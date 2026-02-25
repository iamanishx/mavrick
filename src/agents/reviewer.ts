import { anthropic } from "@ai-sdk/anthropic";
import { ToolLoopAgent, stepCountIs, tool, zodSchema } from "ai";
import { z } from "zod";
import { DockerSandbox } from "../tools/sandbox";

const claudeModel = anthropic("claude-sonnet-4-5-20250514");

export interface ReviewerCallOptions {
  testFiles: string[];
  repoPath?: string;
}

export interface ReviewResult {
  passed: boolean;
  summary: string;
  issues: string[];
  coverageAnalysis: string;
  testResults: {
    file: string;
    passed: boolean;
    output: string;
  }[];
}

export class ReviewerAgent {
  private sandbox: DockerSandbox;

  constructor(sandbox: DockerSandbox) {
    this.sandbox = sandbox;
  }

  async review(options: ReviewerCallOptions): Promise<ReviewResult> {
    const agent = new ToolLoopAgent({
      model: claudeModel,
      instructions: `You are a test reviewer agent. Your role is to validate generated tests for quality, correctness, and coverage.

Process:
1. Read each test file using readFile
2. Analyze the test coverage using analyzeTestCoverage - check for:
   - Proper assertions
   - Edge cases
   - Error handling scenarios
   - Async test coverage
3. Run the tests using runTests to verify they pass

Provide a comprehensive review with:
- Whether tests pass (PASS/FAIL)
- Coverage analysis
- Any issues or improvements needed
- Final recommendation`,
      stopWhen: stepCountIs(20),
      tools: {
        readFile: tool({
          description: "Read the complete contents of a generated test file to review its quality",
          inputSchema: zodSchema(
            z.object({
              path: z.string(),
            })
          ),
          execute: async (args: { path: string }) => {
            const fullPath = args.path.startsWith("/")
              ? args.path
              : `${this.sandbox["workingDir"]}/${args.path}`;
            const content = await this.sandbox.readFile(fullPath);
            return { success: true, content };
          },
        }),
        analyzeTestCoverage: tool({
          description: "Analyze what the generated tests cover - functionality, edge cases, error handling",
          inputSchema: zodSchema(
            z.object({
              testFile: z.string(),
              sourceFile: z.string().optional(),
            })
          ),
          execute: async (args: { testFile: string; sourceFile?: string }) => {
            const testContent = await this.sandbox.readFile(args.testFile);
            const hasAssertions = testContent.includes("expect") || testContent.includes("assert");
            const hasErrorHandling = testContent.includes("catch") || testContent.includes("throw");
            const hasEdgeCases = testContent.includes("null") || testContent.includes("undefined") || testContent.includes("empty");
            const hasAsyncTests = testContent.includes("async") || testContent.includes("await");
            const testCount = (testContent.match(/it\(|test\(|describe\(/g) || []).length;
            
            let sourceContent = "";
            if (args.sourceFile) {
              try {
                sourceContent = await this.sandbox.readFile(args.sourceFile);
              } catch {}
            }

            return {
              hasAssertions,
              hasErrorHandling,
              hasEdgeCases,
              hasAsyncTests,
              testCount,
              sourceFileExists: sourceContent.length > 0,
              coverage: {
                basicAssertions: hasAssertions,
                errorHandling: hasErrorHandling,
                edgeCases: hasEdgeCases,
                asyncCoverage: hasAsyncTests,
              },
            };
          },
        }),
        runTests: tool({
          description: "Run the generated tests to verify they pass",
          inputSchema: zodSchema(
            z.object({
              command: z.string().optional(),
            })
          ),
          execute: async (args: { command?: string }) => {
            const testCmd = args.command || `npm test`;
            const result = await this.sandbox.exec(testCmd);
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

    const testFilesList = options.testFiles.join(", ");
    const prompt = `Review the generated test files for quality and correctness.

Test files to review: ${testFilesList}
${options.repoPath ? `Repository path: ${options.repoPath}` : ""}

Read each test file, analyze its coverage, and run the tests to verify they pass.`;

    const result = await agent.generate({
      prompt,
    });

    const output = result as unknown as {
      text: string;
      toolResults?: Array<{
        toolName: string;
        result?: { passed?: boolean; testCount?: number };
      }>;
    };

    const toolResults = output.toolResults;
    const testRun = toolResults?.find((r) => r.toolName === "runTests");
    const hasPassIndicator = testRun?.result?.passed ?? (output.text?.toLowerCase().includes("pass") && !output.text?.toLowerCase().includes("fail"));
    const hasFailIndicator = output.text?.toLowerCase().includes("fail");
    
    const testResults: ReviewResult["testResults"] = options.testFiles.map((file) => ({
      file,
      passed: hasPassIndicator && !hasFailIndicator,
      output: "",
    }));

    return {
      passed: hasPassIndicator && !hasFailIndicator,
      summary: (output.text || "").substring(0, 500),
      issues: hasFailIndicator ? ["Tests failed or have issues"] : [],
      coverageAnalysis: output.text || "",
      testResults,
    };
  }
}
