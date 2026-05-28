import express from "express";
import type { Request, Response } from "express";
import { ClineCore } from "@cline/sdk";
import dotenv from "dotenv";
import path from "path";
import fs from "fs/promises";
import fsSync from "fs";
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

function parsePrUrl(
    prUrl: string,
): { owner: string; repo: string; pullNumber: number } {
    const match = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
    if (!match) {
        throw new Error("Invalid GitHub Pull Request URL");
    }
    return {
        owner: match[1],
        repo: match[2].replace(/\.git$/, ""),
        pullNumber: parseInt(match[3], 10),
    };
}

async function getPullRequestDetails(
    owner: string,
    repo: string,
    pullNumber: number,
    token: string,
) {
    const response = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/pulls/${pullNumber}`,
        {
            headers: {
                "Authorization": `token ${token}`,
                "Accept": "application/vnd.github.v3+json",
                "User-Agent": "goal-issue-fixer",
            },
        },
    );
    if (!response.ok) {
        throw new Error(`Failed to fetch PR details: ${response.statusText}`);
    }
    const data = await response.json() as any;
    return {
        headBranch: data.head.ref,
        baseBranch: data.base.ref,
        title: data.title,
        body: data.body || "",
    };
}

async function getPullRequestDiff(
    owner: string,
    repo: string,
    pullNumber: number,
    token: string,
): Promise<string> {
    const response = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/pulls/${pullNumber}`,
        {
            headers: {
                "Authorization": `token ${token}`,
                "Accept": "application/vnd.github.v3.diff",
                "User-Agent": "goal-issue-fixer",
            },
        },
    );
    if (!response.ok) {
        return "";
    }
    return await response.text();
}

async function getDefaultBranch(
    owner: string,
    repo: string,
    token: string,
): Promise<string> {
    const response = await fetch(
        `https://api.github.com/repos/${owner}/${repo}`,
        {
            headers: {
                "Authorization": `token ${token}`,
                "Accept": "application/vnd.github.v3+json",
                "User-Agent": "goal-issue-fixer",
            },
        },
    );

    if (!response.ok) {
        return "main";
    }

    const data = await response.json() as { default_branch?: string };
    return data.default_branch || "main";
}

