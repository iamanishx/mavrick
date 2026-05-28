import * as k8s from "@kubernetes/client-node";
import { exec } from "child_process";
import { promisify } from "util";
import { PassThrough } from "stream";
import fs from "fs/promises";
import path from "path";

const execAsync = promisify(exec);

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export class K8sSandbox {
  private kc: k8s.KubeConfig | null = null;
  private k8sApi: k8s.CoreV1Api | null = null;
  private execClient: k8s.Exec | null = null;
  private podName: string | null = null;
  private localCwd: string | null = null;

  constructor() {
    try {
      const kc = new k8s.KubeConfig();
      kc.loadFromDefault();
      this.kc = kc;
      this.k8sApi = kc.makeApiClient(k8s.CoreV1Api);
      this.execClient = new k8s.Exec(kc);
      console.log("[K8sSandbox] Initialized Kubernetes client successfully.");
    } catch (e: any) {
      console.log("[K8sSandbox] K8s config not loaded, using local host sandbox mode:", e.message || String(e));
      this.kc = null;
      this.k8sApi = null;
      this.execClient = null;
    }
  }

  async init(repoUrl: string, token: string, branch: string, workspaceParentDir: string): Promise<string> {
    const suffix = Math.random().toString(36).slice(2, 10);
    const ownerRepo = repoUrl.split("github.com/")[1]?.replace(/\.git$/, "") || "repo";
    const nameSanitized = ownerRepo.replace(/[^a-zA-Z0-9]/g, "-").toLowerCase();
    if (this.k8sApi && this.execClient) {
      this.podName = `mavrick-sandbox-${nameSanitized}-${suffix}`.substring(0, 63);
      console.log(`[K8sSandbox] Creating execution Pod: ${this.podName}`);
      
      const podSpec: k8s.V1Pod = {
        metadata: {
          name: this.podName,
          labels: { app: "mavrick-sandbox" }
        },
        spec: {
          containers: [{
            name: "runner",
            image: "node:20-slim",
            command: ["tail", "-f", "/dev/null"],
            resources: {
              limits: { cpu: "2", memory: "2Gi" },
              requests: { cpu: "500m", memory: "512Mi" }
            }
          }],
          restartPolicy: "Never"
        }
      };

      await this.k8sApi.createNamespacedPod({ namespace: "default", body: podSpec });
      await this.waitForPodRunning();

      const cleanRepoUrl = repoUrl.replace(/^https?:\/\//, "");
      const authedUrl = `https://x-access-token:${token}@${cleanRepoUrl}`;

      await this.exec(`git clone --depth 1 --branch ${branch} "${authedUrl}" /app`);
      await this.exec(`git config --global user.email "bot@mavrick.com"`);
      await this.exec(`git config --global user.name "Mavrick Bot"`);
      await this.exec(`git config --global credential.helper ""`);
      
      return "/app";
    } else {
      this.localCwd = path.join(workspaceParentDir, `goal_${nameSanitized}_${Date.now()}`);
      await fs.mkdir(this.localCwd, { recursive: true });
      
      const cleanRepoUrl = repoUrl.replace(/^https?:\/\//, "");
      const authedUrl = `https://x-access-token:${token}@${cleanRepoUrl}`;

      console.log(`[K8sSandbox] Local Fallback: Cloning to ${this.localCwd}`);
      await execAsync(`git -c credential.helper= clone -b ${branch} "${authedUrl}" "${this.localCwd}"`);
      await execAsync(`git config credential.helper ""`, { cwd: this.localCwd });
      
      return this.localCwd;
    }
  }

  private async waitForPodRunning(): Promise<void> {
    if (!this.k8sApi || !this.podName) return;
    
    for (let i = 0; i < 30; i++) {
      try {
        const res = await this.k8sApi.readNamespacedPod({ name: this.podName, namespace: "default" });
        const status = res.status?.phase;
        if (status === "Running") {
          console.log(`[K8sSandbox] Pod ${this.podName} is running.`);
          return;
        }
      } catch {}
      await new Promise(r => setTimeout(r, 1000));
    }
    throw new Error(`Pod ${this.podName} failed to start in Running state.`);
  }

  async exec(command: string): Promise<ExecResult> {
    if (this.k8sApi && this.execClient && this.podName) {
      const stdoutStream = new PassThrough();
      const stderrStream = new PassThrough();
      
      let stdout = "";
      let stderr = "";
      
      stdoutStream.on("data", chunk => stdout += chunk.toString());
      stderrStream.on("data", chunk => stderr += chunk.toString());

      return new Promise((resolve, reject) => {
        this.execClient!.exec(
          "default",
          this.podName!,
          "runner",
          ["sh", "-c", `cd /app && ${command}`],
          stdoutStream,
          stderrStream,
          null,
          false,
          (status) => {
            const exitCode = status.status === "Success" ? 0 : 1;
            resolve({
              stdout: stdout.trim(),
              stderr: stderr.trim(),
              exitCode
            });
          }
        ).catch(reject);
      });
    } else if (this.localCwd) {
      try {
        const { stdout, stderr } = await execAsync(command, { cwd: this.localCwd });
        return { stdout, stderr, exitCode: 0 };
      } catch (err: any) {
        return {
          stdout: err.stdout || "",
          stderr: err.stderr || err.message || String(err),
          exitCode: err.code || 1
        };
      }
    }
    throw new Error("Sandbox not initialized");
  }

  async destroy(): Promise<void> {
    if (this.k8sApi && this.podName) {
      try {
        console.log(`[K8sSandbox] Deleting execution Pod: ${this.podName}`);
        await this.k8sApi.deleteNamespacedPod({ name: this.podName, namespace: "default" });
      } catch (e: any) {
        console.error(`[K8sSandbox] Failed to delete Pod:`, e.message || String(e));
      }
      this.podName = null;
    } else if (this.localCwd) {
      this.localCwd = null;
    }
  }
}
