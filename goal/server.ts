import express from "express";
import type { Request, Response } from "express";
import { ClineCore } from "@cline/sdk";
import dotenv from "dotenv";
import path from "path";
import fs from "fs/promises";
import { exec } from "child_process";
import { promisify } from "util";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, "../.env") });

const execAsync = promisify(exec);
const app = express();
app.use(express.json());

const PORT = process.env.GOAL_PORT || 3001;

function parseRepoUrl(repoUrl: string): { owner: string; repo: string } {
  const match = repoUrl.match(/github\.com\/([^/]+)\/([^/]+)/);
  if (!match) {
    throw new Error("Invalid GitHub repository URL");
  }
  const owner = match[1];
  const repo = match[2].replace(/\.git$/, "");
  return { owner, repo };
}

async function getDefaultBranch(owner: string, repo: string, token: string): Promise<string> {
  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
    headers: {
      "Authorization": `token ${token}`,
      "Accept": "application/vnd.github.v3+json",
      "User-Agent": "goal-issue-fixer"
    }
  });

  if (!response.ok) {
    return "main";
  }

  const data = await response.json() as { default_branch?: string };
  return data.default_branch || "main";
}

async function runIssueFixer(
  repoUrl: string,
  issueUrl: string | undefined,
  description: string,
  token: string
): Promise<{ success: boolean; prUrl?: string; summary: string }> {
  const { owner, repo } = parseRepoUrl(repoUrl);
  console.log(`[Goal Fixer] Starting issue fixer for ${owner}/${repo}`);
  const workspaceParentDir = path.join(__dirname, "workspaces");
  await fs.mkdir(workspaceParentDir, { recursive: true });

  const workspaceDir = path.join(workspaceParentDir, `goal_${owner}_${repo}_${Date.now()}`);
  const authedUrl = `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;

  const baseBranch = await getDefaultBranch(owner, repo, token);
  console.log(`[Goal Fixer] Default branch is "${baseBranch}". Cloning...`);
  await execAsync(`git -c credential.helper= clone -b ${baseBranch} "${authedUrl}" "${workspaceDir}"`);
  await execAsync(`git config credential.helper ""`, { cwd: workspaceDir });

  const branchName = `fix/issue-${Date.now()}`;
  console.log(`[Goal Fixer] Checked out branch "${branchName}"`);
  await execAsync(`git checkout -b ${branchName}`, { cwd: workspaceDir });

  const tasksFilePath = path.join(workspaceDir, "tasks.md");
  const maxIterations = 10;
  let completed = false;
  let summary = "";

  let sessionId: string | undefined;

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    let tasksFileExists = false;
    try {
      await fs.access(tasksFilePath);
      tasksFileExists = true;
    } catch {
      tasksFileExists = false;
    }

    let prompt = "";
    if (!tasksFileExists) {
      prompt = `Please analyze the codebase and the issue description:
"${description}"

Write a step-by-step implementation plan into a new file named \`tasks.md\` at the root of the workspace.
Format \`tasks.md\` as a markdown checklist (e.g., \`- [ ] Task 1\`).
Do not make any other changes in this iteration. Call the submit_and_exit tool when the checklist is written.`;
    } else {
      const currentTasks = await fs.readFile(tasksFilePath, "utf8");
      prompt = `Please read the issue description:
"${description}"

And read the task list in \`tasks.md\`:
\`\`\`markdown
${currentTasks}
\`\`\`

Pick the next uncompleted task, implement the changes, run tests or verify the fix, update the task in \`tasks.md\` to marked checked (\`- [x]\`), and call submit_and_exit.
If all tasks in \`tasks.md\` are completed and verified, output the exact string: <promise>COMPLETE</promise> and call submit_and_exit.`;
    }

    console.log(`[Goal Fixer] Iteration ${iteration}/${maxIterations}: Initializing ClineCore agent...`);
    const cline = await ClineCore.create({ clientName: "goal-issue-fixer", backendMode: "local" });

    try {
      console.log(`[Goal Fixer] Iteration ${iteration}/${maxIterations}: Starting agent session...`);
      let session;
      if (iteration === 1) {
        session = await cline.start({
          prompt,
          config: {
            providerId: "deepseek",
            modelId: process.env.DEEPSEEK_MODEL_ID || "deepseek-v4-flash",
            apiKey: process.env.DEEPSEEK_API_KEY || "",
            cwd: workspaceDir,
            systemPrompt: "You are an autonomous coding assistant fixing issues in a GitHub workspace. Always verify your work by running commands and tests. Complete exactly one task per turn.",
            enableTools: true,
            enableSpawnAgent: false,
            enableAgentTeams: false,
          }
        });
      } else {
        const messages = await cline.readMessages(sessionId!);
        session = await cline.start({
          prompt,
          initialMessages: messages,
          config: {
            providerId: "deepseek",
            modelId: process.env.DEEPSEEK_MODEL_ID || "deepseek-v4-flash",
            apiKey: process.env.DEEPSEEK_API_KEY || "",
            cwd: workspaceDir,
            systemPrompt: "You are an autonomous coding assistant fixing issues in a GitHub workspace. Always verify your work by running commands and tests. Complete exactly one task per turn.",
            enableTools: true,
            enableSpawnAgent: false,
            enableAgentTeams: false,
          }
        });
      }

      sessionId = session.sessionId;
      const resultText = session.result?.text || "";
      summary += `Iteration ${iteration} result:\n${resultText}\n\n`;
      console.log(`[Goal Fixer] Iteration ${iteration}/${maxIterations} finished.`);

      if (resultText.includes("<promise>COMPLETE</promise>")) {
        console.log(`[Goal Fixer] Agent signaled completion with <promise>COMPLETE</promise>`);
        completed = true;
        break;
      }

      try {
        const tasksContent = await fs.readFile(tasksFilePath, "utf8");
        const hasUncompleted = tasksContent.includes("- [ ]");
        const hasTasks = tasksContent.includes("- [x]") || hasUncompleted;
        if (hasTasks && !hasUncompleted) {
          console.log(`[Goal Fixer] All tasks in tasks.md are marked completed.`);
          completed = true;
          break;
        }
      } catch {}

    } catch (err: any) {
      console.log(`[Goal Fixer] Error in iteration ${iteration}:`, err.message || String(err));
      summary += `Error in iteration ${iteration}: ${err.message || String(err)}\n\n`;
    } finally {
      await cline.dispose();
    }
  }

  console.log(`[Goal Fixer] Checking repository status for changes...`);
  const { stdout: gitStatus } = await execAsync(`git status --porcelain`, { cwd: workspaceDir });
  if (gitStatus.trim() === "") {
    console.log(`[Goal Fixer] No changes made by the agent.`);
    return { success: false, summary: "No changes made by the agent.\n\n" + summary };
  }

  console.log(`[Goal Fixer] Changes found. Committing and pushing branch "${branchName}"...`);
  await execAsync(`git config user.name "AxeAI Bot"`, { cwd: workspaceDir });
  await execAsync(`git config user.email "axeai-bot@users.noreply.github.com"`, { cwd: workspaceDir });

  await execAsync(`git add .`, { cwd: workspaceDir });
  await execAsync(`git commit -m "Fix: ${description.split("\n")[0].substring(0, 50)}"`, { cwd: workspaceDir });
  await execAsync(`git -c credential.helper= push origin ${branchName}`, { cwd: workspaceDir });

  console.log(`[Goal Fixer] Branch pushed. Creating Pull Request...`);
  const prRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls`, {
    method: "POST",
    headers: {
      "Authorization": `token ${token}`,
      "Accept": "application/vnd.github.v3+json",
      "Content-Type": "application/json",
      "User-Agent": "goal-issue-fixer"
    },
    body: JSON.stringify({
      title: `Fix: ${description.split("\n")[0].substring(0, 50)}`,
      body: `This PR was automatically generated by the autonomous issue fixer agent.\n\n### Issue Description\n${description}\n\n### Verification Status\nChecklist tasks completed.\n\n### Logs\n\`\`\`\n${summary}\n\`\`\``,
      head: branchName,
      base: baseBranch
    })
  });

  const prData = await prRes.json() as { html_url?: string; message?: string };
  if (!prRes.ok) {
    console.error(`[Goal Fixer] Failed to create Pull Request:`, prData.message || JSON.stringify(prData));
    throw new Error(`Failed to create PR: ${prData.message || JSON.stringify(prData)}`);
  }

  console.log(`[Goal Fixer] Pull Request successfully created at: ${prData.html_url}`);
  return {
    success: true,
    prUrl: prData.html_url,
    summary: "PR successfully created.\n\n" + summary
  };
}

app.post("/run", async (req: Request, res: Response) => {
  req.socket.setTimeout(30 * 60 * 1000);
  const { repoUrl, issueUrl, description, token } = req.body;

  if (!repoUrl || !description || !token) {
    return res.status(400).json({ error: "Missing required fields (repoUrl, description, token)" });
  }

  console.log(`[Goal Server] Received run request for repo: ${repoUrl}`);
  try {
    const result = await runIssueFixer(repoUrl, issueUrl, description, token);
    console.log(`[Goal Server] Request completed successfully.`);
    return res.json(result);
  } catch (error: any) {
    console.error(`[Goal Server] Error handling request:`, error.message || String(error));
    return res.status(500).json({ error: error.message || String(error) });
  }
});

const server = app.listen(PORT, () => {
  console.log(`Goal Issue Fixer server listening on port ${PORT}`);
});

server.keepAliveTimeout = 30 * 60 * 1000;
server.headersTimeout = 30 * 60 * 1000 + 1000;
if ('requestTimeout' in server) {
  (server as any).requestTimeout = 30 * 60 * 1000;
}
