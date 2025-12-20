/**
 * CI Check Handler - Orchestrates waiting for CI checks and auto-fixing failures
 *
 * This handler provides a complete workflow for:
 * 1. Waiting for CI checks to complete after PR creation
 * 2. Detecting failures and extracting error logs
 * 3. Invoking AI to fix the issues
 * 4. Committing and pushing fixes
 * 5. Repeating until success or max iterations
 */

import { logger } from "../../infra/logger.js";
import { PRCheck } from "../../types/pr.js";
import { AIProvider, QueryResult } from "../ai/types.js";
import { GitOperations } from "../git/git-operations.js";
import { PRService } from "../github/pr-service.js";
import { CICheckPoller, CIPollerResult } from "../github/ci-poller.js";

export interface CIHandlerOptions {
  /** Maximum number of fix attempts */
  maxIterations: number;
  /** Whether to wait for checks to complete */
  waitForChecks: boolean;
  /** Whether to auto-fix failed checks */
  autoFix: boolean;
  /** Timeout for each polling cycle (ms) */
  timeoutMs: number;
  /** Interval between polls (ms) */
  pollIntervalMs: number;
  /** Initial delay before first poll (ms) - allows GitHub Actions to register */
  initialDelayMs?: number | undefined;
  /** Maximum budget for AI fix operations (USD) */
  maxBudgetPerFix?: number | undefined;
  /** Remote to push fixes to (default: origin) - use "fork" for fork-based workflows */
  pushRemote?: string | undefined;
  /** Session ID from initial work to resume for CI fixes */
  resumeSessionId?: string | undefined;
  /** Maximum turns for AI fix operations (default: 50) */
  maxTurnsPerFix?: number | undefined;
  /** Callback for progress updates */
  onProgress?: (status: CIHandlerProgress) => void;
}

export interface CIHandlerProgress {
  phase: "waiting" | "analyzing" | "fixing" | "pushing" | "complete";
  iteration: number;
  maxIterations: number;
  message: string;
  checksStatus?: {
    total: number;
    passed: number;
    failed: number;
    pending: number;
  };
}

export interface CIIteration {
  /** Attempt number (1-based) */
  attempt: number;
  /** Result of the CI check polling */
  checkResult: CIPollerResult;
  /** Whether a fix was applied in this iteration */
  fixApplied: boolean;
  /** Commit SHA of the fix (if applied) */
  fixCommit?: string | undefined;
  /** Summary of what was fixed */
  fixSummary?: string | undefined;
  /** Duration of this iteration (ms) */
  durationMs: number;
}

export interface CIHandlerResult {
  /** Final status of the CI handling */
  finalStatus: "success" | "failure" | "timeout" | "max_iterations" | "no_checks" | "skipped";
  /** All iterations performed */
  iterations: CIIteration[];
  /** Total duration of CI handling (ms) */
  totalDuration: number;
  /** Final list of checks */
  finalChecks: PRCheck[];
  /** Summary of what happened */
  summary: string;
}

interface CheckFailureLog {
  checkName: string;
  status: string;
  conclusion: string | null;
  summary: string | null;
  log: string | null;
  errors: string[];
}

export class CICheckHandler {
  private poller: CICheckPoller;

  constructor(
    private prService: PRService,
    private gitOps: GitOperations,
    private aiProvider: AIProvider
  ) {
    this.poller = new CICheckPoller(prService);
  }

