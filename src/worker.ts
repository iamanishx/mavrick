import { Worker, Job } from "bullmq";
import { runSuperOrchestratorAgent } from "./agents/super-orchestrator.js";
import { repoDb } from "./tools/db.js";
import type { TaskProgress } from "./tools/cat-client.js";

function createId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now()}_${rand}`;
}

async function postProgressToDiscord(
  threadId: string,
  token: string,
  progress: TaskProgress,
  existingMessageId?: string
): Promise<string | undefined> {
  const done = progress.completedTodos.length;
  const total = done + progress.pendingTodos.length + (progress.currentTodo ? 1 : 0);
  const current = progress.currentTodo?.content ?? "...";

  const lines = [
    `**Working on your task** (${done}/${total} steps done)`,
    `> ${current}`,
  ];
  if (progress.failedTodos.length > 0) {
    lines.push(`${progress.failedTodos.length} step(s) had issues`);
  }
  const content = lines.join("\n");

  const baseUrl = `https://discord.com/api/v10`;
  const headers = {
    Authorization: `Bot ${token}`,
    "Content-Type": "application/json",
  };

  if (existingMessageId) {
    await fetch(`${baseUrl}/channels/${threadId}/messages/${existingMessageId}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ content }),
    });
    return existingMessageId;
  }

  const res = await fetch(`${baseUrl}/channels/${threadId}/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify({ content }),
  });

  if (res.ok) {
    const msg = await res.json() as { id: string };
    return msg.id;
  }
  return undefined;
}

async function getInstallationToken(installationId: number): Promise<string> {
  const appId = process.env.GITHUB_APP_ID;
  const privateKey = process.env.GITHUB_PRIVATE_KEY?.replace(/\\n/g, "\n");

  if (!appId || !privateKey) {
    throw new Error("GITHUB_APP_ID and GITHUB_PRIVATE_KEY are required");
  }

  const parsedAppId = parseInt(appId, 10);
  if (!Number.isInteger(parsedAppId) || parsedAppId <= 0) {
    throw new Error(`GITHUB_APP_ID must be a positive integer, got: ${appId}`);
  }

  if (!privateKey.includes("BEGIN") || !privateKey.includes("PRIVATE KEY") || !privateKey.includes("END")) {
    throw new Error("GITHUB_PRIVATE_KEY does not appear to be a valid PEM private key");
  }

  const jwt = await createJWToken(appId, privateKey);

  const response = await fetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/vnd.github+json",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to get installation token: ${response.statusText}`);
  }

  const data = await response.json();
  return data.token;
}

async function createJWToken(appId: string, privateKey: string): Promise<string> {
  const [header, payload] = [
    Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify({
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 600,
      iss: parseInt(appId, 10),
    })).toString("base64url"),
  ];

  let signature: string;
  try {
    const crypto = await import("crypto");
    const sign = crypto.createSign("RSA-SHA256");
    sign.update(`${header}.${payload}`);
    signature = sign.sign(privateKey, "base64url");
  } catch (error) {
    throw new Error(`JWT signing failed (check GITHUB_PRIVATE_KEY format): ${(error as Error).message}`);
  }

  return `${header}.${payload}.${signature}`;
}

