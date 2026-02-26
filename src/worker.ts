import { Worker, Job } from "bullmq";
import { runOrchestratorAgent } from "./agents/orchestrator";
import { repoDb } from "./tools/db";

async function getInstallationToken(installationId: number): Promise<string> {
  const appId = process.env.GITHUB_APP_ID;
  const privateKey = process.env.GITHUB_PRIVATE_KEY?.replace(/\\n/g, "\n") || process.env.PRIVATE_KEY?.replace(/\\n/g, "\n");
  
  if (!appId || !privateKey) {
    throw new Error("GITHUB_APP_ID and GITHUB_PRIVATE_KEY are required");
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

  const crypto = await import("crypto");
  const sign = crypto.createSign("RSA-SHA256");
  sign.update(`${header}.${payload}`);
  const signature = sign.sign(privateKey, "base64url");

  return `${header}.${payload}.${signature}`;
}

const worker = new Worker(
  "test-generation",
  async (job: Job) => {
    const { owner, repo, taskInput, threadId, installationId, branch, repoUrl, base, sessionId } = job.data;

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
    };

    let result;
    try {
      result = await runOrchestratorAgent(callOptions);
      repoDb.updateSession(session.id, {
        status: result.success ? "completed" : "failed",
        result: JSON.stringify(result),
      });
    } catch (error) {
      repoDb.updateSession(session.id, {
        status: "failed",
        result: JSON.stringify({ error: (error as Error).message }),
      });
      throw error;
    }

    if (threadId && process.env.DISCORD_BOT_TOKEN) {
      try {
        await fetch(`https://discord.com/api/v10/channels/${threadId}/messages`, {
          method: "POST",
          headers: {
            Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            content: result.success
              ? `✅ Tests generated successfully!\n\n${result.summary}`
              : `❌ Test generation failed.\n\n${result.summary}`,
          }),
        });
      } catch (postError) {
        console.error("Failed to post result to Discord:", postError);
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
