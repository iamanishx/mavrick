import { ClineCore } from "@cline/sdk";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { parseRepoUrl } from "../tools/utils.js";
import { K8sSandbox } from "../tools/sandbox.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface PrReviewResult {
  success: boolean;
  review: string;
  summary: string;
}

export async function runPrReviewer(
  repoUrl: string,
  prNumber: number,
  token: string
): Promise<PrReviewResult> {
  const { owner, repo } = parseRepoUrl(repoUrl);
  console.log(`[PR Reviewer] Starting review for ${owner}/${repo}#${prNumber}`);
  const workspaceParentDir = path.join(__dirname, "../workspaces");
  await fs.mkdir(workspaceParentDir, { recursive: true });

  const sandbox = new K8sSandbox();

  const prRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`, {
    headers: {
      "Authorization": `token ${token}`,
      "Accept": "application/vnd.github.v3+json",
      "User-Agent": "goal-pr-reviewer"
    }
  });

  if (!prRes.ok) {
    throw new Error(`Failed to fetch PR #${prNumber}: ${prRes.statusText}`);
  }

  const prData = await prRes.json() as { head: { ref: string }; base: { ref: string }; title: string; body: string };
  const headBranch = prData.head.ref;
  const baseBranch = prData.base.ref;
  const prTitle = prData.title;
  const prBody = prData.body || "";

  console.log(`[PR Reviewer] PR "${prTitle}" | ${baseBranch} <- ${headBranch}. Initializing sandbox...`);
  
  const workspaceDir = await sandbox.init(repoUrl, token, headBranch, workspaceParentDir);

  await sandbox.exec(`git fetch origin ${baseBranch}`);
  const diffRes = await sandbox.exec(`git diff origin/${baseBranch}...HEAD`);
  const diffOutput = diffRes.stdout;

  const reviewFilePath = path.join(workspaceDir, "review.md");
  const maxIterations = 5;
  let completed = false;
  let summary = "";

  let sessionId: string | undefined;

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    let reviewFileExists = false;
    try {
      await fs.access(reviewFilePath);
      reviewFileExists = true;
    } catch {
      reviewFileExists = false;
    }

    let prompt = "";
    if (!reviewFileExists) {
      prompt = `You are reviewing a Pull Request for the repository ${owner}/${repo}.

PR Title: "${prTitle}"
PR Description: "${prBody}"
Branch: ${headBranch} -> ${baseBranch}

Here is the diff of all changes:
\`\`\`diff
${diffOutput.substring(0, 50000)}
\`\`\`

Please analyze the codebase and the PR changes. Write a detailed review into a new file named \`review.md\` at the root of the workspace.
Your review should include:
- A checklist of review items (e.g., \`- [ ] Check for security issues\`, \`- [ ] Verify error handling\`, \`- [ ] Check code style\`, etc.)
- A brief summary of what the PR does

Do not make any code changes. Only write the review plan. Call the submit_and_exit tool when done.`;
    } else {
      const currentReview = await fs.readFile(reviewFilePath, "utf8");
      prompt = `You are reviewing a Pull Request for the repository ${owner}/${repo}.

PR Title: "${prTitle}"
PR Description: "${prBody}"

Here is the current review file \`review.md\`:
\`\`\`markdown
${currentReview}
\`\`\`

Pick the next unchecked item in the review checklist. Analyze the codebase and the diff to evaluate that item. Update \`review.md\` with your findings for that item, mark it as checked (\`- [x]\`), and add any specific comments (file paths, line references, suggestions).
If all review items are completed, add a final "## Overall Verdict" section (APPROVE, REQUEST_CHANGES, or COMMENT) with a summary, then output the exact string: <promise>COMPLETE</promise> and call submit_and_exit.`;
    }

    console.log(`[PR Reviewer] Iteration ${iteration}/${maxIterations}: Initializing ClineCore agent...`);
    const cline = await ClineCore.create({ clientName: "goal-pr-reviewer", backendMode: "local" });

    try {
      console.log(`[PR Reviewer] Iteration ${iteration}/${maxIterations}: Starting agent session...`);
      let session;
      if (iteration === 1) {
        session = await cline.start({
          prompt,
          config: {
            providerId: "deepseek",
            modelId: process.env.DEEPSEEK_MODEL_ID || "deepseek-v4-flash",
            apiKey: process.env.DEEPSEEK_API_KEY || "",
            cwd: workspaceDir,
            systemPrompt: "You are an expert code reviewer. Analyze the PR changes thoroughly for bugs, security issues, performance problems, code style, and correctness. Be constructive and specific. Do not modify any source code files - only write to review.md.",
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
            systemPrompt: "You are an expert code reviewer. Analyze the PR changes thoroughly for bugs, security issues, performance problems, code style, and correctness. Be constructive and specific. Do not modify any source code files - only write to review.md.",
            enableTools: true,
            enableSpawnAgent: false,
            enableAgentTeams: false,
          }
        });
      }

      sessionId = session.sessionId;
      const resultText = session.result?.text || "";
      summary += `Iteration ${iteration} result:\n${resultText}\n\n`;
      console.log(`[PR Reviewer] Iteration ${iteration}/${maxIterations} finished.`);

      if (resultText.includes("<promise>COMPLETE</promise>")) {
        console.log(`[PR Reviewer] Agent signaled completion with <promise>COMPLETE</promise>`);
        completed = true;
        break;
      }

      try {
        const reviewContent = await fs.readFile(reviewFilePath, "utf8");
        const hasUncompleted = reviewContent.includes("- [ ]");
        const hasTasks = reviewContent.includes("- [x]") || hasUncompleted;
        if (hasTasks && !hasUncompleted) {
          console.log(`[PR Reviewer] All review items in review.md are marked completed.`);
          completed = true;
          break;
        }
      } catch {}

    } catch (err: any) {
      console.log(`[PR Reviewer] Error in iteration ${iteration}:`, err.message || String(err));
      summary += `Error in iteration ${iteration}: ${err.message || String(err)}\n\n`;
    } finally {
      await cline.dispose();
    }
  }

  let finalReview = "";
  try {
    finalReview = await fs.readFile(reviewFilePath, "utf8");
  } catch {
    finalReview = "Review file was not generated.";
  }

  console.log(`[PR Reviewer] Posting review comment on PR #${prNumber}...`);
  const commentRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}/comments`, {
    method: "POST",
    headers: {
      "Authorization": `token ${token}`,
      "Accept": "application/vnd.github.v3+json",
      "Content-Type": "application/json",
      "User-Agent": "goal-pr-reviewer"
    },
    body: JSON.stringify({
      body: `## Automated PR Review\n\n${finalReview}`
    })
  });

  if (!commentRes.ok) {
    const commentErr = await commentRes.json() as { message?: string };
    console.error(`[PR Reviewer] Failed to post review comment:`, commentErr.message || JSON.stringify(commentErr));
  } else {
    console.log(`[PR Reviewer] Review comment posted successfully.`);
  }

  await sandbox.destroy();

  return {
    success: completed,
    review: finalReview,
    summary
  };
}
