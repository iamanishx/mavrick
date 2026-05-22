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

interface RunContext {
  rootRunId?: string;
  runId?: string;
}

function createId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now()}_${rand}`;
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

export async function handleNewTask(thread: Thread, messageText: string, runContext?: RunContext): Promise<void> {
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

  const now = new Date().toISOString();
  let run = runContext?.runId ? repoDb.getRun(runContext.runId) : undefined;

  if (!run && runContext?.runId) {
    try {
      run = repoDb.createChildRun(runContext.runId, {
        id: createId("run"),
        status: "pending",
        source: "discord",
        sourceRef: threadId,
        taskInput,
        startedAt: now,
      });
    } catch {
      run = undefined;
    }
  }

  if (!run) {
    run = repoDb.createRun({
      id: createId("run"),
      repoId: dbRepo.id,
      parentRunId: null,
      rootRunId: runContext?.rootRunId,
      status: "pending",
      source: "discord",
      sourceRef: threadId,
      taskInput,
      startedAt: now,
    });
  }

  repoDb.bindChannel({
    id: createId("bind"),
    runId: run.id,
    platform: "discord",
    channelId: thread.channelId,
    threadId,
    externalRef: guildId || threadId,
  });

  repoDb.appendEvent({
    id: createId("evt"),
    runId: run.id,
    eventType: "discord.message.received",
    source: "discord",
    sourceRef: threadId,
    tsUtc: now,
    payload: JSON.stringify({
      taskType,
      taskInput,
      owner,
      repo,
      threadId,
      sessionId: session.id,
    }),
  });

  await testQueue.add("process-task", {
    owner,
    repo,
    taskInput,
    taskType,
    threadId,
    installationId,
    sessionId: session.id,
    repoUrl,
    rootRunId: run.root_run_id,
    runId: run.id,
  });

  await thread.post(`Queued: ${taskType} for ${owner}/${repo} (Session: ${session.id}, Run: ${run.id})`);
}
