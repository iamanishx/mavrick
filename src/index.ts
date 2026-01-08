import { Context, Probot } from "probot";
import { Queue } from "bullmq";

const testQueue = new Queue("test-generation", {
  connection: {
    host: process.env.REDIS_HOST || "localhost",
    port: parseInt(process.env.REDIS_PORT || "6379"),
  },
});

/**
 * Probot application entry point.
 * Listens for issue comments and queues test generation jobs for the worker.
 * 
 * @param app - The Probot application instance.
 */
export default (app: Probot) => {
  app.on("issue_comment.created", async (context: Context<"issue_comment">) => {
    const commentBody = context.payload.comment.body;
    const isPr = !!context.payload.issue.pull_request;
    
    if (!isPr || !commentBody.includes("@axeai-bot")) return;

    const { owner, repo } = context.repo();
    const prNumber = context.payload.issue.number;
    const installationId = context.payload.installation?.id;

    if (!installationId) {
        app.log.error("No installation ID found");
        return;
    }

    const { data: pr } = await (context.octokit as any).pulls.get({ owner, repo, pull_number: prNumber });

    await testQueue.add("generate-tests", {
      owner,
      repo,
      prNumber,
      installationId,
      branch: pr.head.ref, 
      headRef: pr.head.ref, 
      repoUrl: pr.head.repo.clone_url,
    });

    await (context.octokit as any).issues.createComment(context.issue({
      body: "Request queued. A worker will process this shortly using a secure Docker sandbox."
    }));
  });
};

