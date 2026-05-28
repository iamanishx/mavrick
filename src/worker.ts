import { Worker, Job } from "bullmq";
import { connection, QUEUE_NAME } from "./queue.js";
import { runIssueFixer } from "./agents/run.js";
import { runPrReviewer } from "./agents/review.js";

console.log("[Worker] Starting Mavrick BullMQ Worker...");

const worker = new Worker(
  QUEUE_NAME,
  async (job: Job) => {
    const { type, repoUrl, issueUrl, description, prNumber, token } = job.data;
    console.log(`[Worker] Starting job ${job.id} | Type: ${type} | Repo: ${repoUrl}`);

    if (type === "run") {
      try {
        const result = await runIssueFixer(repoUrl, issueUrl, description, token);
        console.log(`[Worker] Job ${job.id} (issue-fixer) completed successfully.`);
        return result;
      } catch (err: any) {
        console.error(`[Worker] Job ${job.id} (issue-fixer) failed:`, err.message || String(err));
        throw err;
      }
    } else if (type === "review") {
      try {
        const result = await runPrReviewer(repoUrl, prNumber, token);
        console.log(`[Worker] Job ${job.id} (pr-reviewer) completed successfully.`);
        return result;
      } catch (err: any) {
        console.error(`[Worker] Job ${job.id} (pr-reviewer) failed:`, err.message || String(err));
        throw err;
      }
    } else {
      throw new Error(`Unknown job type: ${type}`);
    }
  },
  {
    connection,
    concurrency: 15 // Limit local concurrent executions to preserve memory/CPU resources on the host
  }
);

worker.on("active", (job) => {
  console.log(`[Worker] Active: Job ${job.id} has started processing.`);
});

worker.on("completed", (job, returnValue) => {
  console.log(`[Worker] Completed: Job ${job.id} finished successfully.`);
});

worker.on("failed", (job, error) => {
  console.error(`[Worker] Failed: Job ${job?.id} failed with error:`, error.message || String(error));
});

process.on("SIGTERM", async () => {
  console.log("[Worker] SIGTERM received. Shutting down worker gracefully...");
  await worker.close();
  process.exit(0);
});
