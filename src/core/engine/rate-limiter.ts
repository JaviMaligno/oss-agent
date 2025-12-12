import { StateManager } from "../state/state-manager.js";
import { QualityGates } from "../../types/config.js";
import { logger } from "../../infra/logger.js";

/**
 * Status returned when checking if a PR can be created
 */
export interface RateLimitStatus {
  /** Whether creating a PR is allowed */
  allowed: boolean;
  /** Reason if not allowed */
  reason?: string;
  /** Current PR counts */
  counts: {
    /** Total PRs created today */
    dailyPRs: number;
    /** PRs created per project today */
    projectPRs: Record<string, number>;
  };
  /** Configured limits */
  limits: {
    maxPrsPerDay: number;
    maxPrsPerProjectPerDay: number;
  };
  /** When the next PR can be created (if rate limited) */
  nextAvailableAt?: Date;
}

/**
 * RateLimiter - Enforces PR creation rate limits
 *
 * Prevents creating too many PRs per day (globally and per project)
 * to avoid being perceived as spam and to respect project maintainers.
 */
export class RateLimiter {
  constructor(
    private stateManager: StateManager,
    private qualityGates: QualityGates
  ) {}

  /**
   * Check if we can create a new PR for a given project
   */
  canCreatePR(projectId: string): RateLimitStatus {
    const counts = this.stateManager.getTodaysPRCounts();
    const projectCount = counts.byProject[projectId] ?? 0;

    const status: RateLimitStatus = {
      allowed: true,
      counts: {
        dailyPRs: counts.daily,
        projectPRs: counts.byProject,
      },
      limits: {
        maxPrsPerDay: this.qualityGates.maxPrsPerDay,
        maxPrsPerProjectPerDay: this.qualityGates.maxPrsPerProjectPerDay,
      },
    };

    // Check daily limit
    if (counts.daily >= this.qualityGates.maxPrsPerDay) {
      status.allowed = false;
      status.reason = `Daily PR limit reached (${counts.daily}/${this.qualityGates.maxPrsPerDay})`;
      status.nextAvailableAt = this.getStartOfTomorrow();
      logger.debug(
        `Rate limit: daily limit reached (${counts.daily}/${this.qualityGates.maxPrsPerDay})`
      );
      return status;
    }

    // Check per-project limit
    if (projectCount >= this.qualityGates.maxPrsPerProjectPerDay) {
      status.allowed = false;
      status.reason = `Project PR limit reached for ${projectId} (${projectCount}/${this.qualityGates.maxPrsPerProjectPerDay})`;
      status.nextAvailableAt = this.getStartOfTomorrow();
      logger.debug(
        `Rate limit: project limit reached for ${projectId} (${projectCount}/${this.qualityGates.maxPrsPerProjectPerDay})`
      );
      return status;
    }

    logger.debug(
      `Rate limit check passed: daily=${counts.daily}/${this.qualityGates.maxPrsPerDay}, ` +
        `project=${projectCount}/${this.qualityGates.maxPrsPerProjectPerDay}`
    );

    return status;
  }

  /**
   * Get current PR counts for today
   */
  getTodaysPRCounts(): { daily: number; byProject: Record<string, number> } {
    return this.stateManager.getTodaysPRCounts();
  }

  /**
   * Check remaining capacity before hitting limits
   */
  getRemainingCapacity(projectId?: string): {
    dailyRemaining: number;
    projectRemaining: number | null;
  } {
    const counts = this.stateManager.getTodaysPRCounts();
    const dailyRemaining = Math.max(0, this.qualityGates.maxPrsPerDay - counts.daily);

    let projectRemaining: number | null = null;
    if (projectId) {
      const projectCount = counts.byProject[projectId] ?? 0;
      projectRemaining = Math.max(0, this.qualityGates.maxPrsPerProjectPerDay - projectCount);
    }

    return { dailyRemaining, projectRemaining };
  }

  /**
   * Get a summary of rate limit status for display
   */
  getStatusSummary(): string {
    const counts = this.stateManager.getTodaysPRCounts();
    const lines: string[] = [`Daily PRs: ${counts.daily}/${this.qualityGates.maxPrsPerDay}`];

    if (Object.keys(counts.byProject).length > 0) {
      lines.push("By project:");
      for (const [project, count] of Object.entries(counts.byProject)) {
        lines.push(`  ${project}: ${count}/${this.qualityGates.maxPrsPerProjectPerDay}`);
      }
    }

    return lines.join("\n");
  }

  /**
   * Get the start of tomorrow (midnight)
   */
  private getStartOfTomorrow(): Date {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);
    return tomorrow;
  }
}
