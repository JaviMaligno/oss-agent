import { logger } from "../../infra/logger.js";
import { Semaphore } from "../../infra/semaphore.js";
import { Config } from "../../types/config.js";
import { StateManager, ParallelSessionIssueStatus } from "../state/state-manager.js";
import { GitOperations } from "../git/git-operations.js";
import type { WorktreeManager } from "../git/worktree-manager.js";
import { AIProvider } from "../ai/types.js";
import { IssueProcessor, ProcessIssueOptions, ProcessIssueResult } from "./issue-processor.js";
import { ConflictDetector, PreflightConflictResult } from "./conflict-detector.js";
import { ReviewService } from "./review-service.js";

export interface ParallelWorkOptions {
  /** List of issue URLs to process */
  issueUrls: string[];
  /** Maximum concurrent agents (overrides config) */
  maxConcurrent?: number;
  /** Total budget for all issues in USD */
  maxBudgetUsd?: number;
  /** Skip creating pull requests */
  skipPR?: boolean;
  /** Disable conflict detection */
  skipConflictCheck?: boolean;
  /** Progress callback */
  onProgress?: (status: ParallelStatus) => void;
  /** Resume from existing session */
  resume?: boolean;
  /** Automatically review PR after creation */
  review?: boolean;
  /** Wait for CI checks after PR creation */
  waitForCIChecks?: boolean;
  /** Auto-fix failed CI checks */
  autoFixCI?: boolean;
  /** Maximum iterations for local test fix loop */
  maxLocalFixIterations?: number;
}

export interface ParallelStatus {
  parallelSessionId: string;
  total: number;
  completed: number;
  failed: number;
  cancelled: number;
  inProgress: number;
  pending: number;
  issues: Map<string, IssueStatus>;
}

export interface IssueStatus {
  issueUrl: string;
  state: ParallelSessionIssueStatus;
  progress?: string;
  error?: string;
  prUrl?: string;
  startedAt?: Date;
  completedAt?: Date;
  costUsd: number;
}

export interface ParallelWorkResult {
  success: boolean;
  parallelSessionId: string;
  results: Array<{
    issueUrl: string;
    result?: ProcessIssueResult;
    error?: string;
  }>;
  summary: {
    total: number;
    successful: number;
    failed: number;
    cancelled: number;
    totalCostUsd: number;
    totalDurationMs: number;
  };
}

/**
 * ParallelOrchestrator - Coordinates parallel issue processing
 *
 * Uses:
 * - Semaphore for concurrency control
 * - Promise.allSettled for parallel execution
 * - StateManager for tracking parallel sessions
 * - WorktreeManager for resource limits
 */
export class ParallelOrchestrator {
  private cancelled = new Set<string>();
  private cancelAll = false;
  private currentStatus: ParallelStatus | null = null;
  private conflictDetector: ConflictDetector;
  private reviewService: ReviewService;

  constructor(
    private config: Config,
    private stateManager: StateManager,
    private gitOps: GitOperations,
    _worktreeManager: WorktreeManager,
    private aiProvider: AIProvider
  ) {
    // WorktreeManager passed for future use (conflict detection, cleanup)
    void _worktreeManager;
    // Initialize conflict detector
    this.conflictDetector = new ConflictDetector(stateManager);
    // Initialize review service for automated PR review
    this.reviewService = new ReviewService(config, stateManager, gitOps, aiProvider);
  }

