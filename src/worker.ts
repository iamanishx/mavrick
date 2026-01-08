import { Worker, Job } from "bullmq";
import { Probot } from "probot";
import { runAgentInDocker } from "./agent";

const probot = new Probot({
  appId: process.env.APP_ID,
  privateKey: process.env.PRIVATE_KEY,
  secret: process.env.WEBHOOK_SECRET,
});

/**
 * Worker responsible for processing test generation jobs.
 * Handles Probot authentication, Docker sandbox orchestration, and error reporting.
 */
const worker = new Worker("test-generation", async (job: Job) => {
  const { owner, repo, prNumber, installationId, branch, headRef, repoUrl } = job.data;
  
  const octokit = await probot.auth(installationId);

  console.log(`Processing job ${job.id}: PR #${prNumber} for ${owner}/${repo}`);
  
  try {
      const { token } = await octokit.auth({ type: "installation", installationId }) as { token: string };

      const prUrl = await runAgentInDocker(
        repoUrl,
        token,
        branch,
        prNumber,
        owner,
        repo,
        headRef,
        octokit
      );

      console.log(`Job ${job.id} completed. PR: ${prUrl}`);
  } catch (error) {
      console.error(`Job ${job.id} failed:`, error);
      
      await (octokit as any).issues.createComment({
        owner, 
        repo, 
        issue_number: prNumber, 
        body: `Worker failed: ${(error as Error).message}` 
      });
      
      throw error;
  }
}, {
  connection: {
    host: process.env.REDIS_HOST || "localhost",
    port: parseInt(process.env.REDIS_PORT || "6379"),
  },
  concurrency: 2 
});

console.log("Worker started. Listening for jobs...");
