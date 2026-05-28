import { ClineCore } from "@cline/sdk";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { parseRepoUrl, getDefaultBranch } from "../tools/utils.js";
import { K8sSandbox } from "../tools/sandbox.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface IssueFixerResult {
  success: boolean;
  prUrl?: string;
  summary: string;
}

export async function runIssueFixer(
  repoUrl: string,
  issueUrl: string | undefined,
  description: string,
  token: string
): Promise<IssueFixerResult> {
  const { owner, repo } = parseRepoUrl(repoUrl);
  console.log(`[Goal Fixer] Starting issue fixer for ${owner}/${repo}`);
  const workspaceParentDir = path.join(__dirname, "../workspaces");
  await fs.mkdir(workspaceParentDir, { recursive: true });

  const sandbox = new K8sSandbox();
  
  const baseBranch = await getDefaultBranch(owner, repo, token);
  console.log(`[Goal Fixer] Default branch is "${baseBranch}". Initializing sandbox...`);
  
  const workspaceDir = await sandbox.init(repoUrl, token, baseBranch, workspaceParentDir);

  const branchName = `fix/issue-${Date.now()}`;
  console.log(`[Goal Fixer] Checking out branch "${branchName}"`);
  await sandbox.exec(`git checkout -b ${branchName}`);

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
  const statusRes = await sandbox.exec(`git status --porcelain`);
  if (statusRes.stdout.trim() === "") {
    console.log(`[Goal Fixer] No changes made by the agent.`);
    await sandbox.destroy();
    return { success: false, summary: "No changes made by the agent.\n\n" + summary };
  }

  console.log(`[Goal Fixer] Changes found. Committing and pushing branch "${branchName}"...`);
  await sandbox.exec(`git config user.name "Mavrick Bot"`);
  await sandbox.exec(`git config user.email "mavrick-bot@users.noreply.github.com"`);

  await sandbox.exec(`git add .`);
  await sandbox.exec(`git commit -m "Fix: ${description.split("\n")[0].substring(0, 50)}"`);
  await sandbox.exec(`git -c credential.helper= push origin ${branchName}`);

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
    await sandbox.destroy();
    throw new Error(`Failed to create PR: ${prData.message || JSON.stringify(prData)}`);
  }

  console.log(`[Goal Fixer] Pull Request successfully created at: ${prData.html_url}`);
  await sandbox.destroy();
  
  return {
    success: true,
    prUrl: prData.html_url,
    summary: "PR successfully created.\n\n" + summary
  };
}