  /**
   * Process multiple issues in parallel
   */
  async processIssues(options: ParallelWorkOptions): Promise<ParallelWorkResult> {
    const startTime = Date.now();
    const maxConcurrent = options.maxConcurrent ?? this.config.parallel.maxConcurrentAgents;

    logger.header(`Parallel Work: ${options.issueUrls.length} issues, ${maxConcurrent} concurrent`);

    // Validate issue URLs
    for (const url of options.issueUrls) {
      if (!url.includes("github.com") || !url.includes("/issues/")) {
        throw new Error(`Invalid issue URL: ${url}`);
      }
    }

    // Create parallel session in DB
    const parallelSession = this.stateManager.createParallelSession({
      issueUrls: options.issueUrls,
      maxConcurrent,
    });

    // Initialize status tracking
    this.currentStatus = {
      parallelSessionId: parallelSession.id,
      total: options.issueUrls.length,
      completed: 0,
      failed: 0,
      cancelled: 0,
      inProgress: 0,
      pending: options.issueUrls.length,
      issues: new Map(),
    };

    // Initialize issue statuses
    for (const url of options.issueUrls) {
      this.currentStatus.issues.set(url, {
        issueUrl: url,
        state: "pending",
        costUsd: 0,
      });
    }

    // Notify initial status
    options.onProgress?.(this.currentStatus);

    // Run conflict detection if enabled
    let conflictResult: PreflightConflictResult | null = null;
    if (!options.skipConflictCheck && this.config.parallel.enableConflictDetection) {
      logger.info("Running pre-flight conflict detection...");

      // Fetch issue data for conflict analysis
      const issuesForAnalysis = await this.fetchIssuesForConflictAnalysis(options.issueUrls);
      conflictResult = this.conflictDetector.detectPreflightConflicts(issuesForAnalysis);

      if (conflictResult.hasConflicts) {
        logger.warn(
          `Pre-flight conflict detection found ${conflictResult.conflictingIssues.length} potential conflicts`
        );
        for (const conflict of conflictResult.conflictingIssues) {
          logger.warn(`  Issue ${conflict.issueUrl} may conflict with:`);
          for (const overlap of conflict.overlapWith) {
            logger.warn(`    - ${overlap.issueUrl} (shared: ${overlap.sharedFiles.join(", ")})`);
          }
        }
        // Note: We continue processing but warn about conflicts
        // In the future, we could skip conflicting issues or process them sequentially
      } else {
        logger.info("No conflicts detected, proceeding with parallel processing");
      }
    }

    // Create semaphore for concurrency control
    const semaphore = new Semaphore(maxConcurrent);

    // Process all issues in parallel (controlled by semaphore)
    const promises = options.issueUrls.map((url) =>
      this.processWithSemaphore(url, parallelSession.id, semaphore, options)
    );

    const results = await Promise.allSettled(promises);

    // Build result summary
    const processedResults: ParallelWorkResult["results"] = [];
    let successful = 0;
    let failed = 0;
    let cancelled = 0;
    let totalCostUsd = 0;

    for (let i = 0; i < results.length; i++) {
      const settledResult = results[i];
      const url = options.issueUrls[i];

      if (!settledResult || !url) {
        continue;
      }

      if (settledResult.status === "fulfilled") {
        const value = settledResult.value;
        if (value.cancelled) {
          cancelled++;
          processedResults.push({ issueUrl: url, error: "Cancelled" });
        } else if (value.result?.success) {
          successful++;
          totalCostUsd += value.result.metrics.costUsd;
          processedResults.push({ issueUrl: url, result: value.result });
        } else {
          failed++;
          const errorMsg = value.result?.error ?? value.error ?? "Unknown error";
          const failedEntry: { issueUrl: string; result?: ProcessIssueResult; error?: string } = {
            issueUrl: url,
            error: errorMsg,
          };
          if (value.result) {
            failedEntry.result = value.result;
          }
          processedResults.push(failedEntry);
        }
      } else {
        failed++;
        const reason = settledResult.reason as Error | undefined;
        processedResults.push({ issueUrl: url, error: reason?.message ?? "Unknown error" });
      }
    }

    const totalDurationMs = Date.now() - startTime;

    // Update parallel session
    const finalStatus = failed > 0 || cancelled > 0 ? "completed" : "completed";
    this.stateManager.updateParallelSession(parallelSession.id, {
      status: finalStatus,
      completedIssues: successful,
      failedIssues: failed,
      cancelledIssues: cancelled,
      totalCostUsd,
      totalDurationMs,
    });

    logger.header("Parallel Work Complete");
    logger.info(`Successful: ${successful}, Failed: ${failed}, Cancelled: ${cancelled}`);
    logger.info(`Total cost: $${totalCostUsd.toFixed(4)}`);
    logger.info(`Total duration: ${(totalDurationMs / 1000).toFixed(1)}s`);

    return {
      success: failed === 0 && cancelled === 0,
      parallelSessionId: parallelSession.id,
      results: processedResults,
      summary: {
        total: options.issueUrls.length,
        successful,
        failed,
        cancelled,
        totalCostUsd,
        totalDurationMs,
      },
    };
  }

