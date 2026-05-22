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
  githubAppId: number | null;
  installationId: number;
  defaultBranch: string;
  testFramework: string | null;
  containerImage: string;
  createdAt: string;
  updatedAt: string;
}

interface RepoRow {
  id: number;
  owner: string;
  repo: string;
  github_app_id: number | null;
  installation_id: number;
  default_branch: string;
  test_framework: string | null;
  container_image: string;
  created_at: string;
  updated_at: string;
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

export interface Run {
  id: string;
  repo_id: number;
  parent_run_id: string | null;
  root_run_id: string;
  status: string;
  source: string;
  source_ref: string;
  task_input: string;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}

export interface RunEdge {
  parent_run_id: string;
  child_run_id: string;
  created_at: string;
}

export interface EventRow {
  id: string;
  run_id: string;
  root_run_id: string;
  parent_run_id: string | null;
  repo_id: number;
  source: string;
  source_ref: string;
  event_type: string;
  ts_utc: string;
  payload: string;
}

export interface ChannelBinding {
  id: string;
  run_id: string;
  platform: string;
  channel_id: string;
  thread_id: string;
  external_ref: string;
  created_at: string;
}

type CreateRunParams = {
  id: string;
  repoId: number;
  parentRunId?: string | null;
  rootRunId?: string;
  status: string;
  source: string;
  sourceRef: string;
  taskInput: string;
  startedAt?: string | null;
  completedAt?: string | null;
  createdAt?: string;
};

type UpdateRunParams = Partial<{
  status: string;
  source: string;
  sourceRef: string;
  taskInput: string;
  startedAt: string | null;
  completedAt: string | null;
}>;

type CreateChildRunParams = {
  id: string;
  repoId?: number;
  status: string;
  source: string;
  sourceRef: string;
  taskInput: string;
  startedAt?: string | null;
  completedAt?: string | null;
  createdAt?: string;
};

type AppendEventParams = {
  id: string;
  runId: string;
  rootRunId?: string;
  parentRunId?: string | null;
  repoId?: number;
  source?: string;
  sourceRef?: string;
  eventType: string;
  tsUtc?: string;
  payload: string;
};

type BindChannelParams = {
  id: string;
  runId: string;
  platform: string;
  channelId: string;
  threadId: string;
  externalRef: string;
  createdAt?: string;
};

class RepoDB {
  private dbs: Map<string, Database> = new Map();
  private repoIdIndex: Map<number, string> = new Map();
  private sessionRepoIndex: Map<number, number> = new Map();
  private runRepoIndex: Map<string, number> = new Map();

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
    db.run(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        repo_id INTEGER NOT NULL,
        parent_run_id TEXT,
        root_run_id TEXT NOT NULL,
        status TEXT NOT NULL,
        source TEXT NOT NULL,
        source_ref TEXT NOT NULL,
        task_input TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(repo_id) REFERENCES repo_config(id),
        FOREIGN KEY(parent_run_id) REFERENCES runs(id)
      )
    `);
    db.run(`
      CREATE TABLE IF NOT EXISTS run_edges (
        parent_run_id TEXT NOT NULL,
        child_run_id TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(parent_run_id) REFERENCES runs(id),
        FOREIGN KEY(child_run_id) REFERENCES runs(id),
        UNIQUE(parent_run_id, child_run_id)
      )
    `);
    db.run(`
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        root_run_id TEXT NOT NULL,
        parent_run_id TEXT,
        repo_id INTEGER NOT NULL,
        source TEXT NOT NULL,
        source_ref TEXT NOT NULL,
        event_type TEXT NOT NULL,
        ts_utc TEXT NOT NULL,
        payload TEXT NOT NULL,
        FOREIGN KEY(run_id) REFERENCES runs(id),
        FOREIGN KEY(repo_id) REFERENCES repo_config(id)
      )
    `);
    db.run(`
      CREATE TABLE IF NOT EXISTS channel_bindings (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        platform TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        external_ref TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(run_id) REFERENCES runs(id)
      )
    `);
    db.run(`CREATE INDEX IF NOT EXISTS idx_runs_repo ON runs(repo_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_runs_root ON runs(root_run_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_runs_parent ON runs(parent_run_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_run_edges_parent ON run_edges(parent_run_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_run_edges_child ON run_edges(child_run_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_events_root ON events(root_run_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts_utc)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_channel_bindings_run ON channel_bindings(run_id)`);
  }

  private mapRepoRow(row: RepoRow): Repo {
    return {
      id: row.id,
      owner: row.owner,
      repo: row.repo,
      githubAppId: row.github_app_id,
      installationId: row.installation_id,
      defaultBranch: row.default_branch,
      testFramework: row.test_framework,
      containerImage: row.container_image,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  getOrCreateRepo(owner: string, repo: string, installationId: number): Repo {
    const db = this.getDb(owner, repo);
    const existingRow = db.query(`SELECT * FROM repo_config WHERE owner = ? AND repo = ?`).get(owner, repo) as RepoRow | undefined;
    const existing = existingRow ? this.mapRepoRow(existingRow) : undefined;

    if (existing) {
      if (existing.installationId !== installationId) {
        db.query(`UPDATE repo_config SET installation_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
          .run(installationId, existing.id);
        existing.installationId = installationId;
      }
      this.repoIdIndex.set(existing.id, `${owner}/${repo}`);
      return existing;
    }

    const result = db.query(`
      INSERT INTO repo_config (owner, repo, installation_id, default_branch)
      VALUES (?, ?, ?, 'main')
      RETURNING *
    `).get(owner, repo, installationId) as RepoRow;

    const mapped = this.mapRepoRow(result);
    this.repoIdIndex.set(mapped.id, `${owner}/${repo}`);
    return mapped;
  }

  getRepo(owner: string, repo: string): Repo | undefined {
    const db = this.getDb(owner, repo);
    const row = db.query(`SELECT * FROM repo_config WHERE owner = ? AND repo = ?`).get(owner, repo) as RepoRow | undefined;
    return row ? this.mapRepoRow(row) : undefined;
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
    this.sessionRepoIndex.set(result.id, repoId);
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

  createRun(params: CreateRunParams): Run {
    const db = this.getDbById(params.repoId);
    const parentRunId = params.parentRunId ?? null;
    let rootRunId = params.rootRunId;

    if (!rootRunId) {
      if (parentRunId) {
        const parent = this.getRun(parentRunId);
        if (!parent) {
          throw new Error(`Parent run not found: ${parentRunId}`);
        }
        if (parent.repo_id !== params.repoId) {
          throw new Error(`Parent run repo mismatch for run: ${parentRunId}`);
        }
        rootRunId = parent.root_run_id;
      } else {
        rootRunId = params.id;
      }
    }

    const result = db.query(`
      INSERT INTO runs (id, repo_id, parent_run_id, root_run_id, status, source, source_ref, task_input, started_at, completed_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))
      RETURNING *
    `).get(
      params.id,
      params.repoId,
      parentRunId,
      rootRunId,
      params.status,
      params.source,
      params.sourceRef,
      params.taskInput,
      params.startedAt ?? null,
      params.completedAt ?? null,
      params.createdAt ?? null,
    ) as Run;

    this.runRepoIndex.set(result.id, result.repo_id);
    if (parentRunId) {
      db.query(`
        INSERT OR IGNORE INTO run_edges (parent_run_id, child_run_id, created_at)
        VALUES (?, ?, COALESCE(?, CURRENT_TIMESTAMP))
      `).run(parentRunId, result.id, params.createdAt ?? null);
    }

    return result;
  }

  updateRun(runId: string, updates: UpdateRunParams): void {
    const db = this.getDbByRunId(runId);
    const fields: string[] = [];
    const values: any[] = [];

    if (updates.status !== undefined) {
      fields.push("status = ?");
      values.push(updates.status);
    }
    if (updates.source !== undefined) {
      fields.push("source = ?");
      values.push(updates.source);
    }
    if (updates.sourceRef !== undefined) {
      fields.push("source_ref = ?");
      values.push(updates.sourceRef);
    }
    if (updates.taskInput !== undefined) {
      fields.push("task_input = ?");
      values.push(updates.taskInput);
    }
    if (updates.startedAt !== undefined) {
      fields.push("started_at = ?");
      values.push(updates.startedAt);
    }
    if (updates.completedAt !== undefined) {
      fields.push("completed_at = ?");
      values.push(updates.completedAt);
    }

    if (fields.length === 0) {
      return;
    }

    values.push(runId);
    db.query(`UPDATE runs SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  }

  getRun(runId: string): Run | undefined {
    const db = this.tryGetDbByRunId(runId);
    if (!db) {
      return undefined;
    }
    const run = db.query(`SELECT * FROM runs WHERE id = ?`).get(runId) as Run | undefined;
    if (run) {
      this.runRepoIndex.set(run.id, run.repo_id);
    }
    return run;
  }

  findLatestRunForRepo(repoId: number): Run | undefined {
    const db = this.getDbById(repoId);
    return db.query(`SELECT * FROM runs WHERE repo_id = ? ORDER BY created_at DESC LIMIT 1`).get(repoId) as Run | undefined;
  }

  findLatestActiveRunForRepo(repoId: number): Run | undefined {
    const db = this.getDbById(repoId);
    return db.query(`SELECT * FROM runs WHERE repo_id = ? AND status IN ('pending', 'running') ORDER BY created_at DESC LIMIT 1`).get(repoId) as Run | undefined;
  }

  createChildRun(parentRunId: string, params: CreateChildRunParams): Run {
    const parent = this.getRun(parentRunId);
    if (!parent) {
      throw new Error(`Parent run not found: ${parentRunId}`);
    }

    const repoId = params.repoId ?? parent.repo_id;
    if (repoId !== parent.repo_id) {
      throw new Error(`Child run repo mismatch for parent run: ${parentRunId}`);
    }

    return this.createRun({
      id: params.id,
      repoId,
      parentRunId,
      rootRunId: parent.root_run_id,
      status: params.status,
      source: params.source,
      sourceRef: params.sourceRef,
      taskInput: params.taskInput,
      startedAt: params.startedAt,
      completedAt: params.completedAt,
      createdAt: params.createdAt,
    });
  }

  appendEvent(params: AppendEventParams): EventRow {
    const run = this.getRun(params.runId);
    if (!run) {
      throw new Error(`Run not found: ${params.runId}`);
    }

    const db = this.getDbByRunId(params.runId);
    const result = db.query(`
      INSERT INTO events (id, run_id, root_run_id, parent_run_id, repo_id, source, source_ref, event_type, ts_utc, payload)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP), ?)
      RETURNING *
    `).get(
      params.id,
      params.runId,
      params.rootRunId ?? run.root_run_id,
      params.parentRunId === undefined ? run.parent_run_id : params.parentRunId,
      params.repoId ?? run.repo_id,
      params.source ?? run.source,
      params.sourceRef ?? run.source_ref,
      params.eventType,
      params.tsUtc ?? null,
      params.payload,
    ) as EventRow;

    return result;
  }

  listEventsByRun(runId: string): EventRow[] {
    const db = this.getDbByRunId(runId);
    return db.query(`SELECT * FROM events WHERE run_id = ? ORDER BY ts_utc ASC, id ASC`).all(runId) as EventRow[];
  }

  bindChannel(params: BindChannelParams): ChannelBinding {
    const db = this.getDbByRunId(params.runId);
    const result = db.query(`
      INSERT INTO channel_bindings (id, run_id, platform, channel_id, thread_id, external_ref, created_at)
      VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))
      RETURNING *
    `).get(
      params.id,
      params.runId,
      params.platform,
      params.channelId,
      params.threadId,
      params.externalRef,
      params.createdAt ?? null,
    ) as ChannelBinding;

    return result;
  }

  getBindingsByRun(runId: string): ChannelBinding[] {
    const db = this.getDbByRunId(runId);
    return db.query(`SELECT * FROM channel_bindings WHERE run_id = ? ORDER BY created_at ASC, id ASC`).all(runId) as ChannelBinding[];
  }

  getBindingsByRootRun(rootRunId: string): ChannelBinding[] {
    const db = this.getDbByRunId(rootRunId);
    return db.query(`
      SELECT cb.*
      FROM channel_bindings cb
      INNER JOIN runs r ON r.id = cb.run_id
      WHERE r.root_run_id = ?
      ORDER BY cb.created_at ASC, cb.id ASC
    `).all(rootRunId) as ChannelBinding[];
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
    const cached = this.repoIdIndex.get(repoId);
    if (cached) {
      const db = this.dbs.get(cached);
      if (db) return db;
    }
    for (const [, db] of this.dbs) {
      const row = db.query(`SELECT owner, repo FROM repo_config WHERE id = ?`).get(repoId) as { owner: string; repo: string } | undefined;
      if (row) {
        this.repoIdIndex.set(repoId, `${row.owner}/${row.repo}`);
        return this.getDb(row.owner, row.repo);
      }
    }
    throw new Error(`Repo not found for id: ${repoId}`);
  }

  private getDbBySessionId(sessionId: number): Database {
    const cachedRepoId = this.sessionRepoIndex.get(sessionId);
    if (cachedRepoId !== undefined) {
      return this.getDbById(cachedRepoId);
    }
    for (const [, db] of this.dbs) {
      const row = db.query(`SELECT repo_id FROM agent_sessions WHERE id = ?`).get(sessionId) as { repo_id: number } | undefined;
      if (row) {
        this.sessionRepoIndex.set(sessionId, row.repo_id);
        return this.getDbById(row.repo_id);
      }
    }
    throw new Error(`Session not found for id: ${sessionId}`);
  }

  getRepos(): Repo[] {
    const repos: Repo[] = [];
    const files = fs.readdirSync(DB_DIR).filter(f => f.endsWith(".db"));
    for (const file of files) {
      const match = file.match(/^repo_(.+?)_(.+?)\.db$/) || file.match(/^(.+?)_(.+?)\.db$/);
      if (match) {
        let owner = match[1];
        let repo = match[2];
        try {
          const config = this.getRepo(owner, repo);
          if (config) repos.push(config);
        } catch {}
      }
    }
    return repos;
  }

  getRecentSessions(limit: number): AgentSession[] {
    const sessions: AgentSession[] = [];
    const repos = this.getRepos();
    for (const r of repos) {
      try {
        const db = this.getDb(r.owner, r.repo);
        const rows = db.query(`SELECT * FROM agent_sessions ORDER BY id DESC LIMIT ?`).all(limit) as any[];
        for (const row of rows) {
          sessions.push({
            id: row.id,
            repoId: row.repo_id,
            discordThreadId: row.discord_thread_id,
            status: row.status,
            taskType: row.task_type,
            taskInput: row.task_input,
            result: row.result,
            startedAt: row.started_at,
            completedAt: row.completed_at,
          });
        }
      } catch {}
    }
    return sessions.sort((a, b) => b.id - a.id).slice(0, limit);
  }

  getRunsBySession(sessionId: number): Run[] {
    const db = this.getDbBySessionId(sessionId);
    const rows = db.query(`
      SELECT r.* FROM runs r
      JOIN events e ON e.run_id = r.id
      WHERE e.event_type IN ('discord.message.received', 'github.issue_comment', 'github.pull_request_review')
        AND e.payload LIKE ?
    `).all(`%"sessionId":${sessionId}%`) as any[];

    return rows.map(row => ({
      id: row.id,
      repo_id: row.repo_id,
      parent_run_id: row.parent_run_id,
      root_run_id: row.root_run_id,
      status: row.status,
      source: row.source,
      source_ref: row.source_ref,
      task_input: row.task_input,
      started_at: row.started_at,
      completed_at: row.completed_at,
      created_at: row.created_at,
    }));
  }

  getEventsByRun(runId: string): any[] {
    const db = this.getDbByRunId(runId);
    const rows = db.query(`SELECT * FROM events WHERE run_id = ? ORDER BY ts_utc ASC`).all(runId) as any[];
    return rows.map(row => ({
      id: row.id,
      runId: row.run_id,
      rootRunId: row.root_run_id,
      parentRunId: row.parent_run_id,
      repoId: row.repo_id,
      source: row.source,
      sourceRef: row.source_ref,
      eventType: row.event_type,
      tsUtc: row.ts_utc,
      payload: row.payload,
    }));
  }

  private getDbByRunId(runId: string): Database {
    const db = this.tryGetDbByRunId(runId);
    if (db) {
      return db;
    }
    throw new Error(`Run not found for id: ${runId}`);
  }

  private tryGetDbByRunId(runId: string): Database | undefined {
    const cachedRepoId = this.runRepoIndex.get(runId);
    if (cachedRepoId !== undefined) {
      return this.getDbById(cachedRepoId);
    }
    for (const [, db] of this.dbs) {
      const row = db.query(`SELECT repo_id FROM runs WHERE id = ?`).get(runId) as { repo_id: number } | undefined;
      if (row) {
        this.runRepoIndex.set(runId, row.repo_id);
        return this.getDbById(row.repo_id);
      }
    }
    return undefined;
  }
}

export const repoDb = new RepoDB();
