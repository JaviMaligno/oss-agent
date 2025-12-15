/**
 * Campaign Service
 *
 * Manages campaign lifecycle and issue tracking for batch operations.
 */

import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { logger } from "../../infra/logger.js";
import { StateError } from "../../infra/errors.js";
import type {
  Campaign,
  CampaignIssue,
  CampaignStatus,
  CampaignIssueStatus,
  CampaignSourceType,
  CampaignProgress,
  CampaignFilters,
  CampaignIssueFilters,
  CreateCampaignOptions,
  UpdateCampaignOptions,
  CampaignTransition,
} from "../../types/campaign.js";
import { isValidCampaignTransition, isCampaignTerminal } from "../../types/campaign.js";

interface CampaignRow {
  id: string;
  name: string;
  description: string | null;
  status: string;
  source_type: string;
  source_config: string | null;
  budget_limit_usd: number | null;
  budget_spent_usd: number;
  total_issues: number;
  completed_issues: number;
  failed_issues: number;
  skipped_issues: number;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  tags: string | null;
}

interface CampaignIssueRow {
  id: number;
  campaign_id: string;
  issue_url: string;
  external_issue_id: string | null;
  status: string;
  priority: number;
  session_id: string | null;
  pr_url: string | null;
  cost_usd: number | null;
  added_at: string;
  started_at: string | null;
  completed_at: string | null;
  error: string | null;
  attempts: number;
}

interface CampaignTransitionRow {
  id: number;
  campaign_id: string;
  from_status: string;
  to_status: string;
  transitioned_at: string;
  triggered_by: string | null;
  reason: string | null;
}

export class CampaignService {
  constructor(private db: Database.Database) {}

  // ============ Campaign CRUD ============

  /**
   * Create a new campaign
   */
  createCampaign(options: CreateCampaignOptions): Campaign {
    const id = randomUUID();
    const now = new Date().toISOString();

    const stmt = this.db.prepare(`
      INSERT INTO campaigns (id, name, description, status, source_type, source_config,
                             budget_limit_usd, budget_spent_usd, total_issues,
                             completed_issues, failed_issues, skipped_issues,
                             created_at, tags)
      VALUES (@id, @name, @description, @status, @sourceType, @sourceConfig,
              @budgetLimitUsd, 0, 0, 0, 0, 0, @createdAt, @tags)
    `);

    stmt.run({
      id,
      name: options.name,
      description: options.description ?? null,
      status: "draft",
      sourceType: options.sourceType,
      sourceConfig: options.sourceConfig ? JSON.stringify(options.sourceConfig) : null,
      budgetLimitUsd: options.budgetLimitUsd ?? null,
      createdAt: now,
      tags: options.tags ? JSON.stringify(options.tags) : null,
    });

    logger.info(`Created campaign: ${options.name} (${id})`);

    return this.getCampaign(id)!;
  }

  /**
   * Get a campaign by ID
   */
  getCampaign(id: string): Campaign | null {
    const row = this.db.prepare("SELECT * FROM campaigns WHERE id = ?").get(id) as
      | CampaignRow
      | undefined;

    if (!row) {
      return null;
    }

    return this.rowToCampaign(row);
  }

  /**
   * Update a campaign
   */
  updateCampaign(id: string, updates: UpdateCampaignOptions): void {
    const campaign = this.getCampaign(id);
    if (!campaign) {
      throw new StateError(`Campaign not found: ${id}`);
    }

    if (isCampaignTerminal(campaign.status)) {
      throw new StateError(`Cannot update terminal campaign: ${campaign.status}`);
    }

    const sets: string[] = [];
    const params: Record<string, unknown> = { id };

    if (updates.name !== undefined) {
      sets.push("name = @name");
      params["name"] = updates.name;
    }

    if (updates.description !== undefined) {
      sets.push("description = @description");
      params["description"] = updates.description;
    }

    if (updates.budgetLimitUsd !== undefined) {
      sets.push("budget_limit_usd = @budgetLimitUsd");
      params["budgetLimitUsd"] = updates.budgetLimitUsd;
    }

    if (updates.tags !== undefined) {
      sets.push("tags = @tags");
      params["tags"] = JSON.stringify(updates.tags);
    }

    if (sets.length === 0) {
      return;
    }

    const stmt = this.db.prepare(`
      UPDATE campaigns SET ${sets.join(", ")} WHERE id = @id
    `);
    stmt.run(params);
  }