  /**
   * Handle CI checks for a PR - wait, detect failures, and optionally auto-fix
   */
  async handleChecks(
    owner: string,
    repo: string,
    prNumber: number,
    worktreePath: string,
    branchName: string,
    options: CIHandlerOptions
  ): Promise<CIHandlerResult> {
    const startTime = Date.now();
    const iterations: CIIteration[] = [];

    // Skip if not waiting for checks
    if (!options.waitForChecks) {
      logger.info("CI check waiting disabled, skipping");
      return {
        finalStatus: "skipped",
        iterations: [],
        totalDuration: 0,
        finalChecks: [],
        summary: "CI check waiting was disabled",
      };
    }

    logger.info(`Starting CI check handling for ${owner}/${repo}#${prNumber}`);
    logger.info(`Max iterations: ${options.maxIterations}, Auto-fix: ${options.autoFix}`);

    for (let attempt = 1; attempt <= options.maxIterations; attempt++) {
      const iterationStart = Date.now();

      logger.info(`\n=== CI Check Iteration ${attempt}/${options.maxIterations} ===`);

      // Report progress
      this.reportProgress(options.onProgress, {
        phase: "waiting",
        iteration: attempt,
        maxIterations: options.maxIterations,
        message: "Waiting for CI checks to complete...",
      });

      // 1. Wait for checks to complete
      const checkResult = await this.poller.waitForChecks(owner, repo, prNumber, {
        timeoutMs: options.timeoutMs,
        pollIntervalMs: options.pollIntervalMs,
        initialDelayMs: options.initialDelayMs,
        onProgress: (p) => {
          this.reportProgress(options.onProgress, {
            phase: "waiting",
            iteration: attempt,
            maxIterations: options.maxIterations,
            message: `Waiting for CI: ${p.completedChecks}/${p.totalChecks} completed`,
            checksStatus: {
              total: p.totalChecks,
              passed: p.passedChecks,
              failed: p.failedChecks,
              pending: p.pendingChecks,
            },
          });
        },
      });

      // 2. No checks configured
      if (checkResult.status === "no_checks") {
        logger.info("No CI checks configured for this repository");
        return {
          finalStatus: "no_checks",
          iterations: [],
          totalDuration: Date.now() - startTime,
          finalChecks: [],
          summary: "No CI checks are configured for this repository",
        };
      }

      // 3. All checks passed
      if (checkResult.status === "success") {
        logger.success("All CI checks passed!");
        iterations.push({
          attempt,
          checkResult,
          fixApplied: false,
          durationMs: Date.now() - iterationStart,
        });
        return {
          finalStatus: "success",
          iterations,
          totalDuration: Date.now() - startTime,
          finalChecks: checkResult.checks,
          summary: `All ${checkResult.checks.length} CI checks passed`,
        };
      }

      // 4. Timeout
      if (checkResult.status === "timeout") {
        logger.warn("CI checks timed out");
        iterations.push({
          attempt,
          checkResult,
          fixApplied: false,
          durationMs: Date.now() - iterationStart,
        });
        return {
          finalStatus: "timeout",
          iterations,
          totalDuration: Date.now() - startTime,
          finalChecks: checkResult.checks,
          summary: `CI checks timed out after ${options.timeoutMs}ms`,
        };
      }

      // 5. Checks failed - attempt to fix if enabled
      if (checkResult.status === "failure") {
        const failedNames = checkResult.failedChecks.map((c) => c.name).join(", ");
        logger.warn(`${checkResult.failedChecks.length} CI check(s) failed: ${failedNames}`);

        if (!options.autoFix) {
          logger.info("Auto-fix disabled, not attempting to fix");
          iterations.push({
            attempt,
            checkResult,
            fixApplied: false,
            durationMs: Date.now() - iterationStart,
          });
          return {
            finalStatus: "failure",
            iterations,
            totalDuration: Date.now() - startTime,
            finalChecks: checkResult.checks,
            summary: `CI checks failed: ${failedNames}. Auto-fix is disabled.`,
          };
        }

        // Attempt to fix
        this.reportProgress(options.onProgress, {
          phase: "analyzing",
          iteration: attempt,
          maxIterations: options.maxIterations,
          message: "Analyzing CI failures...",
        });

        const fixOptions: {
          maxBudgetUsd?: number;
          pushRemote?: string;
          resumeSessionId?: string;
          maxTurns?: number;
        } = {
          maxTurns: options.maxTurnsPerFix ?? 50,
        };
        if (options.maxBudgetPerFix !== undefined) {
          fixOptions.maxBudgetUsd = options.maxBudgetPerFix;
        }
        if (options.pushRemote !== undefined) {
          fixOptions.pushRemote = options.pushRemote;
        }
        if (options.resumeSessionId !== undefined) {
          fixOptions.resumeSessionId = options.resumeSessionId;
        }

        const fixResult = await this.attemptFix(
          owner,
          repo,
          worktreePath,
          branchName,
          checkResult.failedChecks,
          fixOptions
        );

        if (fixResult.success) {
          logger.success(`Fix applied and pushed: ${fixResult.summary}`);
          iterations.push({
            attempt,
            checkResult,
            fixApplied: true,
            fixCommit: fixResult.commitSha,
            fixSummary: fixResult.summary,
            durationMs: Date.now() - iterationStart,
          });
          // Continue to next iteration to verify fix
          continue;
        } else {
          logger.warn(`Failed to fix CI issues: ${fixResult.error}`);

          // Re-poll to check if CI has passed on its own (handles transient failures like DCO)
          logger.info("Re-checking CI status in case checks have passed...");
          const recheckResult = await this.poller.waitForChecks(owner, repo, prNumber, {
            timeoutMs: 30000, // Short timeout for recheck
            pollIntervalMs: 5000,
            initialDelayMs: 5000,
          });

          if (recheckResult.status === "success") {
            logger.success("CI checks now passing after recheck!");
            iterations.push({
              attempt,
              checkResult: recheckResult,
              fixApplied: false,
              durationMs: Date.now() - iterationStart,
            });
            return {
              finalStatus: "success",
              iterations,
              totalDuration: Date.now() - startTime,
              finalChecks: recheckResult.checks,
              summary: `All ${recheckResult.checks.length} CI checks passed (after recheck)`,
            };
          }

          iterations.push({
            attempt,
            checkResult,
            fixApplied: false,
            durationMs: Date.now() - iterationStart,
          });
          return {
            finalStatus: "failure",
            iterations,
            totalDuration: Date.now() - startTime,
            finalChecks: recheckResult.checks,
            summary: `CI checks failed and could not be fixed: ${fixResult.error}`,
          };
        }
      }
    }

    // Max iterations reached
    logger.warn(`Max iterations (${options.maxIterations}) reached`);
    const lastCheckResult = iterations[iterations.length - 1]?.checkResult;
    return {
      finalStatus: "max_iterations",
      iterations,
      totalDuration: Date.now() - startTime,
      finalChecks: lastCheckResult?.checks ?? [],
      summary: `Maximum fix iterations (${options.maxIterations}) reached without success`,
    };
  }

