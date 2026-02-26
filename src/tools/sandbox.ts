import Docker from "dockerode";
import { createMCPClient } from "@ai-sdk/mcp";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface FileEntry {
  name: string;
  type: "file" | "directory" | "symlink";
  size?: number;
}

interface MCPTools {
  read_file: { execute: (params: { path: string }) => Promise<any> };
  read_multiple_files: { execute: (params: { paths: string[] }) => Promise<any> };
  write_file: { execute: (params: { path: string; content: string }) => Promise<any> };
  create_directory: { execute: (params: { path: string }) => Promise<any> };
  move_file: { execute: (params: { source: string; destination: string }) => Promise<any> };
  list_directory: { execute: (params: { path: string }) => Promise<any> };
  search_files: { execute: (params: { path: string; pattern: string }) => Promise<any> };
  get_file_info: { execute: (params: { path: string }) => Promise<any> };
  bash: { execute: (params: { command: string }) => Promise<any> };
}

export class DockerSandbox {
  private docker: Docker;
  private container: Docker.Container | null = null;
  public containerId: string | null = null;
  private workingDir: string = "/app";
  private mcpClient: Awaited<ReturnType<typeof createMCPClient>> | null = null;
  private tools: MCPTools | null = null;

  constructor() {
    this.docker = new Docker();
  }

  async init(
    repoUrl: string,
    token: string,
    branch: string,
    containerImage: string = "node:20-slim"
  ): Promise<void> {
    this.container = await this.docker.createContainer({
      Image: containerImage,
      Cmd: ["tail", "-f", "/dev/null"],
      Tty: true,
      HostConfig: {
        Memory: 2 * 1024 * 1024 * 1024,
        NanoCpus: 2 * 1000000000,
      },
      WorkingDir: this.workingDir,
    });

    this.containerId = this.container.id;

    try {
      await this.container.start();

      await this.exec("apt-get update && apt-get install -y git python3 npm");

      const cleanRepoUrl = repoUrl.replace(/^https?:\/\//, "");
      const authUrl = `https://x-access-token:${token}@${cleanRepoUrl}`;

      await this.exec("mkdir -p " + this.workingDir);

      const cloneCmd = `cd ${this.workingDir} && git clone --depth 1 --branch ${branch} ${authUrl} .`;
      const cloneResult = await this.exec(cloneCmd);

      if (cloneResult.exitCode !== 0) {
        throw new Error(`Failed to clone: ${cloneResult.stderr}`);
      }

      await this.exec('cd ' + this.workingDir + ' && git config user.email "bot@axeai.com"');
      await this.exec('cd ' + this.workingDir + ' && git config user.name "AxeAI Bot"');

      await this.setupMCP();
    } catch (error) {
      try {
        await this.destroy();
      } catch {
      }
      throw error;
    }
  }

  private async setupMCP(): Promise<void> {
    const installCmd = `
      cd /tmp && npm install -g @modelcontextprotocol/server-filesystem@2026.1.14
    `;
    await this.exec(installCmd);

    const mcpScript = `
      #!/bin/bash
      exec npx -y @modelcontextprotocol/server-filesystem ${this.workingDir}
    `;
    await this.exec(`echo '${mcpScript}' > /usr/local/bin/mcp-server-filesystem && chmod +x /usr/local/bin/mcp-server-filesystem`);

    const transport = new StdioClientTransport({
      command: "mcp-server-filesystem",
      args: [this.workingDir],
    });

    this.mcpClient = await createMCPClient({
      transport,
    });

    this.tools = await this.mcpClient.tools() as unknown as MCPTools;
  }

  async exec(command: string): Promise<ExecResult> {
    if (!this.container) throw new Error("Sandbox not initialized");

    const exec = await this.container.exec({
      Cmd: ["sh", "-c", command],
      AttachStdout: true,
      AttachStderr: true,
    });

    const stream = await exec.start({ Detach: false, Tty: false });

    return new Promise((resolve, reject) => {
      let stdout = "";
      let stderr = "";

      this.container?.modem.demuxStream(stream as unknown as NodeJS.ReadableStream, {
        write: (chunk: Buffer) => {
          stdout += chunk.toString("utf-8");
        },
      }, {
        write: (chunk: Buffer) => {
          stderr += chunk.toString("utf-8");
        },
      });

      stream.on("end", async () => {
        try {
          const inspect = await exec.inspect();
          resolve({
            stdout: stdout.trim(),
            stderr: stderr.trim(),
            exitCode: inspect.ExitCode ?? -1,
          });
        } catch (e) {
          reject(e);
        }
      });

      stream.on("error", (err) => reject(err));
    });
  }

  async readFile(filePath: string): Promise<string> {
    if (!this.tools) throw new Error("MCP not initialized");
    const fullPath = filePath.startsWith("/") ? filePath : `${this.workingDir}/${filePath}`;
    const result = await this.tools.read_file.execute({ path: fullPath });
    return result[0]?.text?.content?.[0]?.text || "";
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    if (!this.tools) throw new Error("MCP not initialized");
    const fullPath = filePath.startsWith("/") ? filePath : `${this.workingDir}/${filePath}`;
    await this.tools.write_file.execute({ path: fullPath, content });
  }

  async listDirectory(path: string): Promise<FileEntry[]> {
    if (!this.tools) throw new Error("MCP not initialized");
    const fullPath = path.startsWith("/") ? path : `${this.workingDir}/${path}`;
    const result = await this.tools.list_directory.execute({ path: fullPath });
    
    const directories = result?.directories?.map((d: string): FileEntry => ({
      name: d,
      type: "directory",
    })) ?? [];
    
    const files = result?.files?.map((f: string): FileEntry => ({
      name: f,
      type: "file",
    })) ?? [];
    
    return [...directories, ...files];
  }

  async bash(command: string): Promise<ExecResult> {
    if (!this.tools) throw new Error("MCP not initialized");
    const rawResult: any = await this.tools.bash.execute({ command });
    
    const first = Array.isArray(rawResult) ? rawResult[0] : rawResult;
    
    let stdout = "";
    let stderr = "";
    let exitCode = 0;
    
    if (first && typeof first === "object") {
      if (typeof first.stdout === "string") {
        stdout = first.stdout;
      }
      if (typeof first.stderr === "string") {
        stderr = first.stderr;
      }
      if (typeof first.exitCode === "number") {
        exitCode = first.exitCode;
      }
    }
    
    if (!stdout && first && Array.isArray(first.content) && first.content[0]?.text) {
      stdout = first.content[0].text;
    }
    
    return {
      stdout,
      stderr,
      exitCode,
    };
  }

  async destroy(): Promise<void> {
    if (this.mcpClient) {
      await this.mcpClient.close();
      this.mcpClient = null;
      this.tools = null;
    }
    if (this.container) {
      try {
        await this.container.stop();
        await this.container.remove();
      } catch (e) {
        console.error("Error cleaning up container:", e);
      }
      this.container = null;
      this.containerId = null;
    }
  }

  isInitialized(): boolean {
    return this.container !== null && this.tools !== null;
  }

  getTools() {
    return this.tools;
  }

  getWorkingDir(): string {
    return this.workingDir;
  }
}
