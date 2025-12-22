/**
 * CI Check Poller - Polls GitHub for CI check status until completion
 */

import { logger } from "../../infra/logger.js";
import { PRCheck } from "../../types/pr.js";
import { PRService } from "./pr-service.js";

export interface CIPollerOptions {
  /** Maximum time to wait for checks to complete (ms) */
  timeoutMs: number;
  /** Interval between polls (ms) */
  pollIntervalMs: number;
  /** Initial delay before first poll (ms) - allows GitHub Actions to register */
  initialDelayMs?: number | undefined;
  /** Specific checks to wait for (optional, waits for all if not specified) */
  requiredChecks?: string[];
  /** Callback for progress updates */
  onProgress?: (status: CIPollerProgress) => void;
}

export interface CIPollerProgress {
  /** Time elapsed since polling started (ms) */
  elapsedMs: number;
  /** Total checks being monitored */
  totalChecks: number;
  /** Checks that have completed */
  completedChecks: number;
  /** Checks still pending */
  pendingChecks: number;
  /** Checks that have passed */
  passedChecks: number;
  /** Checks that have failed */
  failedChecks: number;
  /** Names of pending checks */
  pendingCheckNames: string[];
}

export interface CIPollerResult {
  /** Final status of the polling operation */
  status: "success" | "failure" | "timeout" | "no_checks";
  /** All checks that were monitored */
  checks: PRCheck[];
  /** Checks that failed */
  failedChecks: PRCheck[];
  /** Checks that passed */
  passedChecks: PRCheck[];
  /** Total duration of polling (ms) */
  duration: number;
  /** Number of poll iterations */
  pollCount: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class CICheckPoller {
  constructor(private prService: PRService) {}

  /**
   * Wait for CI checks to complete on a PR
   */
  async waitForChecks(
    owner: string,
    repo: string,
    prNumber: number,
    options: CIPollerOptions
  ): Promise<CIPollerResult> {
    const startTime = Date.now();
    let pollCount = 0;

    logger.info(`Waiting for CI checks on ${owner}/${repo}#${prNumber}...`);

    // Initial delay to allow GitHub Actions to register after PR creation
    if (options.initialDelayMs && options.initialDelayMs > 0) {
      logger.info(`Waiting ${options.initialDelayMs / 1000}s for CI checks to register...`);
      await sleep(options.initialDelayMs);
    }

    while (Date.now() - startTime < options.timeoutMs) {
      pollCount++;
      const elapsedMs = Date.now() - startTime;

      try {
        const checks = await this.prService.getChecks(owner, repo, prNumber);

        // If no checks configured, return immediately
        if (checks.length === 0) {
          logger.info("No CI checks configured for this repository");
          return {
            status: "no_checks",
            checks: [],
            failedChecks: [],
            passedChecks: [],
            duration: elapsedMs,
            pollCount,
          };
        }

        // Filter to required checks if specified
        const relevantChecks = options.requiredChecks
          ? checks.filter((c) => options.requiredChecks!.includes(c.name))
          : checks;

        // Categorize checks
        // Note: "skipped" and "cancelled" are treated as passed - they don't require fixes
        const pendingChecks = relevantChecks.filter((c) => c.status === "pending");
        const failedChecks = relevantChecks.filter((c) => c.status === "failure");
        const passedChecks = relevantChecks.filter(
          (c) => c.status === "success" || c.status === "skipped" || c.status === "cancelled"
        );
        const completedChecks = relevantChecks.filter((c) => c.status !== "pending");

        // Report progress
        if (options.onProgress) {
          options.onProgress({
            elapsedMs,
            totalChecks: relevantChecks.length,
            completedChecks: completedChecks.length,
            pendingChecks: pendingChecks.length,
            passedChecks: passedChecks.length,
            failedChecks: failedChecks.length,
            pendingCheckNames: pendingChecks.map((c) => c.name),
          });
        }

        // Log progress
        logger.debug(
          `CI status: ${completedChecks.length}/${relevantChecks.length} completed, ` +
            `${passedChecks.length} passed, ${failedChecks.length} failed, ` +
            `${pendingChecks.length} pending`
        );

        // All checks completed?
        if (pendingChecks.length === 0) {
          const finalStatus = failedChecks.length > 0 ? "failure" : "success";

          logger.info(
            `CI checks completed: ${finalStatus} (${passedChecks.length} passed, ${failedChecks.length} failed)`
          );

          return {
            status: finalStatus,
            checks: relevantChecks,
            failedChecks,
            passedChecks,
            duration: Date.now() - startTime,
            pollCount,
          };
        }

        // Still pending, wait before next poll
        logger.info(
          `Waiting for ${pendingChecks.length} check(s): ${pendingChecks.map((c) => c.name).join(", ")}`
        );
        await sleep(options.pollIntervalMs);
      } catch (error) {
        logger.warn(`Error polling CI status: ${error}`);
        // Continue polling despite errors
        await sleep(options.pollIntervalMs);
      }
    }

    // Timeout reached
    logger.warn(`CI check polling timed out after ${options.timeoutMs}ms (${pollCount} polls)`);

    // Get final state for the result
    const finalChecks = await this.prService.getChecks(owner, repo, prNumber);
    const relevantChecks = options.requiredChecks
      ? finalChecks.filter((c) => options.requiredChecks!.includes(c.name))
      : finalChecks;

    return {
      status: "timeout",
      checks: relevantChecks,
      failedChecks: relevantChecks.filter((c) => c.status === "failure"),
      passedChecks: relevantChecks.filter(
        (c) => c.status === "success" || c.status === "skipped" || c.status === "cancelled"
      ),
      duration: Date.now() - startTime,
      pollCount,
    };
  }

  /**
   * Check if a repository has CI checks configured
   * This is a heuristic check based on recent PR history
   */
  async hasConfiguredChecks(owner: string, repo: string, prNumber: number): Promise<boolean> {
    try {
      const checks = await this.prService.getChecks(owner, repo, prNumber);
      return checks.length > 0;
    } catch {
      // If we can't fetch checks, assume there are none
      return false;
    }
  }
}
