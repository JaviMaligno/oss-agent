import { EventEmitter } from "node:events";
import { StateManager } from "../state/state-manager.js";
import { QueueManager } from "./queue-manager.js";
import { RateLimiter } from "./rate-limiter.js";
import { BudgetManager } from "./budget-manager.js";
import { ConflictDetector } from "./conflict-detector.js";
import { IssueProcessor } from "./issue-processor.js";
import { Config } from "../../types/config.js";
import { Issue } from "../../types/issue.js";
import { logger } from "../../infra/logger.js";

/**
 * Configuration for autonomous running
 */
export interface AutonomousConfig {
  /** Maximum issues to process (undefined = unlimited) */
  maxIterations?: number;
  /** Maximum hours to run */
  maxDurationHours?: number;
  /** Maximum budget in USD */
  maxBudgetUsd?: number;
  /** Cooldown between issues in milliseconds */
  cooldownMs?: number;
  /** Enable automatic queue replenishment */
  autoReplenish?: boolean;
  /** Dry run mode - don't actually process, just show what would be done */
  dryRun?: boolean;
}

/**
 * Current status of autonomous runner
 */
export interface AutonomousStatus {
  /** Current state */
  state: "running" | "paused" | "stopping" | "stopped";
  /** Current iteration number */
  iteration: number;
  /** When the run started */
  startedAt: Date;
  /** Processing statistics */
  processed: {
    success: number;
    failed: number;
    skipped: number;
  };
  /** Total cost so far */
  totalCostUsd: number;
  /** Current issue being processed */
  currentIssue?: string;
  /** Current queue size */
  queueSize: number;
}

/**
 * Result of an autonomous run
 */
export interface AutonomousResult {
  /** Total iterations completed */
  iterations: number;
  /** Total duration in milliseconds */
  durationMs: number;
  /** Processed issues with details */
  processed: Array<{
    issueUrl: string;
    success: boolean;
    prUrl?: string;
    error?: string;
  }>;
  /** Total cost */
  totalCostUsd: number;
  /** Reason for stopping */
  stopReason:
    | "completed"
    | "max_iterations"
    | "max_duration"
    | "max_budget"
    | "budget_exceeded"
    | "manual_stop"
    | "error"
    | "empty_queue"
    | "rate_limited";
}

/**
 * Events emitted by the autonomous runner
 */
export interface AutonomousRunnerEvents {
  "issue:start": (issueUrl: string) => void;
  "issue:complete": (issueUrl: string, prUrl: string) => void;
  "issue:failed": (issueUrl: string, error: string) => void;
  "issue:skipped": (issueUrl: string, reason: string) => void;
  "status:changed": (status: AutonomousStatus) => void;
  "queue:replenished": (added: number) => void;
}

/**
 * AutonomousRunner - Processes issues from queue automatically
 *
 * Handles the autonomous mode loop:
 * - Gets issues from queue
 * - Processes them respecting rate limits and conflicts
 * - Replenishes queue when needed
 * - Stops on various conditions (max iterations, duration, budget, etc.)
 */
export class AutonomousRunner extends EventEmitter {
  private status: AutonomousStatus;
  private shouldStop = false;
  private isPaused = false;
  private config: AutonomousConfig;
  private budgetManager: BudgetManager;

  constructor(
    private appConfig: Config,
    private stateManager: StateManager,
    private queueManager: QueueManager,
    private rateLimiter: RateLimiter,
    private conflictDetector: ConflictDetector,
    private issueProcessor: IssueProcessor
  ) {
    super();
    this.config = {};
    this.status = this.createInitialStatus();
    this.budgetManager = new BudgetManager(stateManager, appConfig.budget);
  }