  /**
   * Cancel a specific issue
   */
  cancel(issueUrl: string): void {
    this.cancelled.add(issueUrl);
    logger.info(`Cancellation requested for: ${issueUrl}`);
  }

  /**
   * Cancel all in-progress work
   */
  cancelAllWork(): void {
    this.cancelAll = true;
    logger.info("Cancellation requested for all issues");
  }

  /**
   * Get current status
   */
  getStatus(): ParallelStatus | null {
    return this.currentStatus;
  }

  /**
   * Process a single issue with semaphore control
   */
  private async processWithSemaphore(
    issueUrl: string,
    parallelSessionId: string,
    semaphore: Semaphore,
    options: ParallelWorkOptions
  ): Promise<{ result?: ProcessIssueResult; error?: string; cancelled?: boolean }> {
    // Check cancellation before acquiring semaphore
    if (this.cancelAll || this.cancelled.has(issueUrl)) {
      this.updateIssueStatus(issueUrl, parallelSessionId, "cancelled");
      return { cancelled: true };
    }

    // Wait for a slot
    await semaphore.acquire();

    try {
      // Check cancellation again after acquiring
      if (this.cancelAll || this.cancelled.has(issueUrl)) {
        this.updateIssueStatus(issueUrl, parallelSessionId, "cancelled");
        return { cancelled: true };
      }

      // Mark as in progress
      this.updateIssueStatus(issueUrl, parallelSessionId, "in_progress");

      // Create a fresh IssueProcessor for this issue
      const processor = new IssueProcessor(
        this.config,
        this.stateManager,
        this.gitOps,
        this.aiProvider,
        this.config.hardening,
        this.reviewService
      );

      const processOptions: ProcessIssueOptions = {
        issueUrl,
      };

      if (options.skipPR === true) {
        processOptions.skipPR = true;
      }

      if (options.maxBudgetUsd !== undefined) {
        // Distribute budget across issues
        processOptions.maxBudgetUsd = options.maxBudgetUsd / options.issueUrls.length;
      }

      if (options.resume === true) {
        processOptions.resume = true;
      }

      if (options.review === true) {
        processOptions.review = true;
      }

      if (options.waitForCIChecks !== undefined) {
        processOptions.waitForCIChecks = options.waitForCIChecks;
      }

      if (options.autoFixCI !== undefined) {
        processOptions.autoFixCI = options.autoFixCI;
      }

      if (options.maxLocalFixIterations !== undefined) {
        processOptions.maxLocalFixIterations = options.maxLocalFixIterations;
      }

      const result = await processor.processIssue(processOptions);

      // Update status based on result
      if (result.success) {
        const extra: { costUsd: number; sessionId: string; prUrl?: string } = {
          costUsd: result.metrics.costUsd,
          sessionId: result.session.id,
        };
        if (result.prUrl) {
          extra.prUrl = result.prUrl;
        }
        this.updateIssueStatus(issueUrl, parallelSessionId, "completed", extra);
      } else {
        const extra: { costUsd: number; sessionId: string; error?: string } = {
          costUsd: result.metrics.costUsd,
          sessionId: result.session.id,
        };
        if (result.error) {
          extra.error = result.error;
        }
        this.updateIssueStatus(issueUrl, parallelSessionId, "failed", extra);
      }

      return { result };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.updateIssueStatus(issueUrl, parallelSessionId, "failed", { error: errorMessage });
      return { error: errorMessage };
    } finally {
      semaphore.release();
    }
  }