  /**
   * Delete a campaign and its issues
   */
  deleteCampaign(id: string): void {
    const campaign = this.getCampaign(id);
    if (!campaign) {
      throw new StateError(`Campaign not found: ${id}`);
    }

    if (campaign.status === "active") {
      throw new StateError("Cannot delete active campaign. Pause or cancel first.");
    }

    // Delete in order due to foreign keys
    this.db.prepare("DELETE FROM campaign_transitions WHERE campaign_id = ?").run(id);
    this.db.prepare("DELETE FROM campaign_issues WHERE campaign_id = ?").run(id);
    this.db.prepare("DELETE FROM campaigns WHERE id = ?").run(id);

    logger.info(`Deleted campaign: ${campaign.name} (${id})`);
  }

  /**
   * List campaigns with optional filters
   */
  listCampaigns(filters?: CampaignFilters): Campaign[] {
    const conditions: string[] = [];
    const params: Record<string, unknown> = {};

    if (filters?.status) {
      if (Array.isArray(filters.status)) {
        const placeholders = filters.status.map((_, i) => `@status${i}`).join(", ");
        conditions.push(`status IN (${placeholders})`);
        filters.status.forEach((s, i) => {
          params[`status${i}`] = s;
        });
      } else {
        conditions.push("status = @status");
        params["status"] = filters.status;
      }
    }

    if (filters?.sourceType) {
      conditions.push("source_type = @sourceType");
      params["sourceType"] = filters.sourceType;
    }

    if (filters?.createdAfter) {
      conditions.push("created_at >= @createdAfter");
      params["createdAfter"] = filters.createdAfter.toISOString();
    }

    if (filters?.createdBefore) {
      conditions.push("created_at <= @createdBefore");
      params["createdBefore"] = filters.createdBefore.toISOString();
    }

    if (filters?.search) {
      conditions.push("(name LIKE @search OR description LIKE @search)");
      params["search"] = `%${filters.search}%`;
    }

    // Tags filter (OR logic) - check if any tag matches
    if (filters?.tags && filters.tags.length > 0) {
      const tagConditions = filters.tags.map((_, i) => `tags LIKE @tag${i}`);
      conditions.push(`(${tagConditions.join(" OR ")})`);
      filters.tags.forEach((tag, i) => {
        params[`tag${i}`] = `%"${tag}"%`;
      });
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const rows = this.db
      .prepare(`SELECT * FROM campaigns ${whereClause} ORDER BY created_at DESC`)
      .all(params) as CampaignRow[];

    return rows.map((row) => this.rowToCampaign(row));
  }

  // ============ Campaign Status Transitions ============

  /**
   * Start a campaign
   */
  startCampaign(id: string, triggeredBy?: string): void {
    this.transitionCampaign(id, "active", triggeredBy, "Campaign started");
  }

  /**
   * Pause a campaign
   */
  pauseCampaign(id: string, triggeredBy?: string, reason?: string): void {
    this.transitionCampaign(id, "paused", triggeredBy, reason ?? "Campaign paused");
  }

  /**
   * Resume a paused campaign
   */
  resumeCampaign(id: string, triggeredBy?: string): void {
    this.transitionCampaign(id, "active", triggeredBy, "Campaign resumed");
  }

  /**
   * Complete a campaign
   */
  completeCampaign(id: string, triggeredBy?: string): void {
    this.transitionCampaign(id, "completed", triggeredBy, "Campaign completed");
  }

  /**
   * Cancel a campaign
   */
  cancelCampaign(id: string, triggeredBy?: string, reason?: string): void {
    this.transitionCampaign(id, "cancelled", triggeredBy, reason ?? "Campaign cancelled");
  }

  private transitionCampaign(
    id: string,
    toStatus: CampaignStatus,
    triggeredBy?: string,
    reason?: string
  ): void {
    const campaign = this.getCampaign(id);
    if (!campaign) {
      throw new StateError(`Campaign not found: ${id}`);
    }

    if (!isValidCampaignTransition(campaign.status, toStatus)) {
      throw new StateError(`Invalid campaign transition: ${campaign.status} -> ${toStatus}`);
    }

    const now = new Date().toISOString();

    // Update campaign status
    const updateFields: string[] = ["status = @toStatus"];
    const params: Record<string, unknown> = { id, toStatus };

    if (toStatus === "active" && !campaign.startedAt) {
      updateFields.push("started_at = @now");
      params["now"] = now;
    }

    if (toStatus === "completed" || toStatus === "cancelled") {
      updateFields.push("completed_at = @completedAt");
      params["completedAt"] = now;
    }

    this.db.prepare(`UPDATE campaigns SET ${updateFields.join(", ")} WHERE id = @id`).run(params);

    // Record transition
    this.db
      .prepare(
        `
      INSERT INTO campaign_transitions (campaign_id, from_status, to_status, transitioned_at, triggered_by, reason)
      VALUES (@campaignId, @fromStatus, @toStatus, @transitionedAt, @triggeredBy, @reason)
    `
      )
      .run({
        campaignId: id,
        fromStatus: campaign.status,
        toStatus,
        transitionedAt: now,
        triggeredBy: triggeredBy ?? null,
        reason: reason ?? null,
      });

    logger.info(`Campaign ${id} transitioned: ${campaign.status} -> ${toStatus}`);
  }

  // ============ Campaign Issue Management ============

  /**
   * Add issues to a campaign
   * @returns Number of issues added (excludes duplicates)
   */
  addIssues(
    campaignId: string,
    issues: Array<{ url: string; externalId?: string; priority?: number }>
  ): number {
    const campaign = this.getCampaign(campaignId);
    if (!campaign) {
      throw new StateError(`Campaign not found: ${campaignId}`);
    }

    if (isCampaignTerminal(campaign.status)) {
      throw new StateError(`Cannot add issues to terminal campaign: ${campaign.status}`);
    }

    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO campaign_issues (campaign_id, issue_url, external_issue_id, priority, added_at)
      VALUES (@campaignId, @issueUrl, @externalId, @priority, @addedAt)
    `);

    const now = new Date().toISOString();
    let added = 0;

    for (const issue of issues) {
      const result = stmt.run({
        campaignId,
        issueUrl: issue.url,
        externalId: issue.externalId ?? null,
        priority: issue.priority ?? 0,
        addedAt: now,
      });
      if (result.changes > 0) {
        added++;
      }
    }

    // Update total count
    this.db
      .prepare(
        `
      UPDATE campaigns SET total_issues = total_issues + @added WHERE id = @id
    `
      )
      .run({ added, id: campaignId });

    logger.info(`Added ${added} issues to campaign ${campaignId}`);
    return added;
  }

  /**
   * Remove issues from a campaign
   */
  removeIssues(campaignId: string, issueUrls: string[]): number {
    const campaign = this.getCampaign(campaignId);
    if (!campaign) {
      throw new StateError(`Campaign not found: ${campaignId}`);
    }

    if (campaign.status === "active") {
      throw new StateError("Cannot remove issues from active campaign");
    }

    let removed = 0;
    for (const url of issueUrls) {
      const result = this.db
        .prepare(
          `
        DELETE FROM campaign_issues WHERE campaign_id = @campaignId AND issue_url = @url AND status = 'pending'
      `
        )
        .run({ campaignId, url });
      removed += result.changes;
    }

    // Update total count
    this.db
      .prepare(
        `
      UPDATE campaigns SET total_issues = total_issues - @removed WHERE id = @id
    `
      )
      .run({ removed, id: campaignId });

    return removed;
  }

  /**
   * Get issues for a campaign
   */
  getIssues(campaignId: string, filters?: CampaignIssueFilters): CampaignIssue[] {
    const conditions: string[] = ["campaign_id = @campaignId"];
    const params: Record<string, unknown> = { campaignId };

    if (filters?.status) {
      if (Array.isArray(filters.status)) {
        const placeholders = filters.status.map((_, i) => `@status${i}`).join(", ");
        conditions.push(`status IN (${placeholders})`);
        filters.status.forEach((s, i) => {
          params[`status${i}`] = s;
        });
      } else {
        conditions.push("status = @status");
        params["status"] = filters.status;
      }
    }

    if (filters?.hasPr === true) {
      conditions.push("pr_url IS NOT NULL");
    } else if (filters?.hasPr === false) {
      conditions.push("pr_url IS NULL");
    }

    if (filters?.hasError === true) {
      conditions.push("error IS NOT NULL");
    } else if (filters?.hasError === false) {
      conditions.push("error IS NULL");
    }

    if (filters?.minAttempts !== undefined) {
      conditions.push("attempts >= @minAttempts");
      params["minAttempts"] = filters.minAttempts;
    }

    if (filters?.maxAttempts !== undefined) {
      conditions.push("attempts <= @maxAttempts");
      params["maxAttempts"] = filters.maxAttempts;
    }

    const rows = this.db
      .prepare(
        `SELECT * FROM campaign_issues WHERE ${conditions.join(" AND ")} ORDER BY priority ASC, added_at ASC`
      )
      .all(params) as CampaignIssueRow[];

    return rows.map((row) => this.rowToCampaignIssue(row));
  }

  /**
   * Get a single campaign issue
   */
  getCampaignIssue(campaignId: string, issueUrl: string): CampaignIssue | null {
    const row = this.db
      .prepare("SELECT * FROM campaign_issues WHERE campaign_id = ? AND issue_url = ?")
      .get(campaignId, issueUrl) as CampaignIssueRow | undefined;

    return row ? this.rowToCampaignIssue(row) : null;
  }

  /**
   * Update campaign issue status
   */
  updateIssueStatus(
    campaignId: string,
    issueUrl: string,
    status: CampaignIssueStatus,
    updates?: {
      sessionId?: string;
      prUrl?: string;
      costUsd?: number;
      error?: string;
    }
  ): void {
    const now = new Date().toISOString();
    const sets: string[] = ["status = @status"];
    const params: Record<string, unknown> = { campaignId, issueUrl, status };

    if (status === "in_progress") {
      sets.push("started_at = @startedAt");
      sets.push("attempts = attempts + 1");
      params["startedAt"] = now;
    }

    if (status === "completed" || status === "failed" || status === "skipped") {
      sets.push("completed_at = @completedAt");
      params["completedAt"] = now;
    }

    if (updates?.sessionId !== undefined) {
      sets.push("session_id = @sessionId");
      params["sessionId"] = updates.sessionId;
    }

    if (updates?.prUrl !== undefined) {
      sets.push("pr_url = @prUrl");
      params["prUrl"] = updates.prUrl;
    }

    if (updates?.costUsd !== undefined) {
      sets.push("cost_usd = COALESCE(cost_usd, 0) + @costUsd");
      params["costUsd"] = updates.costUsd;
    }

    if (updates?.error !== undefined) {
      sets.push("error = @error");
      params["error"] = updates.error;
    }

    this.db
      .prepare(
        `
      UPDATE campaign_issues SET ${sets.join(", ")}
      WHERE campaign_id = @campaignId AND issue_url = @issueUrl
    `
      )
      .run(params);

    // Update campaign counters
    this.updateCampaignCounters(campaignId);
  }

  /**
   * Get next issue to process in a campaign
   */
  getNextIssue(campaignId: string): CampaignIssue | null {
    const row = this.db
      .prepare(
        `
      SELECT * FROM campaign_issues
      WHERE campaign_id = @campaignId AND status = 'pending'
      ORDER BY priority ASC, added_at ASC
      LIMIT 1
    `
      )
      .get({ campaignId }) as CampaignIssueRow | undefined;

    return row ? this.rowToCampaignIssue(row) : null;
  }

  /**
   * Queue an issue for processing
   */
  queueIssue(campaignId: string, issueUrl: string): void {
    this.db
      .prepare(
        `
      UPDATE campaign_issues SET status = 'queued'
      WHERE campaign_id = @campaignId AND issue_url = @issueUrl AND status = 'pending'
    `
      )
      .run({ campaignId, issueUrl });
  }

  // ============ Progress & Reporting ============

  /**
   * Get campaign progress
   */
  getProgress(campaignId: string): CampaignProgress | null {
    const campaign = this.getCampaign(campaignId);
    if (!campaign) {
      return null;
    }

    // Count issues by status
    const counts = this.db
      .prepare(
        `
      SELECT status, COUNT(*) as count
      FROM campaign_issues
      WHERE campaign_id = @campaignId
      GROUP BY status
    `
      )
      .all({ campaignId }) as Array<{ status: string; count: number }>;

    const statusCounts = Object.fromEntries(counts.map((c) => [c.status, c.count]));

    const total = campaign.totalIssues;
    const completed = statusCounts["completed"] ?? 0;
    const failed = statusCounts["failed"] ?? 0;
    const skipped = statusCounts["skipped"] ?? 0;
    const inProgress = statusCounts["in_progress"] ?? 0;
    const queued = statusCounts["queued"] ?? 0;
    const pending = statusCounts["pending"] ?? 0;

    const processed = completed + failed + skipped;
    const progressPercent = total > 0 ? Math.round((processed / total) * 100) : 0;

    const result: CampaignProgress = {
      campaignId,
      name: campaign.name,
      status: campaign.status,
      total,
      pending,
      queued,
      inProgress,
      completed,
      failed,
      skipped,
      progressPercent,
      budgetSpent: campaign.budgetSpentUsd,
    };

    if (campaign.budgetLimitUsd !== undefined) {
      result.budgetLimit = campaign.budgetLimitUsd;
      result.budgetPercent = Math.round((campaign.budgetSpentUsd / campaign.budgetLimitUsd) * 100);
    }

    return result;
  }

  /**
   * Get campaign transitions
   */
  getTransitions(campaignId: string): CampaignTransition[] {
    const rows = this.db
      .prepare("SELECT * FROM campaign_transitions WHERE campaign_id = ? ORDER BY id DESC")
      .all(campaignId) as CampaignTransitionRow[];

    return rows.map((row) => {
      const transition: CampaignTransition = {
        id: row.id,
        campaignId: row.campaign_id,
        fromStatus: row.from_status as CampaignStatus,
        toStatus: row.to_status as CampaignStatus,
        transitionedAt: row.transitioned_at,
      };
      if (row.triggered_by) {
        transition.triggeredBy = row.triggered_by;
      }
      if (row.reason) {
        transition.reason = row.reason;
      }
      return transition;
    });
  }

  /**
   * Update campaign budget spent
   */
  addCost(campaignId: string, costUsd: number): void {
    this.db
      .prepare(
        `
      UPDATE campaigns SET budget_spent_usd = budget_spent_usd + @cost WHERE id = @id
    `
      )
      .run({ cost: costUsd, id: campaignId });
  }

  /**
   * Check if campaign has exceeded budget
   */
  isOverBudget(campaignId: string): boolean {
    const campaign = this.getCampaign(campaignId);
    if (!campaign?.budgetLimitUsd) {
      return false;
    }
    return campaign.budgetSpentUsd >= campaign.budgetLimitUsd;
  }

  // ============ Private Helpers ============

  private updateCampaignCounters(campaignId: string): void {
    this.db
      .prepare(
        `
      UPDATE campaigns SET
        completed_issues = (SELECT COUNT(*) FROM campaign_issues WHERE campaign_id = @id AND status = 'completed'),
        failed_issues = (SELECT COUNT(*) FROM campaign_issues WHERE campaign_id = @id AND status = 'failed'),
        skipped_issues = (SELECT COUNT(*) FROM campaign_issues WHERE campaign_id = @id AND status = 'skipped'),
        budget_spent_usd = (SELECT COALESCE(SUM(cost_usd), 0) FROM campaign_issues WHERE campaign_id = @id)
      WHERE id = @id
    `
      )
      .run({ id: campaignId });
  }

  private rowToCampaign(row: CampaignRow): Campaign {
    const campaign: Campaign = {
      id: row.id,
      name: row.name,
      status: row.status as CampaignStatus,
      sourceType: row.source_type as CampaignSourceType,
      budgetSpentUsd: row.budget_spent_usd,
      totalIssues: row.total_issues,
      completedIssues: row.completed_issues,
      failedIssues: row.failed_issues,
      skippedIssues: row.skipped_issues,
      createdAt: row.created_at,
    };

    if (row.description) {
      campaign.description = row.description;
    }
    if (row.source_config) {
      campaign.sourceConfig = JSON.parse(row.source_config);
    }
    if (row.budget_limit_usd !== null) {
      campaign.budgetLimitUsd = row.budget_limit_usd;
    }
    if (row.started_at) {
      campaign.startedAt = row.started_at;
    }
    if (row.completed_at) {
      campaign.completedAt = row.completed_at;
    }
    if (row.tags) {
      campaign.tags = JSON.parse(row.tags);
    }

    return campaign;
  }

  private rowToCampaignIssue(row: CampaignIssueRow): CampaignIssue {
    const issue: CampaignIssue = {
      id: row.id,
      campaignId: row.campaign_id,
      issueUrl: row.issue_url,
      status: row.status as CampaignIssueStatus,
      priority: row.priority,
      addedAt: row.added_at,
      attempts: row.attempts,
    };

    if (row.external_issue_id) {
      issue.externalIssueId = row.external_issue_id;
    }
    if (row.session_id) {
      issue.sessionId = row.session_id;
    }
    if (row.pr_url) {
      issue.prUrl = row.pr_url;
    }
    if (row.cost_usd !== null) {
      issue.costUsd = row.cost_usd;
    }
    if (row.started_at) {
      issue.startedAt = row.started_at;
    }
    if (row.completed_at) {
      issue.completedAt = row.completed_at;
    }
    if (row.error) {
      issue.error = row.error;
    }

    return issue;
  }
}
