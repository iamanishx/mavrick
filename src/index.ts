import { Queue } from "bullmq";
import { repoDb } from "./tools/db";
import type { Thread } from "chat";

const testQueue = new Queue("test-generation", {
  connection: {
    host: process.env.REDIS_HOST || "localhost",
    port: parseInt(process.env.REDIS_PORT || "6379"),
  },
});

interface ParsedTask {
  repoUrl: string;
  owner: string;
  repo: string;
  taskType: string;
  taskInput: string;
}

function parseMessage(text: string): ParsedTask | null {
  const githubUrlMatch = text.match(/https?:\/\/github\.com\/([^\/\s]+)\/([^\/\s]+)/);
  if (!githubUrlMatch) return null;

  const owner = githubUrlMatch[1];
  const repo = githubUrlMatch[2].replace(/\.git$/, "");
  const repoUrl = `https://github.com/${owner}/${repo}`;

  let taskType = "generate-tests";
  let taskInput = text;

  const lowerText = text.toLowerCase();
  if (lowerText.includes("review")) {
    taskType = "review-code";
  } else if (lowerText.includes("test")) {
    taskType = "generate-tests";
  } else if (lowerText.includes("fix") || lowerText.includes("bug")) {
    taskType = "fix-bugs";
  }

  return { repoUrl, owner, repo, taskType, taskInput };
}

function getInstallationId(guildId: string): number {
  const envKey = `GITHUB_INSTALLATION_ID_${guildId}`;
  const installationId = process.env[envKey];
  if (!installationId) {
    return parseInt(process.env.DEFAULT_GITHUB_INSTALLATION_ID || "0", 10);
  }
  return parseInt(installationId, 10);
}

export async function handleNewTask(thread: Thread, messageText: string): Promise<void> {
  const threadId = thread.channelId;
  const guildId = (thread as any).raw?.guild_id || "";

  const parsed = parseMessage(messageText);
  if (!parsed) {
    await thread.post("Please provide a valid GitHub repository URL.");
    return;
  }

  const { owner, repo, taskType, taskInput, repoUrl } = parsed;

  const installationId = getInstallationId(guildId);
  if (!installationId) {
    await thread.post("No GitHub App installation found for this server. Please configure GITHUB_INSTALLATION_ID_<GUILD_ID> environment variable.");
    return;
  }

  const dbRepo = repoDb.getOrCreateRepo(owner, repo, installationId);
  const session = repoDb.createSession(dbRepo.id, taskType, taskInput, threadId);

  await testQueue.add("process-task", {
    owner,
    repo,
    taskInput,
    taskType,
    threadId,
    installationId,
    sessionId: session.id,
    repoUrl,
  });

  await thread.post(`Queued: ${taskType} for ${owner}/${repo} (Session: ${session.id})`);
}
