import Database from "better-sqlite3";
import { join } from "node:path";
import { mkdirSync, existsSync } from "node:fs";
import { logger } from "../../infra/logger.js";
import { StateError } from "../../infra/errors.js";
import {
  Issue,
  IssueState,
  IssueTransition,
  IssueWorkRecord,
  VALID_TRANSITIONS,
} from "../../types/issue.js";
import { Session, SessionStatus, SessionTransition } from "../../types/session.js";

/**
 * StateManager - SQLite-backed persistence for issues, sessions, and transitions
 *
 * Provides:
 * - Issue state machine with validated transitions
 * - Session tracking and resume capability
 * - Audit log of all state changes
 * - Query methods for reporting
 */
export class StateManager {
  private db: Database.Database;

  constructor(dataDir: string) {
    const dbPath = join(dataDir, "state.db");

    // Ensure directory exists
    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL"); // Better concurrent access
    this.initSchema();

    logger.debug(`StateManager initialized with database: ${dbPath}`);
  }

  private initSchema(): void {
    this.db.exec(`
      -- Projects table
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        default_branch TEXT DEFAULT 'main',
        clone_url TEXT,
        stars INTEGER DEFAULT 0,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      -- Issues table
      CREATE TABLE IF NOT EXISTS issues (
        id TEXT PRIMARY KEY,
        url TEXT NOT NULL UNIQUE,
        number INTEGER NOT NULL,
        title TEXT NOT NULL,
        body TEXT,
        labels TEXT, -- JSON array
        state TEXT NOT NULL DEFAULT 'discovered',
        author TEXT,
        assignee TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        project_id TEXT NOT NULL,
        has_linked_pr INTEGER DEFAULT 0,
        linked_pr_url TEXT,
        FOREIGN KEY (project_id) REFERENCES projects(id)
      );

      -- Issue transitions (audit log)
      CREATE TABLE IF NOT EXISTS issue_transitions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        issue_id TEXT NOT NULL,
        from_state TEXT NOT NULL,
        to_state TEXT NOT NULL,
        timestamp TEXT DEFAULT CURRENT_TIMESTAMP,
        reason TEXT,
        session_id TEXT,
        FOREIGN KEY (issue_id) REFERENCES issues(id)
      );

      -- Sessions table
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        issue_id TEXT NOT NULL,
        issue_url TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        started_at TEXT DEFAULT CURRENT_TIMESTAMP,
        last_activity_at TEXT DEFAULT CURRENT_TIMESTAMP,
        completed_at TEXT,
        turn_count INTEGER DEFAULT 0,
        cost_usd REAL DEFAULT 0,
        pr_url TEXT,
        working_directory TEXT,
        can_resume INTEGER DEFAULT 1,
        error TEXT,
        FOREIGN KEY (issue_id) REFERENCES issues(id)
      );

      -- Session transitions (audit log)
      CREATE TABLE IF NOT EXISTS session_transitions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        from_status TEXT NOT NULL,
        to_status TEXT NOT NULL,
        timestamp TEXT DEFAULT CURRENT_TIMESTAMP,
        reason TEXT,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      );

      -- Issue work records (tracks work done on issues)
      CREATE TABLE IF NOT EXISTS issue_work_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        issue_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        branch_name TEXT NOT NULL,
        worktree_path TEXT,
        pr_number INTEGER,
        pr_url TEXT,
        attempts INTEGER DEFAULT 1,
        last_attempt_at TEXT DEFAULT CURRENT_TIMESTAMP,
        total_cost_usd REAL DEFAULT 0,
        FOREIGN KEY (issue_id) REFERENCES issues(id),
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      );

      -- Indexes for common queries
      CREATE INDEX IF NOT EXISTS idx_issues_state ON issues(state);
      CREATE INDEX IF NOT EXISTS idx_issues_project ON issues(project_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
      CREATE INDEX IF NOT EXISTS idx_sessions_issue ON sessions(issue_id);
      CREATE INDEX IF NOT EXISTS idx_issue_transitions_issue ON issue_transitions(issue_id);
    `);
  }

  // ============ Project Methods ============