  /**
   * Start autonomous processing
   */
  async run(config: AutonomousConfig = {}): Promise<AutonomousResult> {
    this.config = {
      cooldownMs: 5000,
      autoReplenish: true,
      ...config,
    };

    this.shouldStop = false;
    this.isPaused = false;
    this.status = this.createInitialStatus();
    this.status.state = "running";

    const result: AutonomousResult = {
      iterations: 0,
      durationMs: 0,
      processed: [],
      totalCostUsd: 0,
      stopReason: "completed",
    };

    logger.info("Starting autonomous mode");
    this.emitStatusChanged();

    try {
      while (!this.shouldStop) {
        // Check pause state
        if (this.isPaused) {
          await this.sleep(1000);
          continue;
        }

        // Check limits
        const limitCheck = this.checkLimits(result);
        if (limitCheck) {
          result.stopReason = limitCheck;
          break;
        }

        // Check rate limits globally
        const globalRateCheck = this.rateLimiter.getTodaysPRCounts();
        if (globalRateCheck.daily >= (this.appConfig.oss?.qualityGates?.maxPrsPerDay ?? 10)) {
          logger.info("Daily rate limit reached, stopping");
          result.stopReason = "rate_limited";
          break;
        }

        // Check daily/monthly budget limits
        const budgetCheck = this.budgetManager.canProceed();
        if (!budgetCheck.allowed) {
          logger.info(`Budget limit exceeded: ${budgetCheck.reason}`);
          result.stopReason = "budget_exceeded";
          break;
        }

        // Check queue and replenish if needed
        if (this.queueManager.needsReplenishment() && this.config.autoReplenish) {
          logger.info("Queue low, replenishing...");
          const replenishResult = await this.queueManager.replenish();
          this.emit("queue:replenished", replenishResult.added);

          if (replenishResult.added === 0 && this.queueManager.getQueueStatus().size === 0) {
            logger.info("Queue empty and replenishment found no issues");
            result.stopReason = "empty_queue";
            break;
          }
        }

        // Get next issue
        const issue = await this.queueManager.getNextIssue({
          rateLimiter: this.rateLimiter,
          conflictDetector: this.conflictDetector,
        });

        if (!issue) {
          // No suitable issue found
          if (this.queueManager.getQueueStatus().size === 0) {
            result.stopReason = "empty_queue";
            break;
          }
          // All issues are rate limited or have conflicts, wait and retry
          logger.debug("No suitable issue found, waiting...");
          await this.sleep(30000);
          continue;
        }

        // Update status
        this.status.currentIssue = issue.url;
        this.status.iteration++;
        this.emitStatusChanged();
        this.emit("issue:start", issue.url);

        // Process the issue
        if (this.config.dryRun) {
          logger.info(`[DRY RUN] Would process: ${issue.url}`);
          result.processed.push({ issueUrl: issue.url, success: true });
          this.status.processed.success++;
          // In dry-run mode, mark issue as abandoned to avoid picking it again
          this.stateManager.transitionIssue(
            issue.id,
            "abandoned",
            "Dry run - simulated processing"
          );
        } else {
          const processResult = await this.processIssue(issue);
          result.processed.push(processResult);

          if (processResult.success) {
            this.status.processed.success++;
            this.emit("issue:complete", issue.url, processResult.prUrl ?? "");
          } else {
            this.status.processed.failed++;
            this.emit("issue:failed", issue.url, processResult.error ?? "Unknown error");
          }
        }

        // Update metrics
        result.iterations++;
        result.durationMs = Date.now() - this.status.startedAt.getTime();
        this.status.queueSize = this.queueManager.getQueueStatus().size;
        delete this.status.currentIssue;
        this.emitStatusChanged();

        // Cooldown between issues
        if (this.config.cooldownMs && this.config.cooldownMs > 0 && !this.shouldStop) {
          logger.debug(`Cooling down for ${this.config.cooldownMs}ms`);
          await this.sleep(this.config.cooldownMs);
        }
      }
    } catch (error) {
      logger.error(`Autonomous run error: ${error}`);
      result.stopReason = "error";
    }

    // Finalize
    this.status.state = "stopped";
    result.durationMs = Date.now() - this.status.startedAt.getTime();
    result.totalCostUsd = this.status.totalCostUsd;
    this.emitStatusChanged();

    logger.info(
      `Autonomous mode finished: ${result.iterations} iterations, ` +
        `${this.status.processed.success} success, ${this.status.processed.failed} failed, ` +
        `reason: ${result.stopReason}`
    );

    return result;
  }

  /**
   * Request graceful stop (finishes current issue)
   */
  requestStop(): void {
    logger.info("Stop requested, finishing current issue...");
    this.shouldStop = true;
    this.status.state = "stopping";
    this.emitStatusChanged();
  }

  /**
   * Get current status
   */
  getStatus(): AutonomousStatus {
    return { ...this.status };
  }

  /**
   * Pause processing
   */
  pause(): void {
    if (this.status.state === "running") {
      this.isPaused = true;
      this.status.state = "paused";
      this.emitStatusChanged();
      logger.info("Autonomous mode paused");
    }
  }

  /**
   * Resume from pause
   */
  resume(): void {
    if (this.status.state === "paused") {
      this.isPaused = false;
      this.status.state = "running";
      this.emitStatusChanged();
      logger.info("Autonomous mode resumed");
    }
  }

  /**
   * Process a single issue
   */
  private async processIssue(
    issue: Issue
  ): Promise<{ issueUrl: string; success: boolean; prUrl?: string; error?: string }> {
    try {
      const result = await this.issueProcessor.processIssue({ issueUrl: issue.url });

      // Update cost tracking
      if (result.metrics?.costUsd) {
        this.status.totalCostUsd += result.metrics.costUsd;
      }

      const returnValue: { issueUrl: string; success: boolean; prUrl?: string; error?: string } = {
        issueUrl: issue.url,
        success: result.success,
      };
      if (result.prUrl) {
        returnValue.prUrl = result.prUrl;
      }
      if (result.error) {
        returnValue.error = result.error;
      }
      return returnValue;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error(`Failed to process issue ${issue.url}: ${errorMsg}`);

      return {
        issueUrl: issue.url,
        success: false,
        error: errorMsg,
      };
    }
  }

  /**
   * Check if any limits have been reached
   */
  private checkLimits(result: AutonomousResult): AutonomousResult["stopReason"] | null {
    // Max iterations
    if (this.config.maxIterations && result.iterations >= this.config.maxIterations) {
      logger.info(`Max iterations reached (${this.config.maxIterations})`);
      return "max_iterations";
    }

    // Max duration
    if (this.config.maxDurationHours) {
      const durationHours = (Date.now() - this.status.startedAt.getTime()) / (1000 * 60 * 60);
      if (durationHours >= this.config.maxDurationHours) {
        logger.info(`Max duration reached (${this.config.maxDurationHours}h)`);
        return "max_duration";
      }
    }

    // Max budget
    if (this.config.maxBudgetUsd && this.status.totalCostUsd >= this.config.maxBudgetUsd) {
      logger.info(`Max budget reached ($${this.config.maxBudgetUsd})`);
      return "max_budget";
    }

    return null;
  }

  /**
   * Create initial status object
   */
  private createInitialStatus(): AutonomousStatus {
    return {
      state: "stopped",
      iteration: 0,
      startedAt: new Date(),
      processed: { success: 0, failed: 0, skipped: 0 },
      totalCostUsd: 0,
      queueSize: 0,
    };
  }

  /**
   * Emit status changed event
   */
  private emitStatusChanged(): void {
    this.emit("status:changed", this.getStatus());
  }

  /**
   * Sleep for specified milliseconds
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