async function runIssueFixer(
    repoUrl: string | undefined,
    issueUrl: string | undefined,
    prUrl: string | undefined,
    description: string,
    token: string,
    onLog: (message: string) => void,
): Promise<{ success: boolean; prUrl?: string; summary: string }> {
    const log = (message: string) => {
        console.log(message);
        onLog(message);
    };

    let owner = "";
    let repo = "";
    let branchName = "";
    let baseBranch = "";
    let isExistingPr = false;
    let prDiff = "";

    if (prUrl) {
        isExistingPr = true;
        const parsed = parsePrUrl(prUrl);
        owner = parsed.owner;
        repo = parsed.repo;
        log(
            `[Goal Fixer] Existing PR mode enabled for PR #${parsed.pullNumber} (${owner}/${repo})`,
        );

        const prDetails = await getPullRequestDetails(
            owner,
            repo,
            parsed.pullNumber,
            token,
        );
        branchName = prDetails.headBranch;
        baseBranch = prDetails.baseBranch;
        prDiff = await getPullRequestDiff(
            owner,
            repo,
            parsed.pullNumber,
            token,
        );
    } else if (repoUrl) {
        const parsed = parseRepoUrl(repoUrl);
        owner = parsed.owner;
        repo = parsed.repo;
        log(
            `[Goal Fixer] Scratch mode enabled for repository ${owner}/${repo}`,
        );
        baseBranch = await getDefaultBranch(owner, repo, token);
        branchName = `fix/issue-${Date.now()}`;
    } else {
        throw new Error("Either repoUrl or prUrl must be provided");
    }

    const workspaceParentDir = path.join(__dirname, "workspaces");
    await fs.mkdir(workspaceParentDir, { recursive: true });

    const workspaceDir = path.join(
        workspaceParentDir,
        `goal_${owner}_${repo}_${Date.now()}`,
    );
    const authedUrl =
        `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;

    if (isExistingPr) {
        log(
            `[Goal Fixer] Cloning Head branch "${branchName}" for existing PR...`,
        );
        await execAsync(
            `git -c credential.helper= clone -b ${branchName} "${authedUrl}" "${workspaceDir}"`,
        );
        await execAsync(`git config credential.helper ""`, {
            cwd: workspaceDir,
        });
    } else {
        log(
            `[Goal Fixer] Default branch is "${baseBranch}". Cloning...`,
        );
        await execAsync(
            `git -c credential.helper= clone -b ${baseBranch} "${authedUrl}" "${workspaceDir}"`,
        );
        await execAsync(`git config credential.helper ""`, {
            cwd: workspaceDir,
        });

        log(`[Goal Fixer] Checked out branch "${branchName}"`);
        await execAsync(`git checkout -b ${branchName}`, { cwd: workspaceDir });
    }

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
            if (isExistingPr) {
                prompt =
                    `Please analyze the codebase, the existing Pull Request details, and the new requirements:
"${description}"

Here is the existing Pull Request Diff:
\`\`\`diff
${prDiff}
\`\`\`

Write a step-by-step implementation plan into a new file named \`tasks.md\` at the root of the workspace.
Format \`tasks.md\` as a markdown checklist (e.g., \`- [ ] Task 1\`).
Do not make any other changes in this iteration. Call the submit_and_exit tool when the checklist is written.`;
            } else {
                prompt = `Please analyze the codebase and the issue description:
"${description}"

Write a step-by-step implementation plan into a new file named \`tasks.md\` at the root of the workspace.
Format \`tasks.md\` as a markdown checklist (e.g., \`- [ ] Task 1\`).
Do not make any other changes in this iteration. Call the submit_and_exit tool when the checklist is written.`;
            }
        } else {
            const currentTasks = await fs.readFile(tasksFilePath, "utf8");
            if (isExistingPr) {
                prompt = `Please read the requested changes:
"${description}"

Here is the existing Pull Request Diff for your reference:
\`\`\`diff
${prDiff}
\`\`\`

And read the task list in \`tasks.md\`:
\`\`\`markdown
${currentTasks}
\`\`\`

Pick the next uncompleted task, implement the changes, run tests or verify the fix, update the task in \`tasks.md\` to marked checked (\`- [x]\`), and call submit_and_exit.
If all tasks in \`tasks.md\` are completed and verified, output the exact string: <promise>COMPLETE</promise> and call submit_and_exit.`;
            } else {
                prompt = `Please read the issue description:
"${description}"

And read the task list in \`tasks.md\`:
\`\`\`markdown
${currentTasks}
\`\`\`

Pick the next uncompleted task, implement the changes, run tests or verify the fix, update the task in \`tasks.md\` to marked checked (\`- [x]\`), and call submit_and_exit.
If all tasks in \`tasks.md\` are completed and verified, output the exact string: <promise>COMPLETE</promise> and call submit_and_exit.`;
            }
        }

        log(
            `[Goal Fixer] Iteration ${iteration}/${maxIterations}: Initializing ClineCore agent...`,
        );
        const cline = await ClineCore.create({
            clientName: "goal-issue-fixer",
            backendMode: "local",
        });

        try {
            log(
                `[Goal Fixer] Iteration ${iteration}/${maxIterations}: Starting agent session...`,
            );
            let session;
            if (iteration === 1) {
                session = await cline.start({
                    prompt,
                    config: {
                        providerId: "deepseek",
                        modelId: process.env.DEEPSEEK_MODEL_ID ||
                            "deepseek-v4-flash",
                        apiKey: process.env.DEEPSEEK_API_KEY || "",
                        cwd: workspaceDir,
                        systemPrompt:
                            "You are an autonomous coding assistant fixing issues in a GitHub workspace. Always verify your work by running commands and tests. Complete exactly one task per turn.",
                        enableTools: true,
                        enableSpawnAgent: false,
                        enableAgentTeams: false,
                    },
                });
            } else {
                const messages = await cline.readMessages(sessionId!);
                session = await cline.start({
                    prompt,
                    initialMessages: messages,
                    config: {
                        providerId: "deepseek",
                        modelId: process.env.DEEPSEEK_MODEL_ID ||
                            "deepseek-v4-flash",
                        apiKey: process.env.DEEPSEEK_API_KEY || "",
                        cwd: workspaceDir,
                        systemPrompt:
                            "You are an autonomous coding assistant fixing issues in a GitHub workspace. Always verify your work by running commands and tests. Complete exactly one task per turn.",
                        enableTools: true,
                        enableSpawnAgent: false,
                        enableAgentTeams: false,
                    },
                });
            }

            sessionId = session.sessionId;
            const resultText = session.result?.text || "";
            summary += `Iteration ${iteration} result:\n${resultText}\n\n`;
            log(
                `[Goal Fixer] Iteration ${iteration}/${maxIterations} finished.`,
            );

            if (resultText.includes("<promise>COMPLETE</promise>")) {
                log(
                    `[Goal Fixer] Agent signaled completion with <promise>COMPLETE</promise>`,
                );
                completed = true;
                break;
            }

            try {
                const tasksContent = await fs.readFile(tasksFilePath, "utf8");
                const hasUncompleted = tasksContent.includes("- [ ]");
                const hasTasks = tasksContent.includes("- [x]") ||
                    hasUncompleted;
                if (hasTasks && !hasUncompleted) {
                    log(
                        `[Goal Fixer] All tasks in tasks.md are marked completed.`,
                    );
                    completed = true;
                    break;
                }
            } catch {}
        } catch (err: any) {
            log(
                `[Goal Fixer] Error in iteration ${iteration}: ${
                    err.message || String(err)
                }`,
            );
            summary += `Error in iteration ${iteration}: ${
                err.message || String(err)
            }\n\n`;
        } finally {
            await cline.dispose();
        }
    }

    log(`[Goal Fixer] Checking repository status for changes...`);
    const { stdout: gitStatus } = await execAsync(`git status --porcelain`, {
        cwd: workspaceDir,
    });
    if (gitStatus.trim() === "") {
        log(`[Goal Fixer] No changes made by the agent.`);
        return {
            success: false,
            summary: "No changes made by the agent.\n\n" + summary,
        };
    }

    log(
        `[Goal Fixer] Changes found. Committing and pushing branch "${branchName}"...`,
    );
    await execAsync(`git config user.name "Mavrick Bot"`, {
        cwd: workspaceDir,
    });
    await execAsync(`git config user.email "bot@mavrick.com"`, {
        cwd: workspaceDir,
    });

    await execAsync(`git add .`, { cwd: workspaceDir });
    await execAsync(
        `git commit -m "Fix: ${description.split("\n")[0].substring(0, 50)}"`,
        { cwd: workspaceDir },
    );
    await execAsync(`git -c credential.helper= push origin ${branchName}`, {
        cwd: workspaceDir,
    });

    if (isExistingPr) {
        log(
            `[Goal Fixer] Existing PR head branch successfully updated.`,
        );
        return {
            success: true,
            prUrl: prUrl,
            summary:
                "Successfully committed and pushed updates directly to the existing PR head branch.\n\n" +
                summary,
        };
    }

    log(`[Goal Fixer] Branch pushed. Creating Pull Request...`);
    const prRes = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/pulls`,
        {
            method: "POST",
            headers: {
                "Authorization": `token ${token}`,
                "Accept": "application/vnd.github.v3+json",
                "Content-Type": "application/json",
                "User-Agent": "goal-issue-fixer",
            },
            body: JSON.stringify({
                title: `Fix: ${description.split("\n")[0].substring(0, 50)}`,
                body:
                    `This PR was automatically generated by the autonomous issue fixer agent.\n\n### Issue Description\n${description}\n\n### Verification Status\nChecklist tasks completed.\n\n### Logs\n\`\`\`\n${summary}\n\`\`\``,
                head: branchName,
                base: baseBranch,
            }),
        },
    );

    const prData = await prRes.json() as {
        html_url?: string;
        message?: string;
    };
    if (!prRes.ok) {
        log(
            `[Goal Fixer] Failed to create Pull Request: ${
                prData.message || JSON.stringify(prData)
            }`,
        );
        throw new Error(
            `Failed to create PR: ${prData.message || JSON.stringify(prData)}`,
        );
    }

    log(
        `[Goal Fixer] Pull Request successfully created at: ${prData.html_url}`,
    );
    return {
        success: true,
        prUrl: prData.html_url,
        summary: "PR successfully created.\n\n" + summary,
    };
}