  /**
   * Update issue status in both memory and DB
   */
  private updateIssueStatus(
    issueUrl: string,
    parallelSessionId: string,
    status: ParallelSessionIssueStatus,
    extra?: { error?: string; costUsd?: number; prUrl?: string; sessionId?: string }
  ): void {
    // Update in-memory status
    if (this.currentStatus) {
      const issueStatus = this.currentStatus.issues.get(issueUrl);
      if (issueStatus) {
        const oldState = issueStatus.state;
        issueStatus.state = status;

        if (status === "in_progress") {
          issueStatus.startedAt = new Date();
          this.currentStatus.pending--;
          this.currentStatus.inProgress++;
        } else if (status === "completed") {
          issueStatus.completedAt = new Date();
          if (oldState === "in_progress") {
            this.currentStatus.inProgress--;
          }
          this.currentStatus.completed++;
        } else if (status === "failed") {
          issueStatus.completedAt = new Date();
          if (oldState === "in_progress") {
            this.currentStatus.inProgress--;
          }
          this.currentStatus.failed++;
        } else if (status === "cancelled") {
          if (oldState === "pending") {
            this.currentStatus.pending--;
          } else if (oldState === "in_progress") {
            this.currentStatus.inProgress--;
          }
          this.currentStatus.cancelled++;
        }

        if (extra?.error) issueStatus.error = extra.error;
        if (extra?.costUsd !== undefined) issueStatus.costUsd = extra.costUsd;
        if (extra?.prUrl) issueStatus.prUrl = extra.prUrl;
      }
    }

    // Update DB
    const dbUpdates: Partial<{
      issueId: string;
      sessionId: string;
      status: ParallelSessionIssueStatus;
      costUsd: number;
      error: string;
    }> = {
      status,
    };
    if (extra?.error !== undefined) dbUpdates.error = extra.error;
    if (extra?.costUsd !== undefined) dbUpdates.costUsd = extra.costUsd;
    if (extra?.sessionId !== undefined) dbUpdates.sessionId = extra.sessionId;

    this.stateManager.updateParallelSessionIssue(parallelSessionId, issueUrl, dbUpdates);
  }

  /**
   * Fetch issue data for conflict analysis
   */
  private async fetchIssuesForConflictAnalysis(
    issueUrls: string[]
  ): Promise<Array<{ url: string; title: string; body: string }>> {
    const issues: Array<{ url: string; title: string; body: string }> = [];

    for (const url of issueUrls) {
      try {
        // Check if we already have the issue in state
        const existing = this.stateManager.getIssueByUrl(url);
        if (existing) {
          issues.push({
            url: existing.url,
            title: existing.title,
            body: existing.body,
          });
          continue;
        }

        // Fetch from GitHub using gh CLI
        const parsed = this.parseIssueUrl(url);
        if (!parsed) continue;

        const { execSync } = await import("node:child_process");
        const result = execSync(
          `gh issue view ${parsed.number} --repo ${parsed.owner}/${parsed.repo} --json title,body`,
          { encoding: "utf-8" }
        );
        const data = JSON.parse(result) as { title: string; body: string };
        issues.push({
          url,
          title: data.title,
          body: data.body,
        });
      } catch (error) {
        logger.debug(`Failed to fetch issue for conflict analysis: ${url} - ${error}`);
        // Add a placeholder to avoid skipping the issue entirely
        issues.push({ url, title: "", body: "" });
      }
    }

    return issues;
  }

  /**
   * Parse issue URL to extract components
   */
  private parseIssueUrl(url: string): { owner: string; repo: string; number: number } | null {
    const match = url.match(/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/);
    if (!match?.[1] || !match?.[2] || !match?.[3]) return null;
    return {
      owner: match[1],
      repo: match[2],
      number: parseInt(match[3], 10),
    };
  }
}
