import Docker from "dockerode";
import tar from "tar-stream";
import { Readable } from "stream";

/**
 * Manages a secure Docker container for sandboxed code execution.
 * Provides methods to initialize, execute commands, and manage files within the container.
 */
export class DockerSandbox {
  private docker: Docker;
  private container: Docker.Container | null = null;
  public containerId: string | null = null;

  constructor() {
    this.docker = new Docker();
  }

  /**
   * Initializes the sandbox by creating a container, cloning the repository, and installing dependencies.
   * 
   * @param repoUrl - The URL of the repository to clone.
   * @param token - The GitHub access token for authentication.
   * @param branch - The branch to clone.
   */
  async init(repoUrl: string, token: string, branch: string) {
    this.container = await this.docker.createContainer({
      Image: "node:20-slim",
      Cmd: ["tail", "-f", "/dev/null"],
      Tty: false,
      HostConfig: {
        Memory: 2 * 1024 * 1024 * 1024,
        NanoCpus: 2 * 1000000000,
      },
      WorkingDir: "/app",
    });

    this.containerId = this.container.id;
    await this.container.start();

    await this.exec("apt-get update && apt-get install -y git");
    
    const cleanRepoUrl = repoUrl.replace(/^https?:\/\//, "");
    const authUrl = `https://x-access-token:${token}@${cleanRepoUrl}`;
    
    await this.exec("mkdir -p /app");
    
    const cloneCmd = `git clone --depth 1 --branch ${branch} ${authUrl} .`;
    const cloneResult = await this.exec(cloneCmd);
    
    if (cloneResult.exitCode !== 0) {
      throw new Error(`Failed to clone: ${cloneResult.stderr}`);
    }

    await this.exec('git config user.email "bot@axeai.com"');
    await this.exec('git config user.name "AxeAI Bot"');
    
    await this.exec("npm install");
  }

  /**
   * Executes a shell command inside the sandbox container.
   * 
   * @param command - The command to execute.
   * @returns An object containing stdout, stderr, and the exit code.
   */
  async exec(command: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
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
        write: (chunk: Buffer) => { stdout += chunk.toString("utf-8"); },
      }, {
        write: (chunk: Buffer) => { stderr += chunk.toString("utf-8"); },
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

  /**
   * Reads the content of a file from the sandbox.
   * 
   * @param filePath - The path to the file relative to the working directory.
   * @returns The content of the file as a string.
   */
  async readFile(filePath: string): Promise<string> {
    const result = await this.exec(`cat ${filePath}`);
    if (result.exitCode !== 0) {
      throw new Error(`File not found: ${filePath}`);
    }
    return result.stdout;
  }

  /**
   * Writes content to a file in the sandbox.
   * 
   * @param filePath - The path where the file should be written.
   * @param content - The content to write to the file.
   */
  async writeFile(filePath: string, content: string): Promise<void> {
    if (!this.container) throw new Error("Sandbox not initialized");

    const pack = tar.pack();
    pack.entry({ name: filePath }, content);
    pack.finalize();

    await this.container.putArchive(pack, {
      path: "/app",
    });
  }

  /**
   * Stops and removes the sandbox container.
   */
  async destroy() {
    if (this.container) {
      try {
        await this.container.stop();
        await this.container.remove();
      } catch (e) {
        console.error("Error cleaning up container:", e);
      }
      this.container = null;
    }
  }
}
