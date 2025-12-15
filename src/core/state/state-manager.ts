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
        FOREIGN KEY (session_id) REFERENCES sessions(id),
        UNIQUE(issue_id, session_id)
      );

      -- Indexes for common queries
      CREATE INDEX IF NOT EXISTS idx_issues_state ON issues(state);
      CREATE INDEX IF NOT EXISTS idx_issues_project ON issues(project_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
      CREATE INDEX IF NOT EXISTS idx_sessions_issue ON sessions(issue_id);
      CREATE INDEX IF NOT EXISTS idx_issue_transitions_issue ON issue_transitions(issue_id);

      -- Parallel work sessions (Phase 5)
      CREATE TABLE IF NOT EXISTS parallel_sessions (
        id TEXT PRIMARY KEY,
        started_at TEXT DEFAULT CURRENT_TIMESTAMP,
        completed_at TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        total_issues INTEGER NOT NULL,
        completed_issues INTEGER DEFAULT 0,
        failed_issues INTEGER DEFAULT 0,
        cancelled_issues INTEGER DEFAULT 0,
        max_concurrent INTEGER NOT NULL,
        total_cost_usd REAL DEFAULT 0,
        total_duration_ms INTEGER DEFAULT 0
      );

      -- Link issues to parallel sessions
      CREATE TABLE IF NOT EXISTS parallel_session_issues (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        parallel_session_id TEXT NOT NULL,
        issue_url TEXT NOT NULL,
        issue_id TEXT,
        session_id TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        started_at TEXT,
        completed_at TEXT,
        cost_usd REAL DEFAULT 0,
        error TEXT,
        FOREIGN KEY (parallel_session_id) REFERENCES parallel_sessions(id),
        FOREIGN KEY (issue_id) REFERENCES issues(id),
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      );

      -- Indexes for parallel sessions
      CREATE INDEX IF NOT EXISTS idx_parallel_sessions_status ON parallel_sessions(status);
      CREATE INDEX IF NOT EXISTS idx_parallel_session_issues_parallel ON parallel_session_issues(parallel_session_id);

      -- Monitored PRs table (Phase 3 - Feedback Loop)
      CREATE TABLE IF NOT EXISTS monitored_prs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pr_url TEXT NOT NULL UNIQUE,
        owner TEXT NOT NULL,
        repo TEXT NOT NULL,
        pr_number INTEGER NOT NULL,
        issue_id TEXT,
        session_id TEXT,
        state TEXT NOT NULL DEFAULT 'open',
        last_check_at TEXT,
        feedback_count INTEGER DEFAULT 0,
        iteration_count INTEGER DEFAULT 0,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (issue_id) REFERENCES issues(id),
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      );

      -- Index for monitored PRs
      CREATE INDEX IF NOT EXISTS idx_monitored_prs_state ON monitored_prs(state);

      -- Campaigns table (Phase 6 - B2B Mode)
      CREATE TABLE IF NOT EXISTS campaigns (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'draft',
        source_type TEXT NOT NULL DEFAULT 'manual',
        source_config TEXT, -- JSON
        budget_limit_usd REAL,
        budget_spent_usd REAL DEFAULT 0,
        total_issues INTEGER DEFAULT 0,
        completed_issues INTEGER DEFAULT 0,
        failed_issues INTEGER DEFAULT 0,
        skipped_issues INTEGER DEFAULT 0,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        started_at TEXT,
        completed_at TEXT,
        tags TEXT -- JSON array
      );

      -- Campaign issues junction table
      CREATE TABLE IF NOT EXISTS campaign_issues (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id TEXT NOT NULL,
        issue_url TEXT NOT NULL,
        external_issue_id TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        priority INTEGER DEFAULT 0,
        session_id TEXT,
        pr_url TEXT,
        cost_usd REAL,
        added_at TEXT DEFAULT CURRENT_TIMESTAMP,
        started_at TEXT,
        completed_at TEXT,
        error TEXT,
        attempts INTEGER DEFAULT 0,
        FOREIGN KEY (campaign_id) REFERENCES campaigns(id),
        FOREIGN KEY (session_id) REFERENCES sessions(id),
        UNIQUE(campaign_id, issue_url)
      );

      -- Campaign transitions (audit log)
      CREATE TABLE IF NOT EXISTS campaign_transitions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id TEXT NOT NULL,
        from_status TEXT NOT NULL,
        to_status TEXT NOT NULL,
        transitioned_at TEXT DEFAULT CURRENT_TIMESTAMP,
        triggered_by TEXT,
        reason TEXT,
        FOREIGN KEY (campaign_id) REFERENCES campaigns(id)
      );

      -- Indexes for campaigns
      CREATE INDEX IF NOT EXISTS idx_campaigns_status ON campaigns(status);
      CREATE INDEX IF NOT EXISTS idx_campaign_issues_campaign ON campaign_issues(campaign_id);
      CREATE INDEX IF NOT EXISTS idx_campaign_issues_status ON campaign_issues(status);
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
    // Check if record exists for this issue_id + session_id
    const existing = this.db
      .prepare("SELECT id FROM issue_work_records WHERE issue_id = ? AND session_id = ?")
      .get(record.issueId, record.sessionId) as { id: number } | undefined;

    if (existing) {
      // Update existing record
      this.db
        .prepare(
          `UPDATE issue_work_records SET
            pr_number = @prNumber,
            pr_url = @prUrl,
            attempts = @attempts,
            last_attempt_at = @lastAttemptAt,
            total_cost_usd = @totalCostUsd
          WHERE id = @id`
        )
        .run({
          id: existing.id,
          prNumber: record.prNumber ?? null,
          prUrl: record.prUrl ?? null,
          attempts: record.attempts,
          lastAttemptAt: record.lastAttemptAt.toISOString(),
          totalCostUsd: record.totalCostUsd,
        });
    } else {
      // Insert new record
      this.db
        .prepare(
          `INSERT INTO issue_work_records (issue_id, session_id, branch_name, worktree_path,
                                           pr_number, pr_url, attempts, last_attempt_at, total_cost_usd)
          VALUES (@issueId, @sessionId, @branchName, @worktreePath, @prNumber, @prUrl,
                  @attempts, @lastAttemptAt, @totalCostUsd)`
        )
        .run({
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

  // ============ Budget Tracking Methods ============

  /**
   * Get total cost since a given date
   */
  getCostSince(since: Date): number {
    const result = this.db
      .prepare(
        `SELECT COALESCE(SUM(cost_usd), 0) as total
         FROM sessions
         WHERE started_at >= ?`
      )
      .get(since.toISOString()) as { total: number };

    return result.total;
  }

  /**
   * Get today's total cost
   */
  getTodaysCost(): number {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return this.getCostSince(today);
  }

  /**
   * Get this month's total cost
   */
  getMonthsCost(): number {
    const firstOfMonth = new Date();
    firstOfMonth.setDate(1);
    firstOfMonth.setHours(0, 0, 0, 0);
    return this.getCostSince(firstOfMonth);
  }

  /**
   * Get cost breakdown by day for the last N days
   */
  getCostBreakdown(days: number = 30): Array<{ date: string; cost: number }> {
    const rows = this.db
      .prepare(
        `SELECT DATE(started_at) as date, SUM(cost_usd) as cost
         FROM sessions
         WHERE started_at >= DATE('now', '-' || ? || ' days')
         GROUP BY DATE(started_at)
         ORDER BY date DESC`
      )
      .all(days) as Array<{ date: string; cost: number }>;

    return rows;
  }

  // ============ Monitored PR Methods (Phase 3) ============

  /**
   * Register a PR for monitoring
   */
  registerMonitoredPR(options: {
    prUrl: string;
    owner: string;
    repo: string;
    prNumber: number;
    issueId?: string;
    sessionId?: string;
  }): MonitoredPR {
    const now = new Date();

    this.db
      .prepare(
        `INSERT INTO monitored_prs (pr_url, owner, repo, pr_number, issue_id, session_id, state, created_at, updated_at)
         VALUES (@prUrl, @owner, @repo, @prNumber, @issueId, @sessionId, 'open', @createdAt, @updatedAt)
         ON CONFLICT(pr_url) DO UPDATE SET
           issue_id = COALESCE(@issueId, issue_id),
           session_id = COALESCE(@sessionId, session_id),
           updated_at = @updatedAt`
      )
      .run({
        prUrl: options.prUrl,
        owner: options.owner,
        repo: options.repo,
        prNumber: options.prNumber,
        issueId: options.issueId ?? null,
        sessionId: options.sessionId ?? null,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      });

    logger.debug(`Registered PR for monitoring: ${options.prUrl}`);

    return {
      id: 0, // Will be set by database
      prUrl: options.prUrl,
      owner: options.owner,
      repo: options.repo,
      prNumber: options.prNumber,
      issueId: options.issueId ?? null,
      sessionId: options.sessionId ?? null,
      state: "open",
      lastCheckAt: null,
      feedbackCount: 0,
      iterationCount: 0,
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * Get a monitored PR by URL
   */
  getMonitoredPR(prUrl: string): MonitoredPR | null {
    const row = this.db.prepare("SELECT * FROM monitored_prs WHERE pr_url = ?").get(prUrl) as
      | MonitoredPRRow
      | undefined;

    return row ? this.rowToMonitoredPR(row) : null;
  }

  /**
   * Get all monitored PRs, optionally filtered by state
   */
  getMonitoredPRs(state?: MonitoredPRState): MonitoredPR[] {
    let query = "SELECT * FROM monitored_prs";
    const params: unknown[] = [];

    if (state) {
      query += " WHERE state = ?";
      params.push(state);
    }

    query += " ORDER BY updated_at DESC";

    const rows = this.db.prepare(query).all(...params) as MonitoredPRRow[];
    return rows.map((row) => this.rowToMonitoredPR(row));
  }

  /**
   * Update a monitored PR
   */
  updateMonitoredPR(
    prUrl: string,
    updates: Partial<{
      state: MonitoredPRState;
      lastCheckAt: Date;
      feedbackCount: number;
      iterationCount: number;
    }>
  ): void {
    const setClauses: string[] = ["updated_at = @updatedAt"];
    const params: Record<string, unknown> = {
      prUrl,
      updatedAt: new Date().toISOString(),
    };

    if (updates.state !== undefined) {
      setClauses.push("state = @state");
      params.state = updates.state;
    }
    if (updates.lastCheckAt !== undefined) {
      setClauses.push("last_check_at = @lastCheckAt");
      params.lastCheckAt = updates.lastCheckAt.toISOString();
    }
    if (updates.feedbackCount !== undefined) {
      setClauses.push("feedback_count = @feedbackCount");
      params.feedbackCount = updates.feedbackCount;
    }
    if (updates.iterationCount !== undefined) {
      setClauses.push("iteration_count = @iterationCount");
      params.iterationCount = updates.iterationCount;
    }

    this.db
      .prepare(`UPDATE monitored_prs SET ${setClauses.join(", ")} WHERE pr_url = @prUrl`)
      .run(params);
  }

  /**
   * Remove a monitored PR
   */
  removeMonitoredPR(prUrl: string): void {
    this.db.prepare("DELETE FROM monitored_prs WHERE pr_url = ?").run(prUrl);
    logger.debug(`Removed monitored PR: ${prUrl}`);
  }

  private rowToMonitoredPR(row: MonitoredPRRow): MonitoredPR {
    return {
      id: row.id,
      prUrl: row.pr_url,
      owner: row.owner,
      repo: row.repo,
      prNumber: row.pr_number,
      issueId: row.issue_id,
      sessionId: row.session_id,
      state: row.state as MonitoredPRState,
      lastCheckAt: row.last_check_at ? new Date(row.last_check_at) : null,
      feedbackCount: row.feedback_count,
      iterationCount: row.iteration_count,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }

  // ============ Rate Limiting Methods (Phase 4) ============

  /**
   * Get PRs created since a given date (for rate limiting)
   */
  getPRsCreatedSince(since: Date): Array<{
    issueId: string;
    projectId: string;
    prUrl: string;
    createdAt: Date;
  }> {
    const rows = this.db
      .prepare(
        `SELECT i.id as issue_id, i.project_id, i.linked_pr_url as pr_url, t.timestamp as created_at
         FROM issues i
         JOIN issue_transitions t ON i.id = t.issue_id
         WHERE t.to_state = 'pr_created' AND t.timestamp >= ?
         ORDER BY t.timestamp DESC`
      )
      .all(since.toISOString()) as Array<{
      issue_id: string;
      project_id: string;
      pr_url: string | null;
      created_at: string;
    }>;

    return rows
      .filter((row) => row.pr_url !== null)
      .map((row) => ({
        issueId: row.issue_id,
        projectId: row.project_id,
        prUrl: row.pr_url!,
        createdAt: new Date(row.created_at),
      }));
  }

  /**
   * Get count of PRs created today, grouped by project
   */
  getTodaysPRCounts(): { daily: number; byProject: Record<string, number> } {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const prs = this.getPRsCreatedSince(startOfDay);

    const byProject: Record<string, number> = {};
    for (const pr of prs) {
      byProject[pr.projectId] = (byProject[pr.projectId] ?? 0) + 1;
    }

    return {
      daily: prs.length,
      byProject,
    };
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

  // ============ Parallel Session Methods (Phase 5) ============

  /**
   * Create a new parallel work session
   */
  createParallelSession(options: { issueUrls: string[]; maxConcurrent: number }): ParallelSession {
    const id = `ps-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date();

    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO parallel_sessions (id, started_at, status, total_issues, max_concurrent)
           VALUES (?, ?, 'active', ?, ?)`
        )
        .run(id, now.toISOString(), options.issueUrls.length, options.maxConcurrent);

      const insertIssue = this.db.prepare(
        `INSERT INTO parallel_session_issues (parallel_session_id, issue_url, status)
         VALUES (?, ?, 'pending')`
      );

      for (const url of options.issueUrls) {
        insertIssue.run(id, url);
      }
    })();

    logger.debug(`Created parallel session ${id} with ${options.issueUrls.length} issues`);

    return {
      id,
      startedAt: now,
      completedAt: null,
      status: "active",
      totalIssues: options.issueUrls.length,
      completedIssues: 0,
      failedIssues: 0,
      cancelledIssues: 0,
      maxConcurrent: options.maxConcurrent,
      totalCostUsd: 0,
      totalDurationMs: 0,
    };
  }

  /**
   * Get a parallel session by ID
   */
  getParallelSession(id: string): ParallelSession | null {
    const row = this.db.prepare("SELECT * FROM parallel_sessions WHERE id = ?").get(id) as
      | ParallelSessionRow
      | undefined;

    return row ? this.rowToParallelSession(row) : null;
  }

  /**
   * Get active parallel sessions
   */
  getActiveParallelSessions(): ParallelSession[] {
    const rows = this.db
      .prepare("SELECT * FROM parallel_sessions WHERE status = 'active' ORDER BY started_at DESC")
      .all() as ParallelSessionRow[];

    return rows.map((row) => this.rowToParallelSession(row));
  }

  /**
   * Get all parallel sessions
   */
  getAllParallelSessions(limit = 20): ParallelSession[] {
    const rows = this.db
      .prepare("SELECT * FROM parallel_sessions ORDER BY started_at DESC LIMIT ?")
      .all(limit) as ParallelSessionRow[];

    return rows.map((row) => this.rowToParallelSession(row));
  }

  /**
   * Update a parallel session
   */
  updateParallelSession(
    id: string,
    updates: Partial<{
      status: ParallelSessionStatus;
      completedIssues: number;
      failedIssues: number;
      cancelledIssues: number;
      totalCostUsd: number;
      totalDurationMs: number;
    }>
  ): void {
    const setClauses: string[] = [];
    const params: Record<string, unknown> = { id };

    if (updates.status !== undefined) {
      setClauses.push("status = @status");
      params.status = updates.status;
      if (
        updates.status === "completed" ||
        updates.status === "failed" ||
        updates.status === "cancelled"
      ) {
        setClauses.push("completed_at = @completedAt");
        params.completedAt = new Date().toISOString();
      }
    }
    if (updates.completedIssues !== undefined) {
      setClauses.push("completed_issues = @completedIssues");
      params.completedIssues = updates.completedIssues;
    }
    if (updates.failedIssues !== undefined) {
      setClauses.push("failed_issues = @failedIssues");
      params.failedIssues = updates.failedIssues;
    }
    if (updates.cancelledIssues !== undefined) {
      setClauses.push("cancelled_issues = @cancelledIssues");
      params.cancelledIssues = updates.cancelledIssues;
    }
    if (updates.totalCostUsd !== undefined) {
      setClauses.push("total_cost_usd = @totalCostUsd");
      params.totalCostUsd = updates.totalCostUsd;
    }
    if (updates.totalDurationMs !== undefined) {
      setClauses.push("total_duration_ms = @totalDurationMs");
      params.totalDurationMs = updates.totalDurationMs;
    }

    if (setClauses.length > 0) {
      this.db
        .prepare(`UPDATE parallel_sessions SET ${setClauses.join(", ")} WHERE id = @id`)
        .run(params);
    }
  }

  /**
   * Get issues for a parallel session
   */
  getParallelSessionIssues(parallelSessionId: string): ParallelSessionIssue[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM parallel_session_issues WHERE parallel_session_id = ? ORDER BY id ASC"
      )
      .all(parallelSessionId) as ParallelSessionIssueRow[];

    return rows.map((row) => this.rowToParallelSessionIssue(row));
  }

  /**
   * Update an issue within a parallel session
   */
  updateParallelSessionIssue(
    parallelSessionId: string,
    issueUrl: string,
    updates: Partial<{
      issueId: string;
      sessionId: string;
      status: ParallelSessionIssueStatus;
      costUsd: number;
      error: string;
    }>
  ): void {
    const setClauses: string[] = [];
    const params: Record<string, unknown> = {
      parallelSessionId,
      issueUrl,
    };

    if (updates.issueId !== undefined) {
      setClauses.push("issue_id = @issueId");
      params.issueId = updates.issueId;
    }
    if (updates.sessionId !== undefined) {
      setClauses.push("session_id = @sessionId");
      params.sessionId = updates.sessionId;
    }
    if (updates.status !== undefined) {
      setClauses.push("status = @status");
      params.status = updates.status;

      if (updates.status === "in_progress") {
        setClauses.push("started_at = @startedAt");
        params.startedAt = new Date().toISOString();
      } else if (
        updates.status === "completed" ||
        updates.status === "failed" ||
        updates.status === "cancelled"
      ) {
        setClauses.push("completed_at = @completedAt");
        params.completedAt = new Date().toISOString();
      }
    }
    if (updates.costUsd !== undefined) {
      setClauses.push("cost_usd = @costUsd");
      params.costUsd = updates.costUsd;
    }
    if (updates.error !== undefined) {
      setClauses.push("error = @error");
      params.error = updates.error;
    }

    if (setClauses.length > 0) {
      this.db
        .prepare(
          `UPDATE parallel_session_issues SET ${setClauses.join(", ")}
           WHERE parallel_session_id = @parallelSessionId AND issue_url = @issueUrl`
        )
        .run(params);
    }
  }

  private rowToParallelSession(row: ParallelSessionRow): ParallelSession {
    return {
      id: row.id,
      startedAt: new Date(row.started_at),
      completedAt: row.completed_at ? new Date(row.completed_at) : null,
      status: row.status as ParallelSessionStatus,
      totalIssues: row.total_issues,
      completedIssues: row.completed_issues,
      failedIssues: row.failed_issues,
      cancelledIssues: row.cancelled_issues,
      maxConcurrent: row.max_concurrent,
      totalCostUsd: row.total_cost_usd,
      totalDurationMs: row.total_duration_ms,
    };
  }

  private rowToParallelSessionIssue(row: ParallelSessionIssueRow): ParallelSessionIssue {
    return {
      id: row.id,
      parallelSessionId: row.parallel_session_id,
      issueUrl: row.issue_url,
      issueId: row.issue_id,
      sessionId: row.session_id,
      status: row.status as ParallelSessionIssueStatus,
      startedAt: row.started_at ? new Date(row.started_at) : null,
      completedAt: row.completed_at ? new Date(row.completed_at) : null,
      costUsd: row.cost_usd,
      error: row.error,
    };
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

// Parallel session types (Phase 5)
export type ParallelSessionStatus = "active" | "completed" | "failed" | "cancelled";
export type ParallelSessionIssueStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "failed"
  | "cancelled";

export interface ParallelSession {
  id: string;
  startedAt: Date;
  completedAt: Date | null;
  status: ParallelSessionStatus;
  totalIssues: number;
  completedIssues: number;
  failedIssues: number;
  cancelledIssues: number;
  maxConcurrent: number;
  totalCostUsd: number;
  totalDurationMs: number;
}

export interface ParallelSessionIssue {
  id: number;
  parallelSessionId: string;
  issueUrl: string;
  issueId: string | null;
  sessionId: string | null;
  status: ParallelSessionIssueStatus;
  startedAt: Date | null;
  completedAt: Date | null;
  costUsd: number;
  error: string | null;
}

interface ParallelSessionRow {
  id: string;
  started_at: string;
  completed_at: string | null;
  status: string;
  total_issues: number;
  completed_issues: number;
  failed_issues: number;
  cancelled_issues: number;
  max_concurrent: number;
  total_cost_usd: number;
  total_duration_ms: number;
}

interface ParallelSessionIssueRow {
  id: number;
  parallel_session_id: string;
  issue_url: string;
  issue_id: string | null;
  session_id: string | null;
  status: string;
  started_at: string | null;
  completed_at: string | null;
  cost_usd: number;
  error: string | null;
}

// Monitored PR types (Phase 3)
export type MonitoredPRState = "open" | "merged" | "closed";

export interface MonitoredPR {
  id: number;
  prUrl: string;
  owner: string;
  repo: string;
  prNumber: number;
  issueId: string | null;
  sessionId: string | null;
  state: MonitoredPRState;
  lastCheckAt: Date | null;
  feedbackCount: number;
  iterationCount: number;
  createdAt: Date;
  updatedAt: Date;
}

interface MonitoredPRRow {
  id: number;
  pr_url: string;
  owner: string;
  repo: string;
  pr_number: number;
  issue_id: string | null;
  session_id: string | null;
  state: string;
  last_check_at: string | null;
  feedback_count: number;
  iteration_count: number;
  created_at: string;
  updated_at: string;
}

// Campaign types (Phase 6 - B2B Mode)
export type {
  Campaign,
  CampaignIssue,
  CampaignStatus,
  CampaignIssueStatus,
  CampaignSourceType,
  CampaignSourceConfig,
  CampaignProgress,
  CampaignFilters,
  CampaignIssueFilters,
  CreateCampaignOptions,
  UpdateCampaignOptions,
  CampaignTransition,
} from "../../types/campaign.js";
