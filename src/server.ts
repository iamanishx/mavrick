import express from "express";
import type { Request, Response } from "express";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { taskQueue } from "./queue.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, "../.env") });

const app = express();
app.use(express.json());

const PORT = process.env.GOAL_PORT || 3001;

app.post("/review", async (req: Request, res: Response) => {
  const { repoUrl, prNumber, token } = req.body;

  if (!repoUrl || !prNumber || !token) {
    return res.status(400).json({ error: "Missing required fields (repoUrl, prNumber, token)" });
  }

  console.log(`[Goal Server] Enqueuing review request for repo: ${repoUrl}, PR #${prNumber}`);
  try {
    const job = await taskQueue.add("pr-reviewer", {
      type: "review",
      repoUrl,
      prNumber: parseInt(prNumber),
      token
    });
    return res.status(202).json({
      success: true,
      message: "Pull Request review task successfully enqueued.",
      jobId: job.id
    });
  } catch (error: any) {
    console.error(`[Goal Server] Error enqueuing review request:`, error.message || String(error));
    return res.status(500).json({ error: error.message || String(error) });
  }
});

app.post("/run", async (req: Request, res: Response) => {
  const { repoUrl, issueUrl, description, token } = req.body;

  if (!repoUrl || !description || !token) {
    return res.status(400).json({ error: "Missing required fields (repoUrl, description, token)" });
  }

  console.log(`[Goal Server] Enqueuing run request for repo: ${repoUrl}`);
  try {
    const job = await taskQueue.add("issue-fixer", {
      type: "run",
      repoUrl,
      issueUrl,
      description,
      token
    });
    return res.status(202).json({
      success: true,
      message: "Issue fixer task successfully enqueued.",
      jobId: job.id
    });
  } catch (error: any) {
    console.error(`[Goal Server] Error enqueuing run request:`, error.message || String(error));
    return res.status(500).json({ error: error.message || String(error) });
  }
});

app.listen(PORT, () => {
  console.log(`Mavrick Production Gateway listening on port ${PORT}`);
});
