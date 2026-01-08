import { Context } from "probot";
import { openai } from "@ai-sdk/openai";
import { RalphLoopAgent, iterationCountIs } from "ralph-loop-agent";
import { tool } from "ai";
import { z } from "zod";
import { DockerSandbox } from "./sandbox";

/**
 * Runs the autonomous test generation agent inside a secure Docker sandbox.
 * 
 * @param repoUrl - The clone URL of the repository.
 * @param token - The GitHub installation access token.
 * @param branch - The branch to check out.
 * @param prNum - The pull request number.
 * @param owner - The repository owner.
 * @param repo - The repository name.
 * @param headRef - The head reference (branch name) of the PR.
 * @param octokit - The authenticated Octokit instance.
 * @returns The URL of the newly created Pull Request with tests.
 */
export async function runAgentInDocker(
  repoUrl: string, 
  token: string, 
  branch: string, 
  prNum: number,
  owner: string,
  repo: string,
  headRef: string,
  octokit: any
) {
  const sandbox = new DockerSandbox();
  
  try {
    await sandbox.init(repoUrl, token, branch);

    const agent = new RalphLoopAgent({
      model: openai("gpt-4o"),
      instructions: `You are an autonomous test engineer working inside a Docker container.
      Location: /app (The cloned repository).
      Goal: Write robust integration tests (Jest/Vitest).
      Process:
      1. Explore files with 'read_file' or 'list_files'.
      2. Write a test file with 'write_file'.
      3. Run the test with 'execute_command' (e.g. 'npm test' or 'npx jest').
      4. If it fails, read the error, fix the test, and retry.
      5. Only when tests pass locally, stop.`,
      stopWhen: iterationCountIs(10),
      tools: {
        read_file: tool({
          description: "Read a file from the sandbox",
          parameters: z.object({ filePath: z.string() }),
          execute: async (args: any) => ({ content: await sandbox.readFile(args.filePath) }),
        } as any),
        write_file: tool({
          description: "Write or update a file in the sandbox",
          parameters: z.object({ filePath: z.string(), content: z.string() }),
          execute: async (args: any) => {
            await sandbox.writeFile(args.filePath, args.content);
            return { success: true };
          },
        } as any),
        list_files: tool({
          description: "List files in a directory",
          parameters: z.object({ directory: z.string().default(".") }),
          execute: async (args: any) => {
            const res = await sandbox.exec(`ls -F ${args.directory}`);
            return { files: res.stdout.split("\n").filter(Boolean) };
          },
        } as any),
        execute_command: tool({
          description: "Run a shell command in the sandbox",
          parameters: z.object({ command: z.string() }),
          execute: async (args: any) => {
            const res = await sandbox.exec(args.command);
            return { success: res.exitCode === 0, stdout: res.stdout, stderr: res.stderr };
          },
        } as any),
      },
      verifyCompletion: async ({ result }) => {
        const lastOutput = (result as any).text?.toLowerCase() || "";
        return { 
          complete: lastOutput.includes("tests passed") || lastOutput.includes("verified"), 
          reason: "Run tests locally and confirm they pass." 
        };
      },
    });

    await agent.loop({
      prompt: `Analyze the changes in PR #${prNum} and add integration tests. Run them to verify correctness.`,
    });

    const newBranch = `axeai-tests/${prNum}-${Date.now()}`;
    await sandbox.exec(`git checkout -b ${newBranch}`);
    await sandbox.exec('git add .');
    await sandbox.exec('git commit -m "chore: add autonomous tests"');
    
    const cleanRepoUrl = repoUrl.replace(/^https?:\/\//, "");
    const authUrl = `https://x-access-token:${token}@${cleanRepoUrl}`;
    
    const pushRes = await sandbox.exec(`git push ${authUrl} ${newBranch}`);
    if (pushRes.exitCode !== 0) {
        throw new Error(`Failed to push: ${pushRes.stderr}`);
    }

    const { data: newPr } = await octokit.pulls.create({
      owner, repo, title: `test: Autonomous tests for PR #${prNum}`, head: newBranch, base: headRef,
      body: `Tests generated and verified in a secure Docker sandbox using Ralph Loop.`,
    });

    return newPr.html_url;

  } finally {
    await sandbox.destroy();
  }
}
