import { Database } from "bun:sqlite";
import path from "path";
import fs from "fs";

const DB_DIR = process.env.DB_DIR || path.join(process.cwd(), "data");
if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

export interface Repo {
  id: number;
  owner: string;
  repo: string;
  githubAppId: number;
  installationId: number;
  defaultBranch: string;
  testFramework: string | null;
  containerImage: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentSession {
  id: number;
  repoId: number;
  discordThreadId: string | null;
  status: "pending" | "running" | "completed" | "failed";
  taskType: string;
  taskInput: string;
  result: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

class RepoDB {
  private dbs: Map<string, Database> = new Map();

  private getDbPath(owner: string, repo: string): string {
    return path.join(DB_DIR, `${owner}_${repo}.db`);
  }

  private getDb(owner: string, repo: string): Database {
    const key = `${owner}/${repo}`;
    if (!this.dbs.has(key)) {
      const dbPath = this.getDbPath(owner, repo);
      const db = new Database(dbPath);
      this.initSchema(db);
      this.dbs.set(key, db);
    }
    return this.dbs.get(key)!;
  }

  private initSchema(db: Database): void {
    db.run(`
      CREATE TABLE IF NOT EXISTS repo_config (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner TEXT NOT NULL,
        repo TEXT NOT NULL,
        github_app_id INTEGER,
        installation_id INTEGER,
        default_branch TEXT DEFAULT 'main',
        test_framework TEXT,
        container_image TEXT DEFAULT 'node:20-slim',
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(owner, repo)
      )
    `);
    db.run(`
      CREATE TABLE IF NOT EXISTS agent_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo_id INTEGER NOT NULL,
        discord_thread_id TEXT,
        status TEXT DEFAULT 'pending',
        task_type TEXT NOT NULL,
        task_input TEXT NOT NULL,
        result TEXT,
        started_at TEXT,
        completed_at TEXT,
        FOREIGN KEY(repo_id) REFERENCES repo_config(id)
      )
    `);
    db.run(`
      CREATE TABLE IF NOT EXISTS memory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo_id INTEGER NOT NULL,
        session_id INTEGER,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(repo_id) REFERENCES repo_config(id),
        FOREIGN KEY(session_id) REFERENCES agent_sessions(id)
      )
    `);
    db.run(`CREATE INDEX IF NOT EXISTS idx_sessions_repo ON agent_sessions(repo_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_memory_repo ON memory(repo_id)`);
  }

  getOrCreateRepo(owner: string, repo: string, installationId: number): Repo {
    const db = this.getDb(owner, repo);
    const existing = db.query(`SELECT * FROM repo_config WHERE owner = ? AND repo = ?`).get(owner, repo) as Repo | undefined;

    if (existing) {
      if (existing.installationId !== installationId) {
        db.query(`UPDATE repo_config SET installation_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
          .run(installationId, existing.id);
        existing.installationId = installationId;
      }
      return existing;
    }

    const result = db.query(`
      INSERT INTO repo_config (owner, repo, installation_id, default_branch)
      VALUES (?, ?, ?, 'main')
      RETURNING *
    `).get(owner, repo, installationId) as Repo;

    return result;
  }

  getRepo(owner: string, repo: string): Repo | undefined {
    const db = this.getDb(owner, repo);
    return db.query(`SELECT * FROM repo_config WHERE owner = ? AND repo = ?`).get(owner, repo) as Repo | undefined;
  }

  updateRepoConfig(owner: string, repo: string, updates: Partial<Pick<Repo, "testFramework" | "containerImage" | "defaultBranch">>): void {
    const db = this.getDb(owner, repo);
    const fields: string[] = [];
    const values: any[] = [];

    if (updates.testFramework !== undefined) {
      fields.push("test_framework = ?");
      values.push(updates.testFramework);
    }
    if (updates.containerImage !== undefined) {
      fields.push("container_image = ?");
      values.push(updates.containerImage);
    }
    if (updates.defaultBranch !== undefined) {
      fields.push("default_branch = ?");
      values.push(updates.defaultBranch);
    }

    if (fields.length > 0) {
      values.push(owner, repo);
      db.query(`UPDATE repo_config SET ${fields.join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE owner = ? AND repo = ?`)
        .run(...values);
    }
  }

  createSession(repoId: number, taskType: string, taskInput: string, discordThreadId?: string): AgentSession {
    const db = this.getDbById(repoId);
    const result = db.query(`
      INSERT INTO agent_sessions (repo_id, discord_thread_id, task_type, task_input, status, started_at)
      VALUES (?, ?, ?, ?, 'pending', CURRENT_TIMESTAMP)
      RETURNING *
    `).get(repoId, discordThreadId || null, taskType, taskInput) as AgentSession;
    return result;
  }

  updateSession(sessionId: number, updates: Partial<Pick<AgentSession, "status" | "result" | "completedAt">>): void {
    const db = this.getDbBySessionId(sessionId);
    const fields: string[] = [];
    const values: any[] = [];

    if (updates.status !== undefined) {
      fields.push("status = ?");
      values.push(updates.status);
    }
    if (updates.result !== undefined) {
      fields.push("result = ?");
      values.push(updates.result);
    }
    if (updates.completedAt !== undefined) {
      fields.push("completed_at = ?");
      values.push(updates.completedAt);
    }

    if (fields.length > 0) {
      values.push(sessionId);
      db.query(`UPDATE agent_sessions SET ${fields.join(", ")} WHERE id = ?`).run(...values);
    }
  }

  getSession(sessionId: number): AgentSession | undefined {
    const db = this.getDbBySessionId(sessionId);
    return db.query(`SELECT * FROM agent_sessions WHERE id = ?`).get(sessionId) as AgentSession | undefined;
  }

  setMemory(repoId: number, key: string, value: string, sessionId?: number): void {
    const db = this.getDbById(repoId);
    const existing = db.query(`SELECT id FROM memory WHERE repo_id = ? AND key = ?`).get(repoId, key);
    if (existing) {
      db.query(`UPDATE memory SET value = ?, session_id = COALESCE(?, session_id) WHERE repo_id = ? AND key = ?`)
        .run(value, sessionId || null, repoId, key);
    } else {
      db.query(`INSERT INTO memory (repo_id, session_id, key, value) VALUES (?, ?, ?, ?)`)
        .run(repoId, sessionId || null, key, value);
    }
  }

  getMemory(repoId: number, key: string): string | undefined {
    const db = this.getDbById(repoId);
    const result = db.query(`SELECT value FROM memory WHERE repo_id = ? AND key = ?`).get(repoId, key) as { value: string } | undefined;
    return result?.value;
  }

  getAllMemory(repoId: number): Record<string, string> {
    const db = this.getDbById(repoId);
    const results = db.query(`SELECT key, value FROM memory WHERE repo_id = ?`).all(repoId) as { key: string; value: string }[];
    return Object.fromEntries(results.map(r => [r.key, r.value]));
  }

  private getDbById(repoId: number): Database {
    for (const [, db] of this.dbs) {
      const row = db.query(`SELECT owner, repo FROM repo_config WHERE id = ?`).get(repoId) as { owner: string; repo: string } | undefined;
      if (row) return this.getDb(row.owner, row.repo);
    }
    throw new Error(`Repo not found for id: ${repoId}`);
  }

  private getDbBySessionId(sessionId: number): Database {
    for (const [, db] of this.dbs) {
      const row = db.query(`SELECT repo_id FROM agent_sessions WHERE id = ?`).get(sessionId) as { repo_id: number } | undefined;
      if (row) return this.getDbById(row.repo_id);
    }
    throw new Error(`Session not found for id: ${sessionId}`);
  }
}

export const repoDb = new RepoDB();