  /**
   * Ensure a project exists (creates if not present)
   */
  ensureProject(projectId: string, url?: string): void {
    const parts = projectId.split("/");
    const owner = parts[0] ?? projectId;
    const name = parts[1] ?? projectId;

    this.db
      .prepare(
        `
      INSERT INTO projects (id, owner, name, url)
      VALUES (@id, @owner, @name, @url)
      ON CONFLICT(id) DO NOTHING
    `
      )
      .run({
        id: projectId,
        owner,
        name,
        url: url ?? `https://github.com/${projectId}`,
      });
  }

  // ============ Issue Methods ============

  /**
   * Save or update an issue
   */
  saveIssue(issue: Issue): void {
    // Ensure the project exists first
    this.ensureProject(issue.projectId);

    const stmt = this.db.prepare(`
      INSERT INTO issues (id, url, number, title, body, labels, state, author, assignee,
                          created_at, updated_at, project_id, has_linked_pr, linked_pr_url)
      VALUES (@id, @url, @number, @title, @body, @labels, @state, @author, @assignee,
              @createdAt, @updatedAt, @projectId, @hasLinkedPR, @linkedPRUrl)
      ON CONFLICT(id) DO UPDATE SET
        title = @title,
        body = @body,
        labels = @labels,
        state = @state,
        assignee = @assignee,
        updated_at = @updatedAt,
        has_linked_pr = @hasLinkedPR,
        linked_pr_url = @linkedPRUrl
    `);

    stmt.run({
      id: issue.id,
      url: issue.url,
      number: issue.number,
      title: issue.title,
      body: issue.body,
      labels: JSON.stringify(issue.labels),
      state: issue.state,
      author: issue.author,
      assignee: issue.assignee,
      createdAt: issue.createdAt.toISOString(),
      updatedAt: issue.updatedAt.toISOString(),
      projectId: issue.projectId,
      hasLinkedPR: issue.hasLinkedPR ? 1 : 0,
      linkedPRUrl: issue.linkedPRUrl,
    });
  }

  /**
   * Get an issue by ID
   */
  getIssue(id: string): Issue | null {
    const row = this.db.prepare("SELECT * FROM issues WHERE id = ?").get(id) as
      | IssueRow
      | undefined;

    return row ? this.rowToIssue(row) : null;
  }

  /**
   * Get an issue by URL
   */
  getIssueByUrl(url: string): Issue | null {
    const row = this.db.prepare("SELECT * FROM issues WHERE url = ?").get(url) as
      | IssueRow
      | undefined;

    return row ? this.rowToIssue(row) : null;
  }

  /**
   * Get issues by state
   */
  getIssuesByState(state: IssueState): Issue[] {
    const rows = this.db
      .prepare("SELECT * FROM issues WHERE state = ? ORDER BY updated_at DESC")
      .all(state) as IssueRow[];

    return rows.map((row) => this.rowToIssue(row));
  }

  /**
   * Get issues by project
   */
  getIssuesByProject(projectId: string): Issue[] {
    const rows = this.db
      .prepare("SELECT * FROM issues WHERE project_id = ? ORDER BY updated_at DESC")
      .all(projectId) as IssueRow[];

    return rows.map((row) => this.rowToIssue(row));
  }

