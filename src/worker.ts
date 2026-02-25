import { Worker, Job } from "bullmq";
import { runOrchestratorAgent } from "./agents/orchestrator";
import { repoDb } from "./tools/db";
import { Probot } from "probot";

let probot: Probot | null = null;

function getProbot(): Probot {
  if (!probot) {
    probot = new Probot({
      appId: process.env.GITHUB_APP_ID || process.env.APP_ID,
      privateKey: process.env.GITHUB_PRIVATE_KEY?.replace(/\\n/g, "\n") || process.env.PRIVATE_KEY,
      secret: process.env.WEBHOOK_SECRET,
    });
  }
  return probot;
}

async function getInstallationToken(installationId: number): Promise<string> {
  const probotInstance = getProbot();
  const octokit = await probotInstance.auth(installationId);
  const { token } = await octokit.auth({ type: "installation", installationId }) as { token: string };
  return token;
}

const worker = new Worker(
  "test-generation",
  async (job: Job) => {
    const { owner, repo, taskInput, threadId, installationId, branch, repoUrl, base, sessionId } = job.data;

    if (!installationId) {
      throw new Error("installationId is required");
    }

    const token = await getInstallationToken(installationId);

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
