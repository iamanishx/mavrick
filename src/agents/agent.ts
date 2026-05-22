import { ClineCore } from "@cline/sdk";
import { repoDb } from "../tools/db.js";
import { ensureGitWorkspace } from "../tools/github.js";
import path from "path";

export interface RunAgentOptions {
  owner: string;
  repo: string;
  taskInput: string;
  token: string;
  sessionId: number;
  runId: string;
  branch?: string;
  base?: string;
  repoUrl?: string;
  onProgress?: (status: string) => Promise<void>;
}

const AXE_SYSTEM_PROMPT = `You are AxeAI, an autonomous agentic bot designed to help developers by writing integration tests and resolving issues in GitHub repositories.

Your mission:
1. Explore the workspace, locate the code files that need testing, and understand the existing test suite.
2. Formulate a comprehensive plan to write or fix the integration tests.
3. Write clean, complete, robust integration tests.
4. Execute the test suite using standard commands (e.g., npm test, bun test, pytest) using the bash tool to verify they pass.
5. If tests fail, diagnose the issue, correct the tests (or the code), and re-run until all tests pass.
6. Commit your changes, push to a new branch, and create a Pull Request on GitHub.

Rules:
- Never use placeholder code; always write complete, high-quality production code.
- Write tests using the project's existing testing framework and style guidelines.
- Always verify your work by running the tests.
- When you are finished, summarize your work clearly and list the files changed and the PR created.`;

export async function runAxeAgent(options: RunAgentOptions): Promise<{ success: boolean; summary: string }> {
  const {
    owner,
    repo,
    taskInput,
    token,
    sessionId,
    runId,
    branch,
    base,
    repoUrl,
    onProgress,
  } = options;

  const repoConfig = repoDb.getOrCreateRepo(owner, repo, 0);

  // Set up local workspace path on the host
  const workspaceDir = path.join(process.cwd(), "data", "workspace", `${owner}_${repo}`);
  const targetBranch = branch || repoConfig.defaultBranch;

  await ensureGitWorkspace({
    owner,
    repo,
    token,
    branch: targetBranch,
    repoUrl,
    workspaceDir,
  });


  if (onProgress) await onProgress("Initializing ClineCore instance...");

  const cline = await ClineCore.create({ clientName: "axeai", backendMode: "local" });

  // Stream status events from ClineCore to the progress callback
  const unsubscribe = cline.subscribe((event) => {
    if (event.type === "status") {
      if (onProgress) {
        onProgress(`Agent Status: ${event.payload.status}`).catch(() => { });
      }
    } else if (event.type === "hook") {
      if (onProgress && event.payload.toolName) {
        onProgress(`Executing built-in tool: ${event.payload.toolName}`).catch(() => { });
      }
    }
  });

  const clineSessionIdKey = `__cline_session_id__:${sessionId}`;
  const cachedClineSessionId = repoDb.getMemory(repoConfig.id, clineSessionIdKey);

  try {
    let clineSession;
    let finalResult: any;

    if (cachedClineSessionId) {
      if (onProgress) await onProgress("Resuming existing Cline session...");
      finalResult = await cline.send({
        sessionId: cachedClineSessionId,
        prompt: taskInput,
      });
    } else {
      if (onProgress) await onProgress("Starting new autonomous Cline session...");
      clineSession = await cline.start({
        prompt: `Task: ${taskInput}
Repository: ${owner}/${repo}
Branch: ${targetBranch}
Base: ${base || repoConfig.defaultBranch}

Please explore the workspace, review changes, write integration tests, run them to verify they pass, and commit/push to raise a Pull Request on GitHub.`,
        config: {
          cwd: workspaceDir,
          providerId: "anthropic",
          modelId: "claude-sonnet-4-6",
          apiKey: process.env.ANTHROPIC_API_KEY,
          enableTools: true,
          systemPrompt: AXE_SYSTEM_PROMPT,
          enableSpawnAgent: false,
          enableAgentTeams: false,
        },
      });
      finalResult = clineSession?.result;

      if (clineSession?.sessionId) {
        repoDb.setMemory(repoConfig.id, clineSessionIdKey, clineSession.sessionId, sessionId);
      }
    }

    unsubscribe();
    await cline.dispose();

    const success = finalResult?.finishReason === "completed";
    const summary = finalResult?.text || "Session completed successfully";

    return { success, summary };
  } catch (error) {
    unsubscribe();
    try {
      await cline.dispose();
    } catch { }
    throw error;
  }
}
