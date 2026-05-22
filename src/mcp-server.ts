import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { repoDb } from "./tools/db.js";
import { Queue } from "bullmq";

const testQueue = new Queue("test-generation", {
  connection: {
    host: process.env.REDIS_HOST || "localhost",
    port: parseInt(process.env.REDIS_PORT || "6379"),
  },
});

function createId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now()}_${rand}`;
}

const server = new Server(
  {
    name: "axeai-status-server",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "list_active_sessions",
        description: "List all active, pending, or recently completed testing and PR generation sessions",
        inputSchema: {
          type: "object",
          properties: {
            limit: { type: "number", description: "Maximum number of sessions to return", default: 20 },
          },
        },
      },
      {
        name: "get_session_status",
        description: "Get the high-fidelity real-time status and step logs for a given session",
        inputSchema: {
          type: "object",
          properties: {
            sessionId: { type: "number", description: "The unique database Session ID" },
          },
          required: ["sessionId"],
        },
      },
      {
        name: "trigger_session",
        description: "Programmatically trigger a new autonomous test generation and PR creation session for a repository",
        inputSchema: {
          type: "object",
          properties: {
            owner: { type: "string", description: "The owner of the GitHub repository (e.g. iamanishx)" },
            repo: { type: "string", description: "The name of the GitHub repository (e.g. axe-qa)" },
            branch: { type: "string", description: "The branch name to checkout and work on", default: "main" },
            taskInput: { type: "string", description: "The description of the issue or code that needs testing" },
          },
          required: ["owner", "repo", "taskInput"],
        },
      },
      {
        name: "list_registered_repos",
        description: "List all GitHub repositories registered with the AxeAI database",
        inputSchema: {
          type: "object",
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === "list_active_sessions") {
      const limit = (args as any)?.limit || 20;
      const sessions = repoDb.getRecentSessions(limit);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(sessions, null, 2),
          },
        ],
      };
    }

    if (name === "get_session_status") {
      const sessionId = (args as any).sessionId;
      const session = repoDb.getSession(sessionId);
      if (!session) {
        return {
          content: [{ type: "text", text: `Session with ID ${sessionId} not found.` }],
          isError: true,
        };
      }

      const runs = repoDb.getRunsBySession(sessionId);
      const events = runs.flatMap((run) => repoDb.getEventsByRun(run.id));

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              session,
              runs,
              events: events.map((e) => ({
                eventType: e.eventType,
                source: e.source,
                tsUtc: e.tsUtc,
                payload: JSON.parse(e.payload),
              })),
            }, null, 2),
          },
        ],
      };
    }

    if (name === "trigger_session") {
      const { owner, repo, branch = "main", taskInput } = args as any;
      const repos = repoDb.getRepo(owner, repo);
      if (!repos) {
        return {
          content: [{ type: "text", text: `Repository ${owner}/${repo} is not registered in DB.` }],
          isError: true,
        };
      }

      const session = repoDb.createSession(repos.id, "generate-tests", taskInput, "mcp");
      const run = repoDb.createRun({
        id: createId("run"),
        repoId: repos.id,
        parentRunId: null,
        rootRunId: undefined,
        status: "pending",
        source: "mcp",
        sourceRef: "stdio",
        taskInput,
        startedAt: new Date().toISOString(),
      });

      await testQueue.add("process-task", {
        owner,
        repo,
        taskInput,
        taskType: "generate-tests",
        threadId: "",
        installationId: repos.installationId,
        sessionId: session.id,
        repoUrl: `https://github.com/${owner}/${repo}`,
        rootRunId: run.root_run_id,
        runId: run.id,
      });

      return {
        content: [
          {
            type: "text",
            text: `Successfully triggered session. Session ID: ${session.id}, Run ID: ${run.id}`,
          },
        ],
      };
    }

    if (name === "list_registered_repos") {
      const repos = repoDb.getRepos();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(repos, null, 2),
          },
        ],
      };
    }

    return {
      content: [{ type: "text", text: `Unknown tool: ${name}` }],
      isError: true,
    };
  } catch (err: any) {
    return {
      content: [{ type: "text", text: `Error calling tool ${name}: ${err.message || String(err)}` }],
      isError: true,
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("AxeAI MCP Status Server running on stdio!");
}

main().catch((err) => {
  console.error("MCP Server Error:", err);
  process.exit(1);
});