  /**
   * Attempt to fix failed CI checks using AI
   */
  private async attemptFix(
    owner: string,
    repo: string,
    worktreePath: string,
    branchName: string,
    failedChecks: PRCheck[],
    options: {
      maxBudgetUsd?: number;
      pushRemote?: string;
      resumeSessionId?: string;
      maxTurns?: number;
    }
  ): Promise<{
    success: boolean;
    summary?: string;
    commitSha?: string;
    error?: string;
  }> {
    try {
      // 1. Get failure logs
      logger.info("Fetching CI failure logs...");
      const failureLogs = await this.getCheckLogs(owner, repo, failedChecks);

      // 2. Build prompt for AI
      const prompt = this.buildFixPrompt(failedChecks, failureLogs);

      // 3. Invoke AI to fix (resume previous session if available)
      if (options.resumeSessionId) {
        logger.info("Resuming previous session to fix CI failures...");
      } else {
        logger.info("Invoking AI to fix CI failures...");
      }
      const queryResult: QueryResult = await this.aiProvider.query(prompt, {
        cwd: worktreePath,
        maxTurns: options.maxTurns ?? 50,
        ...(options.maxBudgetUsd !== undefined && { maxBudgetUsd: options.maxBudgetUsd }),
        ...(options.resumeSessionId !== undefined && { resumeSessionId: options.resumeSessionId }),
      });

      if (!queryResult.success) {
        return {
          success: false,
          error: queryResult.error ?? "AI query failed",
        };
      }

      // 4. Check if changes were made
      const hasChanges = await this.gitOps.hasUncommittedChanges(worktreePath);
      if (!hasChanges) {
        return {
          success: false,
          error: "AI did not make any changes",
        };
      }

      // 5. Commit and push
      const summary = this.extractFixSummary(queryResult.output);
      const commitMessage = `fix: address CI failures\n\n${summary}\n\n🤖 Auto-fixed by CI handler`;

      await this.gitOps.commit(worktreePath, commitMessage);

      // Push with retry - use fork remote for fork-based workflows
      const remote = options.pushRemote ?? "origin";
      try {
        await this.gitOps.push(worktreePath, branchName, { remote });
      } catch {
        logger.warn("Push failed, retrying with --no-verify...");
        await this.gitOps.push(worktreePath, branchName, { remote, skipVerification: true });
      }

      const commitSha = await this.gitOps.getHeadSha(worktreePath);

      return {
        success: true,
        summary,
        commitSha,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Get logs for failed checks
   */
  private async getCheckLogs(
    owner: string,
    repo: string,
    failedChecks: PRCheck[]
  ): Promise<CheckFailureLog[]> {
    const logs: CheckFailureLog[] = [];

    for (const check of failedChecks) {
      let log: string | null = null;

      // Try to get logs via API
      try {
        log = await this.prService.getCheckLogs(owner, repo, check.id);
      } catch {
        // Logs may not be available
      }

      // Extract errors from log if available
      const errors = log ? this.parseErrorsFromLog(log) : [];

      logs.push({
        checkName: check.name,
        status: check.status,
        conclusion: check.conclusion,
        summary: check.outputSummary,
        log: log ? this.truncateLog(log, 10000) : null,
        errors,
      });
    }

    return logs;
  }

  /**
   * Parse common error patterns from CI logs
   */
  private parseErrorsFromLog(log: string): string[] {
    const patterns = [
      /error\[.*?\]:.*$/gim, // Rust errors
      /Error:.*$/gim, // Generic errors
      /FAIL\s+.*$/gim, // Test failures
      /✗.*$/gim, // Test failures (vitest/jest)
      /×.*$/gim, // Test failures (vitest)
      /AssertionError:.*$/gim, // Assertion failures
      /TypeError:.*$/gim, // Type errors
      /SyntaxError:.*$/gim, // Syntax errors
      /ReferenceError:.*$/gim, // Reference errors
      /expected.*to.*$/gim, // Assertion messages
      /^\s+✕.*$/gim, // Jest failures
      /^FAILED:.*$/gim, // Generic failures
    ];

    const errors: string[] = [];
    const seen = new Set<string>();

    for (const pattern of patterns) {
      const matches = log.match(pattern);
      if (matches) {
        for (const match of matches) {
          const cleaned = match.trim();
          if (!seen.has(cleaned) && cleaned.length > 10) {
            seen.add(cleaned);
            errors.push(cleaned);
          }
        }
      }
    }

    // Limit to most relevant errors
    return errors.slice(0, 20);
  }

  /**
   * Truncate log to max length, keeping the end (most relevant errors)
   */
  private truncateLog(log: string, maxLength: number): string {
    if (log.length <= maxLength) {
      return log;
    }
    return "...[truncated]...\n" + log.slice(-maxLength);
  }

  /**
   * Build prompt for AI to fix CI failures
   */
  private buildFixPrompt(_failedChecks: PRCheck[], failureLogs: CheckFailureLog[]): string {
    let prompt = `## CI Checks Failed - Fix Required

The following CI checks have failed and need to be fixed:

`;

    for (const log of failureLogs) {
      prompt += `### ${log.checkName}
**Status:** ${log.status} (${log.conclusion ?? "no conclusion"})

`;

      if (log.summary) {
        prompt += `**Summary:**
${log.summary}

`;
      }

      if (log.errors.length > 0) {
        prompt += `**Errors Found:**
\`\`\`
${log.errors.join("\n")}
\`\`\`

`;
      }

      if (log.log) {
        prompt += `**Log Output:**
\`\`\`
${log.log}
\`\`\`

`;
      }
    }

    prompt += `## Your Task

1. Analyze the CI failures above
2. Identify the root cause of each failure
3. Make the necessary code changes to fix the failures
4. Focus on fixing the actual errors, not suppressing them

Common issues to look for:
- Test failures: Fix the tests or the code being tested
- Lint errors: Fix code style issues
- Type errors: Fix TypeScript types
- Build errors: Fix compilation issues

After making changes, provide a brief summary of what you fixed.

IMPORTANT: Only make changes that directly address the CI failures. Do not make unrelated improvements.
`;

    return prompt;
  }

  /**
   * Extract fix summary from AI output
   */
  private extractFixSummary(output: string): string {
    // Look for common summary patterns
    const patterns = [
      /(?:summary|fixed|changes made|what i did):\s*([^\n]+(?:\n- [^\n]+)*)/i,
      /I (?:have )?(?:fixed|addressed|resolved)[^.]*\./gi,
    ];

    for (const pattern of patterns) {
      const match = output.match(pattern);
      if (match) {
        return match[1] ?? match[0] ?? "Fixed CI failures";
      }
    }

    // Fallback: extract last paragraph
    const paragraphs = output.split(/\n\n+/);
    const lastParagraph = paragraphs[paragraphs.length - 1];
    if (lastParagraph && lastParagraph.length < 500) {
      return lastParagraph.trim();
    }

    return "Fixed CI failures";
  }

  /**
   * Report progress to callback
   */
  private reportProgress(
    callback: ((status: CIHandlerProgress) => void) | undefined,
    status: CIHandlerProgress
  ): void {
    if (callback) {
      callback(status);
    }
  }
}