interface JobState {
    status: "queued" | "running" | "completed" | "failed";
    prUrl?: string;
    summary?: string;
    error?: string;
}

const jobsDir = path.join(__dirname, "jobs");
if (!fsSync.existsSync(jobsDir)) {
    fsSync.mkdirSync(jobsDir, { recursive: true });
}

async function updateJobMetadata(jobId: string, updates: Partial<JobState>) {
    const metadataPath = path.join(jobsDir, `${jobId}.json`);
    let current: JobState = { status: "queued" };
    try {
        const content = await fs.readFile(metadataPath, "utf8");
        current = JSON.parse(content);
    } catch {}
    const updated = { ...current, ...updates };
    await fs.writeFile(metadataPath, JSON.stringify(updated, null, 2));
}

async function appendJobLog(jobId: string, message: string) {
    const logPath = path.join(jobsDir, `${jobId}.jsonl`);
    const logEntry = {
        timestamp: new Date().toISOString(),
        message,
    };
    await fs.appendFile(logPath, `${JSON.stringify(logEntry)}\n`);
}

const jobQueue: { jobId: string; run: () => Promise<void> }[] = [];
let activeRuns = 0;
const MAX_CONCURRENT_RUNS = 3;

async function processQueue() {
    if (activeRuns >= MAX_CONCURRENT_RUNS || jobQueue.length === 0) return;

    activeRuns++;
    const nextJob = jobQueue.shift()!;

    console.log(
        `[Queue] Starting Job ${nextJob.jobId}. Active runs: ${activeRuns}`,
    );
    await updateJobMetadata(nextJob.jobId, { status: "running" });

    try {
        await nextJob.run();
    } catch (err: any) {
        console.error(
            `[Queue] Job ${nextJob.jobId} failed:`,
            err.message || String(err),
        );
    } finally {
        activeRuns--;
        console.log(
            `[Queue] Finished Job ${nextJob.jobId}. Active runs: ${activeRuns}`,
        );
        processQueue();
    }
}