  /**
   * Transition an issue to a new state with validation
   */
  transitionIssue(issueId: string, toState: IssueState, reason: string, sessionId?: string): void {
    const issue = this.getIssue(issueId);
    if (!issue) {
      throw new StateError(`Issue not found: ${issueId}`);
    }

    const validTargets = VALID_TRANSITIONS[issue.state];
    if (!validTargets.includes(toState)) {
      throw new StateError(
        `Invalid transition: ${issue.state} → ${toState}. Valid targets: ${validTargets.join(", ")}`
      );
    }

    const transition: IssueTransition = {
      issueId,
      fromState: issue.state,
      toState,
      timestamp: new Date(),
      reason,
    };
    if (sessionId !== undefined) {
      transition.sessionId = sessionId;
    }

    // Update issue state and record transition in a transaction
    this.db.transaction(() => {
      this.db
        .prepare("UPDATE issues SET state = ?, updated_at = ? WHERE id = ?")
        .run(toState, new Date().toISOString(), issueId);

      this.db
        .prepare(
          `INSERT INTO issue_transitions (issue_id, from_state, to_state, timestamp, reason, session_id)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(
          transition.issueId,
          transition.fromState,
          transition.toState,
          transition.timestamp.toISOString(),
          transition.reason,
          transition.sessionId ?? null
        );
    })();

    logger.debug(`Issue ${issueId} transitioned: ${issue.state} → ${toState} (${reason})`);
  }

  /**
   * Get transition history for an issue
   */
  getIssueTransitions(issueId: string): IssueTransition[] {
    const rows = this.db
      .prepare("SELECT * FROM issue_transitions WHERE issue_id = ? ORDER BY timestamp ASC")
      .all(issueId) as IssueTransitionRow[];

    return rows.map((row) => {
      const transition: IssueTransition = {
        issueId: row.issue_id,
        fromState: row.from_state as IssueState,
        toState: row.to_state as IssueState,
        timestamp: new Date(row.timestamp),
        reason: row.reason,
      };
      if (row.session_id !== null) {
        transition.sessionId = row.session_id;
      }
      return transition;
    });
  }

  // ============ Session Methods ============

  /**
   * Create a new session
   */
  createSession(session: Omit<Session, "id">): Session {
    const id = `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const newSession: Session = { id, ...session };

    const stmt = this.db.prepare(`
      INSERT INTO sessions (id, issue_id, issue_url, status, provider, model, started_at,
                            last_activity_at, completed_at, turn_count, cost_usd, pr_url,
                            working_directory, can_resume, error)
      VALUES (@id, @issueId, @issueUrl, @status, @provider, @model, @startedAt,
              @lastActivityAt, @completedAt, @turnCount, @costUsd, @prUrl,
              @workingDirectory, @canResume, @error)
    `);

    stmt.run({
      id: newSession.id,
      issueId: newSession.issueId,
      issueUrl: newSession.issueUrl,
      status: newSession.status,
      provider: newSession.provider,
      model: newSession.model,
      startedAt: newSession.startedAt.toISOString(),
      lastActivityAt: newSession.lastActivityAt.toISOString(),
      completedAt: newSession.completedAt?.toISOString() ?? null,
      turnCount: newSession.turnCount,
      costUsd: newSession.costUsd,
      prUrl: newSession.prUrl,
      workingDirectory: newSession.workingDirectory,
      canResume: newSession.canResume ? 1 : 0,
      error: newSession.error,
    });

    logger.debug(`Created session ${id} for issue ${newSession.issueId}`);
    return newSession;
  }

  /**
   * Get a session by ID
   */
  getSession(id: string): Session | null {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as
      | SessionRow
      | undefined;

    return row ? this.rowToSession(row) : null;
  }

  /**
   * Get the most recent session for an issue
   */
  getLatestSessionForIssue(issueId: string): Session | null {
    const row = this.db
      .prepare("SELECT * FROM sessions WHERE issue_id = ? ORDER BY started_at DESC LIMIT 1")
      .get(issueId) as SessionRow | undefined;

    return row ? this.rowToSession(row) : null;
  }

  /**
   * Get active sessions
   */
  getActiveSessions(): Session[] {
    const rows = this.db
      .prepare("SELECT * FROM sessions WHERE status = 'active' ORDER BY started_at DESC")
      .all() as SessionRow[];

    return rows.map((row) => this.rowToSession(row));
  }

  /**
   * Update session status with transition logging
   */
  transitionSession(sessionId: string, toStatus: SessionStatus, reason: string): void {
    const session = this.getSession(sessionId);
    if (!session) {
      throw new StateError(`Session not found: ${sessionId}`);
    }

    const transition: SessionTransition = {
      sessionId,
      fromStatus: session.status,
      toStatus,
      timestamp: new Date(),
      reason,
    };

    this.db.transaction(() => {
      const updates: Record<string, unknown> = {
        status: toStatus,
        lastActivityAt: new Date().toISOString(),
      };

      if (toStatus === "completed" || toStatus === "failed") {
        updates.completedAt = new Date().toISOString();
      }

      const setClauses = Object.keys(updates)
        .map((k) => `${this.camelToSnake(k)} = @${k}`)
        .join(", ");

      this.db
        .prepare(`UPDATE sessions SET ${setClauses} WHERE id = @sessionId`)
        .run({ ...updates, sessionId });

      this.db
        .prepare(
          `INSERT INTO session_transitions (session_id, from_status, to_status, timestamp, reason)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(
          transition.sessionId,
          transition.fromStatus,
          transition.toStatus,
          transition.timestamp.toISOString(),
          transition.reason
        );
    })();

    logger.debug(`Session ${sessionId} transitioned: ${session.status} → ${toStatus} (${reason})`);
  }

  /**
   * Update session metrics (turns, cost)
   */
  updateSessionMetrics(
    sessionId: string,
    metrics: { turnCount?: number; costUsd?: number; prUrl?: string }
  ): void {
    const updates: string[] = ["last_activity_at = @lastActivityAt"];
    const params: Record<string, unknown> = {
      sessionId,
      lastActivityAt: new Date().toISOString(),
    };

    if (metrics.turnCount !== undefined) {
      updates.push("turn_count = @turnCount");
      params.turnCount = metrics.turnCount;
    }
    if (metrics.costUsd !== undefined) {
      updates.push("cost_usd = @costUsd");
      params.costUsd = metrics.costUsd;
    }
    if (metrics.prUrl !== undefined) {
      updates.push("pr_url = @prUrl");
      params.prUrl = metrics.prUrl;
    }

    this.db.prepare(`UPDATE sessions SET ${updates.join(", ")} WHERE id = @sessionId`).run(params);
  }

  // ============ Work Record Methods ============

  /**
   * Save or update a work record
   */
  saveWorkRecord(record: IssueWorkRecord): void {
    const stmt = this.db.prepare(`
      INSERT INTO issue_work_records (issue_id, session_id, branch_name, worktree_path,
                                       pr_number, pr_url, attempts, last_attempt_at, total_cost_usd)
      VALUES (@issueId, @sessionId, @branchName, @worktreePath, @prNumber, @prUrl,
              @attempts, @lastAttemptAt, @totalCostUsd)
      ON CONFLICT(issue_id, session_id) DO UPDATE SET
        pr_number = @prNumber,
        pr_url = @prUrl,
        attempts = @attempts,
        last_attempt_at = @lastAttemptAt,
        total_cost_usd = @totalCostUsd
    `);

    stmt.run({
      issueId: record.issueId,
      sessionId: record.sessionId,
      branchName: record.branchName,
      worktreePath: record.worktreePath,
      prNumber: record.prNumber ?? null,
      prUrl: record.prUrl ?? null,
      attempts: record.attempts,
      lastAttemptAt: record.lastAttemptAt.toISOString(),
      totalCostUsd: record.totalCostUsd,
    });
  }

  /**
   * Get work record for an issue
   */
  getWorkRecord(issueId: string): IssueWorkRecord | null {
    const row = this.db
      .prepare(
        "SELECT * FROM issue_work_records WHERE issue_id = ? ORDER BY last_attempt_at DESC LIMIT 1"
      )
      .get(issueId) as WorkRecordRow | undefined;

    return row ? this.rowToWorkRecord(row) : null;
  }

  /**
   * Get all work records
   */
  getAllWorkRecords(): IssueWorkRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM issue_work_records ORDER BY last_attempt_at DESC")
      .all() as WorkRecordRow[];

    return rows.map((row) => this.rowToWorkRecord(row));
  }

  /**
   * Get work record by PR URL
   */
  getWorkRecordByPRUrl(prUrl: string): IssueWorkRecord | null {
    const row = this.db.prepare("SELECT * FROM issue_work_records WHERE pr_url = ?").get(prUrl) as
      | WorkRecordRow
      | undefined;

    return row ? this.rowToWorkRecord(row) : null;
  }

  private rowToWorkRecord(row: WorkRecordRow): IssueWorkRecord {
    const record: IssueWorkRecord = {
      issueId: row.issue_id,
      sessionId: row.session_id,
      branchName: row.branch_name,
      worktreePath: row.worktree_path,
      attempts: row.attempts,
      lastAttemptAt: new Date(row.last_attempt_at),
      totalCostUsd: row.total_cost_usd,
    };
    if (row.pr_number !== null) {
      record.prNumber = row.pr_number;
    }
    if (row.pr_url !== null) {
      record.prUrl = row.pr_url;
    }
    return record;
  }

  // ============ Statistics ============

  /**
   * Get summary statistics
   */
  getStats(): {
    totalIssues: number;
    issuesByState: Record<IssueState, number>;
    totalSessions: number;
    activeSessions: number;
    totalCostUsd: number;
  } {
    const totalIssues = (
      this.db.prepare("SELECT COUNT(*) as count FROM issues").get() as { count: number }
    ).count;

    const stateRows = this.db
      .prepare("SELECT state, COUNT(*) as count FROM issues GROUP BY state")
      .all() as { state: IssueState; count: number }[];

    const issuesByState = {} as Record<IssueState, number>;
    for (const row of stateRows) {
      issuesByState[row.state] = row.count;
    }

    const totalSessions = (
      this.db.prepare("SELECT COUNT(*) as count FROM sessions").get() as { count: number }
    ).count;

    const activeSessions = (
      this.db.prepare("SELECT COUNT(*) as count FROM sessions WHERE status = 'active'").get() as {
        count: number;
      }
    ).count;

    const totalCostUsd = (
      this.db.prepare("SELECT COALESCE(SUM(cost_usd), 0) as total FROM sessions").get() as {
        total: number;
      }
    ).total;

    return {
      totalIssues,
      issuesByState,
      totalSessions,
      activeSessions,
      totalCostUsd,
    };
  }

  /**
   * Close the database connection
   */
  close(): void {
    this.db.close();
  }

  // ============ Private Helpers ============

  private rowToIssue(row: IssueRow): Issue {
    return {
      id: row.id,
      url: row.url,
      number: row.number,
      title: row.title,
      body: row.body ?? "",
      labels: JSON.parse(row.labels ?? "[]") as string[],
      state: row.state as IssueState,
      author: row.author ?? "",
      assignee: row.assignee,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
      projectId: row.project_id,
      hasLinkedPR: row.has_linked_pr === 1,
      linkedPRUrl: row.linked_pr_url,
    };
  }

  private rowToSession(row: SessionRow): Session {
    return {
      id: row.id,
      issueId: row.issue_id,
      issueUrl: row.issue_url,
      status: row.status as SessionStatus,
      provider: row.provider,
      model: row.model,
      startedAt: new Date(row.started_at),
      lastActivityAt: new Date(row.last_activity_at),
      completedAt: row.completed_at ? new Date(row.completed_at) : null,
      turnCount: row.turn_count,
      costUsd: row.cost_usd,
      prUrl: row.pr_url,
      workingDirectory: row.working_directory,
      canResume: row.can_resume === 1,
      error: row.error,
    };
  }

  private camelToSnake(str: string): string {
    return str.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
  }
}

// Row types for SQLite results
interface IssueRow {
  id: string;
  url: string;
  number: number;
  title: string;
  body: string | null;
  labels: string | null;
  state: string;
  author: string | null;
  assignee: string | null;
  created_at: string;
  updated_at: string;
  project_id: string;
  has_linked_pr: number;
  linked_pr_url: string | null;
}

interface SessionRow {
  id: string;
  issue_id: string;
  issue_url: string;
  status: string;
  provider: string;
  model: string;
  started_at: string;
  last_activity_at: string;
  completed_at: string | null;
  turn_count: number;
  cost_usd: number;
  pr_url: string | null;
  working_directory: string;
  can_resume: number;
  error: string | null;
}

interface IssueTransitionRow {
  id: number;
  issue_id: string;
  from_state: string;
  to_state: string;
  timestamp: string;
  reason: string;
  session_id: string | null;
}

interface WorkRecordRow {
  id: number;
  issue_id: string;
  session_id: string;
  branch_name: string;
  worktree_path: string;
  pr_number: number | null;
  pr_url: string | null;
  attempts: number;
  last_attempt_at: string;
  total_cost_usd: number;
}
