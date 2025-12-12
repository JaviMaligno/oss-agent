import { StateManager } from "../state/state-manager.js";
import { DiscoveryService } from "../../oss/discovery/discovery-service.js";
import { SelectionService } from "../../oss/selection/selection-service.js";
import { Config, QueueConfig } from "../../types/config.js";
import { Issue } from "../../types/issue.js";
import { RateLimiter } from "./rate-limiter.js";
import { ConflictDetector } from "./conflict-detector.js";
import { logger } from "../../infra/logger.js";

/**
 * Queue status information
 */
export interface QueueStatus {
  /** Current number of issues in queue */
  size: number;
  /** Whether replenishment is needed */
  needsReplenishment: boolean;
  /** Configured thresholds */
  thresholds: {
    minQueueSize: number;
    targetQueueSize: number;
  };
}

/**
 * Result of queue replenishment
 */
export interface ReplenishmentResult {
  /** Number of issues added to queue */
  added: number;
  /** Breakdown by source */
  sources: Array<{ source: string; count: number }>;
  /** Any errors encountered */
  errors: string[];
}

/**
 * Options for getting next issues from queue
 */
export interface GetNextIssuesOptions {
  /** Rate limiter to check limits */
  rateLimiter?: RateLimiter;
  /** Conflict detector to check conflicts */
  conflictDetector?: ConflictDetector;
  /** Skip conflict detection */
  skipConflictCheck?: boolean;
}

/**
 * QueueManager - Manages the issue queue for autonomous processing
 *
 * Handles queue status monitoring, automatic replenishment using
 * discovery and selection services, and fetching next issues while
 * respecting rate limits and conflict detection.
 */
export class QueueManager {
  private queueConfig: QueueConfig;

  constructor(
    private stateManager: StateManager,
    private discoveryService: DiscoveryService,
    private selectionService: SelectionService,
    private config: Config
  ) {
    this.queueConfig = config.oss?.queue ?? {
      minQueueSize: 5,
      targetQueueSize: 20,
      autoReplenish: true,
    };
  }

  /**
   * Get current queue status
   */
  getQueueStatus(): QueueStatus {
    const queuedIssues = this.stateManager.getIssuesByState("queued");

    return {
      size: queuedIssues.length,
      needsReplenishment: queuedIssues.length < this.queueConfig.minQueueSize,
      thresholds: {
        minQueueSize: this.queueConfig.minQueueSize,
        targetQueueSize: this.queueConfig.targetQueueSize,
      },
    };
  }

  /**
   * Check if replenishment is needed
   */
  needsReplenishment(): boolean {
    const queuedIssues = this.stateManager.getIssuesByState("queued");
    return queuedIssues.length < this.queueConfig.minQueueSize;
  }

  /**
   * Get all queued issues
   */
  getQueuedIssues(): Issue[] {
    return this.stateManager.getIssuesByState("queued");
  }

  /**
   * Replenish the queue from configured discovery sources
   */
  async replenish(customConfig?: Partial<QueueConfig>): Promise<ReplenishmentResult> {
    const effectiveConfig = { ...this.queueConfig, ...customConfig };
    const result: ReplenishmentResult = {
      added: 0,
      sources: [],
      errors: [],
    };

    const currentQueueSize = this.stateManager.getIssuesByState("queued").length;
    const targetToAdd = effectiveConfig.targetQueueSize - currentQueueSize;

    if (targetToAdd <= 0) {
      logger.debug("Queue is at or above target size, no replenishment needed");
      return result;
    }

    logger.info(
      `Replenishing queue: need ${targetToAdd} issues to reach target of ${effectiveConfig.targetQueueSize}`
    );

    try {
      // Get configured repos for direct discovery
      const directRepos = this.config.oss?.directRepos ?? [];

      if (directRepos.length === 0) {
        // Try search-based discovery
        const discovered = await this.discoveryService.discover({
          mode: "search",
          language: "typescript", // Default, could be made configurable
          minStars: this.config.oss?.minStars ?? 100,
          maxStars: this.config.oss?.maxStars ?? 50000,
        });

        let addedFromSearch = 0;
        for (const project of discovered.slice(0, 10)) {
          if (result.added >= targetToAdd) break;

          const issues = await this.selectionService.findIssues(project, {
            filterLabels: this.config.oss?.filterLabels,
            excludeLabels: this.config.oss?.excludeLabels,
            requireNoExistingPR: this.config.oss?.requireNoExistingPR ?? true,
            limit: Math.min(5, targetToAdd - result.added),
          });

          for (const issue of issues) {
            if (result.added >= targetToAdd) break;

            if (this.tryAddToQueue(issue)) {
              result.added++;
              addedFromSearch++;
            }
          }
        }

        if (addedFromSearch > 0) {
          result.sources.push({ source: "search", count: addedFromSearch });
        }
      } else {
        // Use direct repos - need to get project info first
        let addedFromDirect = 0;
        for (const repo of directRepos) {
          if (result.added >= targetToAdd) break;

          try {
            // Get project info for the repo
            const project = await this.discoveryService.getProjectInfo(repo);
            if (!project) {
              logger.warn(`Could not get project info for ${repo}`);
              continue;
            }

            const issues = await this.selectionService.findIssues(project, {
              filterLabels: this.config.oss?.filterLabels,
              excludeLabels: this.config.oss?.excludeLabels,
              requireNoExistingPR: this.config.oss?.requireNoExistingPR ?? true,
              limit: Math.min(5, targetToAdd - result.added),
            });

            for (const issue of issues) {
              if (result.added >= targetToAdd) break;

              if (this.tryAddToQueue(issue)) {
                result.added++;
                addedFromDirect++;
              }
            }
          } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            result.errors.push(`Failed to fetch issues from ${repo}: ${errorMsg}`);
            logger.warn(`Failed to fetch issues from ${repo}: ${errorMsg}`);
          }
        }

        if (addedFromDirect > 0) {
          result.sources.push({ source: "direct", count: addedFromDirect });
        }
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      result.errors.push(`Discovery failed: ${errorMsg}`);
      logger.error(`Queue replenishment failed: ${errorMsg}`);
    }

    logger.info(`Queue replenishment complete: added ${result.added} issues`);
    return result;
  }