const worker = new Worker(
  "test-generation",
  async (job: Job) => {
    const {
      owner,
      repo,
      taskInput,
      threadId,
      installationId,
      branch,
      repoUrl,
      base,
      sessionId,
      rootRunId,
      runId,
    } = job.data;

    if (!installationId) {
      throw new Error("installationId is required");
    }

    let token: string;
    if (process.env.GITHUB_TOKEN) {
      token = process.env.GITHUB_TOKEN;
    } else {
      token = await getInstallationToken(installationId);
    }

    const repoConfig = repoDb.getOrCreateRepo(owner, repo, installationId);
    
    const session = sessionId
      ? repoDb.getSession(sessionId)
      : repoDb.createSession(repoConfig.id, "test-generation", taskInput, threadId ?? undefined);

    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    repoDb.updateSession(session.id, { status: "running" });

    const now = new Date().toISOString();
    let run = runId ? repoDb.getRun(runId) : undefined;
    if (!run) {
      run = repoDb.createRun({
        id: runId || createId("run"),
        repoId: repoConfig.id,
        parentRunId: null,
        rootRunId: rootRunId,
        status: "pending",
        source: "worker",
        sourceRef: "test-generation",
        taskInput,
        startedAt: now,
      });
    }

    repoDb.updateRun(run.id, { status: "running", startedAt: now });
    repoDb.appendEvent({
      id: createId("evt"),
      runId: run.id,
      eventType: "worker.started",
      source: "worker",
      sourceRef: `job:${job.id}`,
      tsUtc: now,
      payload: JSON.stringify({ owner, repo, branch: branch || repoConfig.defaultBranch }),
    });

    const discordToken = process.env.DISCORD_BOT_TOKEN;
    let progressMessageId: string | undefined;

    const onProgress = threadId && discordToken
      ? async (progress: TaskProgress) => {
          try {
            progressMessageId = await postProgressToDiscord(
              threadId, discordToken, progress, progressMessageId
            );
          } catch {}
        }
      : undefined;

    const callOptions = {
      repoUrl: repoUrl || `https://github.com/${owner}/${repo}`,
      branch: branch || repoConfig.defaultBranch,
      owner,
      repo,
      taskInput,
      token,
      base: base || repoConfig.defaultBranch,
      head: branch || repoConfig.defaultBranch,
      repoId: repoConfig.id,
      rootRunId: run.root_run_id,
      runId: run.id,
      onProgress,
    };

    let result;
    try {
      result = await runSuperOrchestratorAgent(callOptions);
      repoDb.updateSession(session.id, {
        status: result.success ? "completed" : "failed",
        result: JSON.stringify(result),
      });
      repoDb.updateRun(run.id, {
        status: result.success ? "completed" : "failed",
        completedAt: new Date().toISOString(),
      });
      repoDb.appendEvent({
        id: createId("evt"),
        runId: run.id,
        eventType: "worker.completed",
        source: "worker",
        sourceRef: `job:${job.id}`,
        tsUtc: new Date().toISOString(),
        payload: JSON.stringify({ success: result.success, summary: result.summary }),
      });
    } catch (error) {
      repoDb.updateSession(session.id, {
        status: "failed",
        result: JSON.stringify({ error: (error as Error).message }),
      });
      repoDb.updateRun(run.id, {
        status: "failed",
        completedAt: new Date().toISOString(),
      });
      repoDb.appendEvent({
        id: createId("evt"),
        runId: run.id,
        eventType: "worker.failed",
        source: "worker",
        sourceRef: `job:${job.id}`,
        tsUtc: new Date().toISOString(),
        payload: JSON.stringify({ error: (error as Error).message }),
      });
      throw error;
    }

    if (threadId && discordToken) {
      try {
        if (progressMessageId) {
          await fetch(
            `https://discord.com/api/v10/channels/${threadId}/messages/${progressMessageId}`,
            { method: "DELETE", headers: { Authorization: `Bot ${discordToken}` } }
          );
        }

        await fetch(`https://discord.com/api/v10/channels/${threadId}/messages`, {
          method: "POST",
          headers: {
            Authorization: `Bot ${discordToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            content: result.success
              ? `Done!\n\n${result.summary}`
              : `Something went wrong.\n\n${result.summary}`,
          }),
        });
        repoDb.appendEvent({
          id: createId("evt"),
          runId: run.id,
          eventType: "discord.message.sent",
          source: "discord",
          sourceRef: threadId,
          tsUtc: new Date().toISOString(),
          payload: JSON.stringify({ success: result.success }),
        });
      } catch (postError) {
        console.warn(`Failed to notify user in Discord thread ${threadId} - user will not be notified of result:`, postError);
        repoDb.appendEvent({
          id: createId("evt"),
          runId: run.id,
          eventType: "discord.notification.failed",
          source: "discord",
          sourceRef: threadId,
          tsUtc: new Date().toISOString(),
          payload: JSON.stringify({ error: (postError as Error).message }),
        });
      }
    }

    return result;
  },
  {
    connection: {
      host: process.env.REDIS_HOST || "localhost",
      port: parseInt(process.env.REDIS_PORT || "6379"),
    },
    concurrency: 2,
  }
);

console.log("Worker started. Listening for jobs...");

export default worker;