app.post("/run", (req: Request, res: Response) => {
    const { repoUrl, issueUrl, prUrl, description, token } = req.body;

    if ((!repoUrl && !prUrl) || !description || !token) {
        return res.status(400).json({
            error:
                "Missing required fields (either repoUrl or prUrl must be provided, along with description and token)",
        });
    }

    const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    console.log(`[Server] Received request. Enqueuing Job: ${jobId}`);

    updateJobMetadata(jobId, { status: "queued" })
        .then(() => {
            jobQueue.push({
                jobId,
                run: async () => {
                    try {
                        const result = await runIssueFixer(
                            repoUrl,
                            issueUrl,
                            prUrl,
                            description,
                            token,
                            async (message) => {
                                await appendJobLog(jobId, message);
                            },
                        );
                        await updateJobMetadata(jobId, {
                            status: "completed",
                            prUrl: result.prUrl,
                            summary: result.summary,
                        });
                    } catch (error: any) {
                        await updateJobMetadata(jobId, {
                            status: "failed",
                            error: error.message || String(error),
                        });
                    }
                },
            });

            processQueue();
        })
        .catch((err) => {
            console.error(`[Server] Failed to enqueue Job:`, err);
        });

    return res.status(202).json({
        jobId,
        status: "queued",
        message:
            "Your issue-fixing job has been enqueued. Poll the status endpoint to check progress.",
    });
});

app.get("/status/:jobId", async (req: Request, res: Response) => {
    const { jobId } = req.params;
    const metadataPath = path.join(jobsDir, `${jobId}.json`);
    const logPath = path.join(jobsDir, `${jobId}.jsonl`);

    try {
        const metadataContent = await fs.readFile(metadataPath, "utf8");
        const metadata = JSON.parse(metadataContent);

        let logs: string[] = [];
        try {
            const logContent = await fs.readFile(logPath, "utf8");
            logs = logContent
                .trim()
                .split("\n")
                .filter(Boolean)
                .map((line) => {
                    const entry = JSON.parse(line);
                    return `[${entry.timestamp}] ${entry.message}`;
                });
        } catch {}

        return res.json({
            ...metadata,
            logs,
        });
    } catch {
        return res.status(404).json({ error: "Job not found" });
    }
});

const server = app.listen(PORT, () => {
    console.log(`Goal Issue Fixer server listening on port ${PORT}`);
});

server.keepAliveTimeout = 30 * 60 * 1000;
server.headersTimeout = 30 * 60 * 1000 + 1000;
if ("requestTimeout" in server) {
    (server as any).requestTimeout = 30 * 60 * 1000;
}