  /**
   * Get next issues from queue, respecting rate limits and conflicts
   */
  async getNextIssues(count: number, options: GetNextIssuesOptions = {}): Promise<Issue[]> {
    const queuedIssues = this.stateManager.getIssuesByState("queued");
    const selectedIssues: Issue[] = [];

    for (const issue of queuedIssues) {
      if (selectedIssues.length >= count) break;

      // Check rate limits if provided
      if (options.rateLimiter) {
        const rateLimitStatus = options.rateLimiter.canCreatePR(issue.projectId);
        if (!rateLimitStatus.allowed) {
          logger.debug(`Skipping issue ${issue.url}: rate limited - ${rateLimitStatus.reason}`);
          continue;
        }
      }

      // Check conflicts if provided and not skipped
      if (options.conflictDetector && !options.skipConflictCheck) {
        const conflictCheck = options.conflictDetector.checkAgainstInProgress({
          url: issue.url,
          title: issue.title,
          body: issue.body,
        });
        if (!conflictCheck.safe) {
          logger.debug(
            `Skipping issue ${issue.url}: conflicts with ${conflictCheck.conflicts.join(", ")}`
          );
          continue;
        }
      }

      selectedIssues.push(issue);
    }

    return selectedIssues;
  }

  /**
   * Get the next single issue from queue
   */
  async getNextIssue(options: GetNextIssuesOptions = {}): Promise<Issue | null> {
    const issues = await this.getNextIssues(1, options);
    return issues[0] ?? null;
  }

  /**
   * Try to add an issue to the queue (if not already in any state)
   */
  private tryAddToQueue(issueData: {
    url: string;
    number: number;
    title: string;
    body: string;
    labels: string[];
    author: string;
    createdAt: Date;
    updatedAt: Date;
  }): boolean {
    // Check if issue already exists in any state
    const existing = this.stateManager.getIssueByUrl(issueData.url);
    if (existing) {
      logger.debug(`Issue already exists in state '${existing.state}': ${issueData.url}`);
      return false;
    }

    // Parse project ID from URL
    const match = issueData.url.match(/github\.com\/([^/]+\/[^/]+)\/issues\/\d+/);
    if (!match?.[1]) {
      logger.warn(`Could not parse project ID from URL: ${issueData.url}`);
      return false;
    }
    const projectId = match[1];

    // Create issue in queued state
    const issue: Issue = {
      id: `issue-${projectId.replace("/", "-")}-${issueData.number}`,
      url: issueData.url,
      number: issueData.number,
      title: issueData.title,
      body: issueData.body,
      labels: issueData.labels,
      state: "queued",
      author: issueData.author,
      assignee: null,
      createdAt: issueData.createdAt,
      updatedAt: issueData.updatedAt,
      projectId,
      hasLinkedPR: false,
      linkedPRUrl: null,
    };

    this.stateManager.saveIssue(issue);
    logger.debug(`Added issue to queue: ${issueData.url}`);
    return true;
  }

  /**
   * Remove an issue from the queue (mark as abandoned)
   */
  removeFromQueue(issueUrl: string): boolean {
    const issue = this.stateManager.getIssueByUrl(issueUrl);
    if (!issue) {
      logger.warn(`Issue not found: ${issueUrl}`);
      return false;
    }

    if (issue.state !== "queued") {
      logger.warn(`Issue is not in queue (state: ${issue.state}): ${issueUrl}`);
      return false;
    }

    this.stateManager.transitionIssue(issue.id, "abandoned", "Removed from queue");
    return true;
  }

  /**
   * Move an issue to the front of the queue (by updating its timestamp)
   */
  prioritizeIssue(issueUrl: string): boolean {
    const issue = this.stateManager.getIssueByUrl(issueUrl);
    if (!issue) {
      logger.warn(`Issue not found: ${issueUrl}`);
      return false;
    }

    if (issue.state !== "queued") {
      logger.warn(`Issue is not in queue (state: ${issue.state}): ${issueUrl}`);
      return false;
    }

    // Update the issue to bump its timestamp
    issue.updatedAt = new Date();
    this.stateManager.saveIssue(issue);
    logger.info(`Prioritized issue: ${issueUrl}`);
    return true;
  }

  /**
   * Clear all queued issues
   */
  clearQueue(options?: { reason?: string }): number {
    const queuedIssues = this.stateManager.getIssuesByState("queued");
    const reason = options?.reason ?? "Queue cleared";

    for (const issue of queuedIssues) {
      this.stateManager.transitionIssue(issue.id, "abandoned", reason);
    }

    logger.info(`Cleared ${queuedIssues.length} issues from queue`);
    return queuedIssues.length;
  }
}
