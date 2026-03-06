import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ChildProcess } from "node:child_process";
import type { ContainedSandbox } from "contained-sandbox";

export interface TaskProgress {
    taskId: string;
    status: "planning" | "running" | "completed" | "failed" | "aborted";
    currentTodo: { id: string; content: string; status: string } | null;
    completedTodos: Array<{ id: string; content: string; result: string | null }>;
    pendingTodos: Array<{ id: string; content: string }>;
    failedTodos: Array<{ id: string; content: string; error: string | null }>;
    result: string | null;
    error: string | null;
}

export interface RunTaskResult {
    taskId: string;
    status: string;
    message: string;
}

export interface CatMCPClientOptions {
    pollInterval?: number;
    timeout?: number;
    onProgress?: (progress: TaskProgress) => void;
}

export class CatMCPClient {
    private client: Client;
    private connected = false;

    constructor() {
        this.client = new Client({ name: "mavrick", version: "1.0.0" });
    }

    async connectToContained(
        sandbox: ContainedSandbox,
        catCommand = "bun",
        catArgs = ["run", "/cat/server.ts"]
    ): Promise<void> {
        const { binaryPath, rootfsPath, uid } = sandbox.getSpawnParams();

        const transport = new StdioClientTransport({
            command: "sudo",
            args: [
                binaryPath,
                "-m", rootfsPath,
                "-u", String(uid),
                "--",
                catCommand,
                ...catArgs,
            ],
            stderr: "ignore",
        });

        await this.client.connect(transport);
        this.connected = true;
    }

    async connectToProcess(proc: ChildProcess): Promise<void> {
        if (!proc.stdin || !proc.stdout) {
            throw new Error("ChildProcess must have stdin and stdout pipes");
        }

        const transport = new StdioClientTransport({
            command: "cat",
            args: [],
            stderr: "ignore",
        });

        Object.defineProperty(transport, "_process", {
            get: () => proc,
            set: () => {},
            configurable: true,
        });

        await this.client.connect(transport);
        this.connected = true;
    }

    async runTask(prompt: string, workingDirectory?: string): Promise<string> {
        this.assertConnected();

        const result = await this.client.callTool({
            name: "run_task",
            arguments: {
                prompt,
                ...(workingDirectory ? { workingDirectory } : {}),
            },
        });

        const text = this.extractText(result);
        const parsed: RunTaskResult = JSON.parse(text);
        return parsed.taskId;
    }

    async getProgress(taskId: string): Promise<TaskProgress> {
        this.assertConnected();

        const result = await this.client.callTool({
            name: "get_progress",
            arguments: { taskId },
        });

        return JSON.parse(this.extractText(result)) as TaskProgress;
    }

    async abortTask(taskId: string): Promise<void> {
        this.assertConnected();
        await this.client.callTool({ name: "abort_task", arguments: { taskId } });
    }

    async runTaskAndWait(
        prompt: string,
        workingDirectory?: string,
        options: CatMCPClientOptions = {}
    ): Promise<TaskProgress> {
        const { pollInterval = 2000, timeout = 10 * 60 * 1000, onProgress } = options;

        const taskId = await this.runTask(prompt, workingDirectory);
        const deadline = Date.now() + timeout;

        while (true) {
            if (Date.now() > deadline) {
                await this.abortTask(taskId).catch(() => {});
                throw new Error(`Task ${taskId} timed out after ${timeout}ms`);
            }

            const progress = await this.getProgress(taskId);
            onProgress?.(progress);

            if (progress.status === "completed") return progress;
            if (progress.status === "failed") {
                throw new Error(`Task failed: ${progress.error ?? "unknown error"}`);
            }
            if (progress.status === "aborted") {
                throw new Error("Task was aborted");
            }

            await new Promise<void>((r) => setTimeout(r, pollInterval));
        }
    }

    async shellExec(command: string, cwd?: string): Promise<string> {
        this.assertConnected();

        const result = await this.client.callTool({
            name: "shell-exec",
            arguments: { command, ...(cwd ? { cwd } : {}) },
        });

        return this.extractText(result);
    }

    async close(): Promise<void> {
        await (this.client as any).close?.();
        this.connected = false;
    }

    private extractText(result: any): string {
        const text = (result.content as Array<{ type: string; text: string }>)
            ?.find((c) => c.type === "text")?.text;
        if (!text) throw new Error("MCP tool returned no text content");
        return text;
    }

    private assertConnected() {
        if (!this.connected) {
            throw new Error(
                "CatMCPClient not connected. Call connectToContained() first."
            );
        }
    }
}
