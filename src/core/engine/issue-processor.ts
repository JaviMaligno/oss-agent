import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { logger } from "../../infra/logger.js";
import { withRepoLock } from "../../infra/repo-lock.js";
import { registerWorktreeCleanup } from "../../infra/cleanup-manager.js";
import { HealthChecker, HealthCheckResult } from "../../infra/health-check.js";
import { StateManager } from "../state/state-manager.js";
import { GitOperations, CloneResult } from "../git/git-operations.js";
import { AIProvider, QueryResult } from "../ai/types.js";
import { RepoService } from "../github/repo-service.js";
import { RateLimiter } from "./rate-limiter.js";
import { BudgetManager } from "./budget-manager.js";
import { ReviewService } from "./review-service.js";
import { CICheckHandler, CIHandlerResult } from "./ci-handler.js";
import { PRService } from "../github/pr-service.js";
import { Issue, IssueWorkRecord } from "../../types/issue.js";
import { Session } from "../../types/session.js";
import { Config, HardeningConfig } from "../../types/config.js";

/** Default timeout for test/lint commands in milliseconds (5 minutes) */
const COMMAND_TIMEOUT_MS = 5 * 60 * 1000;

/** Default timeout for GitHub CLI commands in milliseconds (2 minutes) */
const GH_COMMAND_TIMEOUT_MS = 2 * 60 * 1000;

/** Default maximum iterations for local test fix loop */
const DEFAULT_MAX_LOCAL_FIX_ITERATIONS = 3;

export interface ProcessIssueOptions {
  /** URL of the GitHub issue */
  issueUrl: string;
  /** Maximum budget for this issue in USD */
  maxBudgetUsd?: number;
  /** Resume from existing session */
  resume?: boolean;
  /** Skip creating PR (for testing) */
  skipPR?: boolean;
  /** Skip rate limit check */
  skipRateLimitCheck?: boolean;
  /** Skip budget check */
  skipBudgetCheck?: boolean;
  /** Automatically review PR after creation */
  review?: boolean;
  /** Wait for CI checks after PR creation */
  waitForCIChecks?: boolean | undefined;
  /** Auto-fix failed CI checks */
  autoFixCI?: boolean | undefined;
}

export interface ProcessIssueResult {
  success: boolean;
  issue: Issue;
  session: Session;
  prUrl?: string;
  error?: string;
  ciResult?: CIHandlerResult;
  metrics: {
    turns: number;
    durationMs: number;
    costUsd: number;
    filesChanged: number;
    linesChanged: number;
  };
}

/**
 * IssueProcessor - Orchestrates the complete issue processing workflow
 *
 * Flow:
 * 1. Parse issue URL and fetch issue data
 * 2. Clone/setup repository
 * 3. Create branch for work
 * 4. Invoke AI to analyze and implement solution
 * 5. Validate changes (tests, lint)
 * 6. Create PR (if enabled)
 * 7. Update state
 */
export class IssueProcessor {
  private repoService: RepoService;
  private rateLimiter: RateLimiter | null = null;
  private budgetManager: BudgetManager;
  private healthChecker: HealthChecker | null = null;

  constructor(
    private config: Config,
    private stateManager: StateManager,
    private gitOps: GitOperations,
    private aiProvider: AIProvider,
    hardeningConfig?: HardeningConfig,
    private reviewService?: ReviewService
  ) {
    this.repoService = new RepoService(hardeningConfig);
    // Initialize rate limiter if quality gates are configured
    if (config.oss?.qualityGates) {
      this.rateLimiter = new RateLimiter(stateManager, config.oss.qualityGates);
    }
    // Initialize budget manager
    this.budgetManager = new BudgetManager(stateManager, config.budget);
    // Initialize health checker if hardening config provided
    if (hardeningConfig?.healthCheck) {
      this.healthChecker = new HealthChecker({
        intervalMs: hardeningConfig.healthCheck.intervalMs,
        diskWarningThresholdGb: hardeningConfig.healthCheck.diskWarningThresholdGb,
        diskCriticalThresholdGb: hardeningConfig.healthCheck.diskCriticalThresholdGb,
        memoryWarningThresholdMb: hardeningConfig.healthCheck.memoryWarningThresholdMb,
        onWarning: (result) => this.onHealthWarning(result),
        onCritical: (result) => this.onHealthCritical(result),
      });
      this.healthChecker.setAIProvider(aiProvider);
    }
  }

  /**
   * Get max iterations for local test fix loop from config
   */
  private get maxLocalTestFixIterations(): number {
    return (
      this.config.oss?.qualityGates?.maxLocalTestFixIterations ?? DEFAULT_MAX_LOCAL_FIX_ITERATIONS
    );
  }

  /**
   * Handle health warning
   */
  private onHealthWarning(result: HealthCheckResult): void {
    logger.warn("Health warning detected", {
      diskSpace: result.checks.diskSpace,
      memory: result.checks.memory,
    });
  }

  /**
   * Handle health critical
   */
  private onHealthCritical(result: HealthCheckResult): void {
    logger.error("Critical health issue detected", {
      diskSpace: result.checks.diskSpace,
      memory: result.checks.memory,
    });
  }

  /**
   * Process a single issue end-to-end
   */
  async processIssue(options: ProcessIssueOptions): Promise<ProcessIssueResult> {
    const startTime = Date.now();
    logger.header(`Processing Issue: ${options.issueUrl}`);

    // Parse issue URL to extract owner/repo/number
    const parsed = this.parseIssueUrl(options.issueUrl);
    if (!parsed) {
      throw new Error(`Invalid issue URL: ${options.issueUrl}`);
    }

    const { owner, repo, issueNumber } = parsed;
    const issueId = `${owner}/${repo}#${issueNumber}`;
    const projectId = `${owner}/${repo}`;

    // Check rate limits before processing
    if (this.rateLimiter && !options.skipRateLimitCheck) {
      const rateLimitStatus = this.rateLimiter.canCreatePR(projectId);
      if (!rateLimitStatus.allowed) {
        logger.warn(`Rate limit exceeded: ${rateLimitStatus.reason}`);
        throw new Error(`Rate limit exceeded: ${rateLimitStatus.reason}`);
      }
      logger.debug(
        `Rate limit check passed: daily=${rateLimitStatus.counts.dailyPRs}/${rateLimitStatus.limits.maxPrsPerDay}, ` +
          `project=${rateLimitStatus.counts.projectPRs[projectId] ?? 0}/${rateLimitStatus.limits.maxPrsPerProjectPerDay}`
      );
    }

    // Check budget limits before processing
    if (!options.skipBudgetCheck) {
      const budgetCheck = this.budgetManager.canProceed();
      if (!budgetCheck.allowed) {
        logger.warn(`Budget limit exceeded: ${budgetCheck.reason}`);
        throw new Error(`Budget limit exceeded: ${budgetCheck.reason}`);
      }
      logger.debug(
        `Budget check passed: daily=$${budgetCheck.dailySpent.toFixed(2)}/$${budgetCheck.dailyLimit}, ` +
          `monthly=$${budgetCheck.monthlySpent.toFixed(2)}/$${budgetCheck.monthlyLimit}`
      );
    }

    // Check if we have an existing issue record
    let issue = this.stateManager.getIssueByUrl(options.issueUrl);
    let session: Session | null = null;

    if (options.resume && issue) {
      session = this.stateManager.getLatestSessionForIssue(issue.id);
      if (session?.canResume) {
        logger.info(`Resuming session ${session.id} for issue ${issueId}`);
      } else {
        session = null;
      }
    }

    // Fetch issue data from GitHub
    const issueData = await this.fetchIssueData(owner, repo, issueNumber);

    // Create or update issue record
    if (!issue) {
      issue = {
        id: issueId,
        url: options.issueUrl,
        number: issueNumber,
        title: issueData.title,
        body: issueData.body,
        labels: issueData.labels,
        state: "discovered",
        author: issueData.author,
        assignee: issueData.assignee,
        createdAt: new Date(issueData.createdAt),
        updatedAt: new Date(issueData.updatedAt),
        projectId: `${owner}/${repo}`,
        hasLinkedPR: false,
        linkedPRUrl: null,
      };
      this.stateManager.saveIssue(issue);
      this.stateManager.transitionIssue(issue.id, "queued", "Issue discovered and queued");
      issue.state = "queued";
    }

    // Check permissions and setup repository (with fork if needed)
    // These operations need to be serialized per-repository to avoid git lock conflicts
    logger.step(1, 6, "Setting up repository...");
    const cloneResult = await this.setupRepository(owner, repo);

    const { path: repoPath, defaultBranch, pushRemote, pushOwner, isFork } = cloneResult;

    if (isFork) {
      logger.info(`Using fork workflow - will push to ${pushOwner}'s fork`);
    }

    // Create branch and worktree with repo lock to prevent race conditions
    // when multiple parallel processes work on the same repository
    const { branchName, worktreePath } = await withRepoLock(repoPath, async () => {
      // Create branch for this issue
      logger.step(2, 6, "Creating branch...");
      const { name: branchName } = await this.gitOps.createBranch(
        repoPath,
        issueNumber,
        issueData.title,
        defaultBranch,
        { owner, repo } // For checking open PRs during auto-clean
      );

      // Create worktree for isolated work
      logger.step(3, 6, "Setting up worktree...");
      const worktreePath = await this.gitOps.createWorktree(repoPath, branchName, issue.id);

      // Register worktree cleanup for graceful shutdown
      registerWorktreeCleanup(repoPath, worktreePath);

      return { branchName, worktreePath };
    });

    // Create session if not resuming
    session ??= this.stateManager.createSession({
      issueId: issue.id,
      issueUrl: options.issueUrl,
      status: "active",
      provider: this.aiProvider.name,
      model: this.config.ai.model,
      startedAt: new Date(),
      lastActivityAt: new Date(),
      completedAt: null,
      turnCount: 0,
      costUsd: 0,
      prUrl: null,
      workingDirectory: worktreePath,
      canResume: true,
      error: null,
    });

    // Transition issue to in_progress
    if (issue.state === "queued") {
      this.stateManager.transitionIssue(
        issue.id,
        "in_progress",
        "Starting AI analysis",
        session.id
      );
      issue.state = "in_progress";
    }

    // Build the prompt for the AI
    const prompt = this.buildPrompt(issueData, owner, repo, branchName);

    // Check health before AI query (if health checker is configured)
    if (this.healthChecker) {
      const healthResult = await this.healthChecker.check();
      if (healthResult.overallStatus === "critical") {
        const criticalMsg = `Health check critical before AI query: disk=${healthResult.checks.diskSpace.availableGb}GB, memory=${healthResult.checks.memory.availableMb}MB`;
        logger.error(criticalMsg);
        this.stateManager.transitionSession(session.id, "failed", criticalMsg);
        this.stateManager.transitionIssue(issue.id, "abandoned", criticalMsg, session.id);
        return {
          success: false,
          issue,
          session: this.stateManager.getSession(session.id)!,
          error: criticalMsg,
          metrics: {
            turns: 0,
            durationMs: Date.now() - startTime,
            costUsd: 0,
            filesChanged: 0,
            linesChanged: 0,
          },
        };
      }
    }

    // Execute AI query
    logger.step(4, 6, "Invoking AI to analyze and implement solution...");
    let queryResult: QueryResult;

    try {
      // Use effective budget that respects daily/monthly limits
      const effectiveBudget =
        options.maxBudgetUsd ?? this.budgetManager.getEffectivePerIssueBudget();
      queryResult = await this.aiProvider.query(prompt, {
        cwd: worktreePath,
        model: this.config.ai.model,
        maxTurns: this.config.ai.cli.maxTurns,
        maxBudgetUsd: effectiveBudget,
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error(`AI query failed: ${errorMsg}`);

      this.stateManager.transitionSession(session.id, "failed", errorMsg);
      this.stateManager.transitionIssue(
        issue.id,
        "abandoned",
        `AI failed: ${errorMsg}`,
        session.id
      );

      return {
        success: false,
        issue,
        session: this.stateManager.getSession(session.id)!,
        error: errorMsg,
        metrics: {
          turns: 0,
          durationMs: Date.now() - startTime,
          costUsd: 0,
          filesChanged: 0,
          linesChanged: 0,
        },
      };
    }

    // Update session metrics
    const metricsUpdate: { turnCount?: number; costUsd?: number } = {
      turnCount: queryResult.turns,
    };
    if (queryResult.costUsd !== undefined) {
      metricsUpdate.costUsd = queryResult.costUsd;
    }
    this.stateManager.updateSessionMetrics(session.id, metricsUpdate);

    if (!queryResult.success) {
      logger.error(`AI query failed: ${queryResult.error}`);
      this.stateManager.transitionSession(
        session.id,
        "failed",
        queryResult.error ?? "Unknown error"
      );
      this.stateManager.transitionIssue(
        issue.id,
        "abandoned",
        `AI failed: ${queryResult.error}`,
        session.id
      );

      const failResult: ProcessIssueResult = {
        success: false,
        issue,
        session: this.stateManager.getSession(session.id)!,
        metrics: {
          turns: queryResult.turns,
          durationMs: queryResult.durationMs,
          costUsd: queryResult.costUsd ?? 0,
          filesChanged: 0,
          linesChanged: 0,
        },
      };
      if (queryResult.error !== undefined) {
        failResult.error = queryResult.error;
      }
      return failResult;
    }

    // Get diff statistics
    const diffStats = await this.gitOps.getDiffStats(worktreePath, defaultBranch);
    logger.info(
      `Changes: ${diffStats.files} files, +${diffStats.insertions} -${diffStats.deletions}`
    );

    // Check quality gates
    const qualityCheck = await this.checkQualityGates(worktreePath, diffStats);
    if (!qualityCheck.passed) {
      logger.warn(`Quality gates failed: ${qualityCheck.reason}`);
      this.stateManager.transitionSession(session.id, "failed", qualityCheck.reason);
      this.stateManager.transitionIssue(
        issue.id,
        "abandoned",
        `Quality gates failed: ${qualityCheck.reason}`,
        session.id
      );

      return {
        success: false,
        issue,
        session: this.stateManager.getSession(session.id)!,
        error: qualityCheck.reason,
        metrics: {
          turns: queryResult.turns,
          durationMs: queryResult.durationMs,
          costUsd: queryResult.costUsd ?? 0,
          filesChanged: diffStats.files,
          linesChanged: diffStats.insertions + diffStats.deletions,
        },
      };
    }

    // Commit changes (if there are uncommitted changes)
    // Note: Claude may have already committed the changes
    logger.step(5, 6, "Committing changes...");
    const hasUncommittedChanges = await this.gitOps.hasUncommittedChanges(worktreePath);
    if (hasUncommittedChanges) {
      const commitMessage = this.buildCommitMessage(issueNumber, issueData.title);
      await this.gitOps.commit(worktreePath, commitMessage);
    } else {
      logger.debug("No uncommitted changes - Claude may have already committed");
    }

    // Run local tests and fix before pushing (if tests exist)
    logger.step(6, 7, "Running local tests before push...");
    const localTestResult = await this.runLocalTestsWithFix(
      worktreePath,
      branchName,
      issueData,
      owner,
      repo,
      queryResult.sessionId
    );

    if (!localTestResult.success) {
      logger.warn(`Local tests failed after ${this.maxLocalTestFixIterations} fix attempts`);
      logger.warn(`Last error: ${localTestResult.lastError}`);
      // Continue to push anyway - CI will catch remaining issues
    }

    // Re-commit if there were fixes
    if (localTestResult.fixesApplied > 0) {
      const hasNewChanges = await this.gitOps.hasUncommittedChanges(worktreePath);
      if (hasNewChanges) {
        const fixCommitMessage = `fix: Address test failures for #${issueNumber}`;
        await this.gitOps.commit(worktreePath, fixCommitMessage);
        logger.info(`Committed ${localTestResult.fixesApplied} test fix(es)`);
      }
    }

    // Push branch (to fork remote if using fork workflow)
    logger.step(7, 7, "Pushing branch...");
    await this.gitOps.push(worktreePath, branchName, { remote: pushRemote });

    // Create PR (if not skipped)
    let prUrl: string | undefined;
    if (!options.skipPR) {
      logger.info("Creating pull request...");
      prUrl = await this.createPullRequest(
        owner,
        repo,
        branchName,
        issueData,
        defaultBranch,
        isFork ? pushOwner : undefined,
        worktreePath,
        diffStats,
        issueNumber
      );

      this.stateManager.updateSessionMetrics(session.id, { prUrl });
      this.stateManager.transitionIssue(issue.id, "pr_created", `PR created: ${prUrl}`, session.id);
      issue.state = "pr_created";
      issue.hasLinkedPR = true;
      issue.linkedPRUrl = prUrl;
      this.stateManager.saveIssue(issue);
      this.stateManager.saveIssue(issue);
    }

    // Wait for CI checks and auto-fix if enabled
    let ciResult: CIHandlerResult | undefined;
    const ciConfig = this.config.oss?.qualityGates?.ciChecks;
    const shouldWaitForCI = options.waitForCIChecks ?? ciConfig?.waitForChecks ?? true;
    const shouldAutoFixCI = options.autoFixCI ?? ciConfig?.autoFixFailedChecks ?? true;

    if (!options.skipPR && prUrl && shouldWaitForCI) {
      logger.info("Waiting for CI checks...");
      try {
        const prService = new PRService();
        const parsed = prService.parsePRUrl(prUrl);

        if (parsed) {
          const ciHandler = new CICheckHandler(prService, this.gitOps, this.aiProvider);

          ciResult = await ciHandler.handleChecks(
            parsed.owner,
            parsed.repo,
            parsed.prNumber,
            worktreePath,
            branchName,
            {
              maxIterations: ciConfig?.maxFixIterations ?? 3,
              waitForChecks: true,
              autoFix: shouldAutoFixCI,
              timeoutMs: ciConfig?.timeoutMs ?? 30 * 60 * 1000,
              pollIntervalMs: ciConfig?.pollIntervalMs ?? 30 * 1000,
              initialDelayMs: ciConfig?.initialDelayMs ?? 15 * 1000,
              maxBudgetPerFix: ciConfig?.maxBudgetPerFix ?? 2,
              pushRemote,
              // Resume from the session that did the initial work for CI fixes
              resumeSessionId: queryResult.sessionId,
              // Allow more turns for CI fixes (may need to update many files)
              maxTurnsPerFix: 50,
            }
          );

          if (ciResult.finalStatus === "success") {
            logger.success("All CI checks passed!");
          } else if (ciResult.finalStatus === "no_checks") {
            logger.info("No CI checks configured for this repository");
          } else {
            logger.warn(`CI handling finished with status: ${ciResult.finalStatus}`);
            logger.info(ciResult.summary);
          }
        }
      } catch (error) {
        logger.error(`CI check handling failed: ${error}`);
      }
    }

    // Run automated review AFTER CI passes (if enabled and CI succeeded or no checks)
    const reviewConfig = this.config.oss?.qualityGates?.review;
    const shouldRunReview = options.review ?? reviewConfig?.enabled ?? true;
    const ciPassed =
      !ciResult || ciResult.finalStatus === "success" || ciResult.finalStatus === "no_checks";

    logger.debug("Review check", {
      skipPR: options.skipPR,
      shouldRunReview,
      prUrl: !!prUrl,
      hasReviewService: !!this.reviewService,
      ciPassed,
      ciStatus: ciResult?.finalStatus,
    });

    if (!options.skipPR && shouldRunReview && prUrl && this.reviewService && ciPassed) {
      if (ciResult?.selfHealed) {
        logger.info(
          "CI passed after self-healing (no code changes needed). Running automated review..."
        );
      } else {
        logger.info("Running automated review...");
      }
      try {
        const reviewResult = await this.reviewService.review({
          prUrl,
          autoFix: reviewConfig?.autoFix ?? true,
          postComment: reviewConfig?.postComment ?? true,
          postApproval: reviewConfig?.postApproval ?? false,
          maxBudgetUsd: reviewConfig?.maxBudgetUsd ?? 2,
        });

        if (reviewResult.approved) {
          logger.success("PR approved by automated reviewer");
        } else {
          logger.warn(`PR has ${reviewResult.blockers.length} blocking issues`);
        }
      } catch (error) {
        logger.error(`Automated review failed: ${error}`);
      }
    }

    // Mark session as completed
    this.stateManager.transitionSession(session.id, "completed", "Successfully processed issue");

    // Save work record
    const workRecord: IssueWorkRecord = {
      issueId: issue.id,
      sessionId: session.id,
      branchName,
      worktreePath,
      attempts: 1,
      lastAttemptAt: new Date(),
      totalCostUsd: queryResult.costUsd ?? 0,
    };
    if (prUrl !== undefined) {
      workRecord.prUrl = prUrl;
    }
    this.stateManager.saveWorkRecord(workRecord);

    const durationMs = Date.now() - startTime;
    logger.success(`Issue processed successfully in ${(durationMs / 1000).toFixed(1)}s`);
    if (prUrl) {
      logger.info(`PR: ${prUrl}`);
    }

    const result: ProcessIssueResult = {
      success: true,
      issue,
      session: this.stateManager.getSession(session.id)!,
      metrics: {
        turns: queryResult.turns,
        durationMs,
        costUsd: queryResult.costUsd ?? 0,
        filesChanged: diffStats.files,
        linesChanged: diffStats.insertions + diffStats.deletions,
      },
    };
    if (prUrl !== undefined) {
      result.prUrl = prUrl;
    }
    if (ciResult !== undefined) {
      result.ciResult = ciResult;
    }
    return result;
  }

  /**
   * Parse a GitHub issue URL
   */
  private parseIssueUrl(url: string): { owner: string; repo: string; issueNumber: number } | null {
    // Match: https://github.com/owner/repo/issues/123
    const match = url.match(/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/);
    if (!match) return null;

    return {
      owner: match[1]!,
      repo: match[2]!,
      issueNumber: parseInt(match[3]!, 10),
    };
  }

  /**
   * Fetch issue data from GitHub
   */
  private async fetchIssueData(
    owner: string,
    repo: string,
    issueNumber: number
  ): Promise<{
    title: string;
    body: string;
    labels: string[];
    author: string;
    assignee: string | null;
    createdAt: string;
    updatedAt: string;
  }> {
    // Use gh CLI to fetch issue data
    const { spawn } = await import("node:child_process");

    return new Promise((resolve, reject) => {
      const proc = spawn("gh", [
        "issue",
        "view",
        String(issueNumber),
        "--repo",
        `${owner}/${repo}`,
        "--json",
        "title,body,labels,author,assignees,createdAt,updatedAt",
      ]);

      let stdout = "";
      let stderr = "";
      let timedOut = false;

      // Add timeout for gh command
      const timeoutId = setTimeout(() => {
        timedOut = true;
        proc.kill("SIGTERM");
        setTimeout(() => {
          if (!proc.killed) {
            proc.kill("SIGKILL");
          }
        }, 5000);
      }, GH_COMMAND_TIMEOUT_MS);

      const cleanup = (): void => {
        clearTimeout(timeoutId);
      };

      proc.stdout.on("data", (data: Buffer) => {
        stdout += data.toString();
      });

      proc.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on("close", (code) => {
        cleanup();
        if (timedOut) {
          reject(
            new Error(
              `gh issue view timed out after ${GH_COMMAND_TIMEOUT_MS / 1000}s for ${owner}/${repo}#${issueNumber}`
            )
          );
          return;
        }
        if (code === 0) {
          try {
            const data = JSON.parse(stdout) as {
              title: string;
              body: string;
              labels: { name: string }[];
              author: { login: string };
              assignees: { login: string }[];
              createdAt: string;
              updatedAt: string;
            };

            resolve({
              title: data.title,
              body: data.body ?? "",
              labels: data.labels.map((l) => l.name),
              author: data.author.login,
              assignee: data.assignees[0]?.login ?? null,
              createdAt: data.createdAt,
              updatedAt: data.updatedAt,
            });
          } catch (error) {
            reject(new Error(`Failed to parse issue data: ${error}`));
          }
        } else {
          reject(new Error(`gh issue view failed: ${stderr}`));
        }
      });

      proc.on("error", (error) => {
        cleanup();
        reject(new Error(`Failed to spawn gh: ${error.message}`));
      });
    });
  }

  /**
   * Build the prompt for the AI
   */
  private buildPrompt(
    issueData: { title: string; body: string; labels: string[] },
    owner: string,
    repo: string,
    branchName: string
  ): string {
    return `You are working on a fix for a GitHub issue in the repository ${owner}/${repo}.

## Issue Details

**Title:** ${issueData.title}

**Description:**
${issueData.body || "No description provided."}

**Labels:** ${issueData.labels.join(", ") || "None"}

## Your Task

1. **Analyze the issue** - Understand what needs to be fixed or implemented
2. **Explore the codebase** - Find relevant files and understand the code structure
3. **Implement the fix** - Make the necessary changes
4. **Test your changes** - Run any relevant tests to ensure the fix works
5. **Ensure code quality** - Make sure the code follows project conventions

## Important Guidelines

- Make minimal, focused changes that address the issue directly
- Follow existing code style and patterns
- Add comments only if the logic is complex
- Do not modify unrelated code
- If tests exist, make sure they pass
- If a linter is configured, ensure no new errors

## Branch Information

You are working on branch: \`${branchName}\`

Begin by reading the issue carefully and exploring the relevant parts of the codebase.`;
  }

  /**
   * Build commit message
   */
  private buildCommitMessage(issueNumber: number, issueTitle: string): string {
    // Truncate title if too long
    const maxTitleLength = 50;
    let title = issueTitle;
    if (title.length > maxTitleLength) {
      title = title.slice(0, maxTitleLength - 3) + "...";
    }

    return `fix: ${title} (#${issueNumber})

Fixes #${issueNumber}

---
Changes prepared with assistance from OSS-Agent`;
  }

  /**
   * Check quality gates
   */
  private async checkQualityGates(
    worktreePath: string,
    diffStats: { files: number; insertions: number; deletions: number }
  ): Promise<{ passed: boolean; reason: string }> {
    const gates = this.config.oss?.qualityGates;
    if (!gates) {
      return { passed: true, reason: "No quality gates configured" };
    }

    // Check file count
    if (diffStats.files > gates.maxFilesChanged) {
      return {
        passed: false,
        reason: `Too many files changed: ${diffStats.files} > ${gates.maxFilesChanged}`,
      };
    }

    // Check lines changed
    const totalLines = diffStats.insertions + diffStats.deletions;
    if (totalLines > gates.maxLinesChanged) {
      return {
        passed: false,
        reason: `Too many lines changed: ${totalLines} > ${gates.maxLinesChanged}`,
      };
    }

    // Test execution check
    if (gates.requireTestsPass) {
      const testCmd = this.detectTestCommand(worktreePath);
      if (testCmd) {
        logger.info(`Running tests: ${testCmd}`);
        const testResult = await this.runCommand(testCmd, worktreePath);
        if (!testResult.success) {
          const truncatedOutput = testResult.output.slice(0, 500);
          return {
            passed: false,
            reason: `Tests failed:\n${truncatedOutput}`,
          };
        }
        logger.debug("Tests passed");
      } else {
        logger.debug("No test command detected, skipping test check");
      }
    }

    // Lint check
    if (gates.requireLintPass) {
      const lintCmd = this.detectLintCommand(worktreePath);
      if (lintCmd) {
        logger.info(`Running linter: ${lintCmd}`);
        const lintResult = await this.runCommand(lintCmd, worktreePath);
        if (!lintResult.success) {
          const truncatedOutput = lintResult.output.slice(0, 500);
          return {
            passed: false,
            reason: `Lint failed:\n${truncatedOutput}`,
          };
        }
        logger.debug("Lint passed");
      } else {
        logger.debug("No lint command detected, skipping lint check");
      }
    }

    logger.debug(`Quality gates passed for ${worktreePath}`);
    return { passed: true, reason: "All gates passed" };
  }

  /**
   * Detect the test command for a project
   */
  private detectTestCommand(worktreePath: string): string | null {
    // Check for Node.js project
    const packageJsonPath = join(worktreePath, "package.json");
    if (existsSync(packageJsonPath)) {
      try {
        const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as {
          scripts?: Record<string, string>;
        };
        const testScript = pkg.scripts?.["test"];
        // Skip placeholder test scripts
        if (testScript && !testScript.includes("no test specified") && testScript !== "exit 0") {
          // Check if using npm or pnpm or yarn
          if (existsSync(join(worktreePath, "pnpm-lock.yaml"))) {
            return "pnpm test";
          } else if (existsSync(join(worktreePath, "yarn.lock"))) {
            return "yarn test";
          }
          return "npm test";
        }
      } catch {
        // Ignore parse errors
      }
    }

    // Check for Python project
    if (
      existsSync(join(worktreePath, "pytest.ini")) ||
      existsSync(join(worktreePath, "pyproject.toml")) ||
      existsSync(join(worktreePath, "setup.py"))
    ) {
      if (existsSync(join(worktreePath, "tests"))) {
        return "python -m pytest";
      }
    }

    // Check for Rust project
    if (existsSync(join(worktreePath, "Cargo.toml"))) {
      return "cargo test";
    }

    // Check for Go project
    if (existsSync(join(worktreePath, "go.mod"))) {
      return "go test ./...";
    }

    return null;
  }

  /**
   * Detect the lint command for a project
   */
  private detectLintCommand(worktreePath: string): string | null {
    // Check for Node.js project
    const packageJsonPath = join(worktreePath, "package.json");
    if (existsSync(packageJsonPath)) {
      try {
        const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as {
          scripts?: Record<string, string>;
        };
        if (pkg.scripts?.["lint"]) {
          if (existsSync(join(worktreePath, "pnpm-lock.yaml"))) {
            return "pnpm run lint";
          } else if (existsSync(join(worktreePath, "yarn.lock"))) {
            return "yarn lint";
          }
          return "npm run lint";
        }
      } catch {
        // Ignore parse errors
      }

      // Check for ESLint config files
      const eslintConfigs = [
        ".eslintrc.js",
        ".eslintrc.cjs",
        ".eslintrc.json",
        ".eslintrc.yaml",
        ".eslintrc.yml",
        "eslint.config.js",
        "eslint.config.mjs",
      ];
      for (const config of eslintConfigs) {
        if (existsSync(join(worktreePath, config))) {
          return "npx eslint .";
        }
      }
    }

    // Check for Python linters
    if (existsSync(join(worktreePath, "pyproject.toml"))) {
      // Check for ruff in pyproject.toml
      try {
        const content = readFileSync(join(worktreePath, "pyproject.toml"), "utf-8");
        if (content.includes("[tool.ruff]")) {
          return "ruff check .";
        }
        if (content.includes("[tool.flake8]") || content.includes("[flake8]")) {
          return "flake8 .";
        }
      } catch {
        // Ignore read errors
      }
    }

    // Check for Rust
    if (existsSync(join(worktreePath, "Cargo.toml"))) {
      return "cargo clippy";
    }

    // Check for Go
    if (existsSync(join(worktreePath, "go.mod"))) {
      return "golangci-lint run";
    }

    return null;
  }

  /**
   * Run a command and return success/output
   */
  private runCommand(cmd: string, cwd: string): Promise<{ success: boolean; output: string }> {
    return new Promise((resolve) => {
      const proc = spawn("sh", ["-c", cmd], {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, CI: "true" }, // Set CI=true for predictable output
      });

      let output = "";
      let timeoutId: ReturnType<typeof setTimeout> | undefined;

      // Set timeout to prevent hanging
      timeoutId = setTimeout(() => {
        proc.kill("SIGTERM");
        output += "\n[Command timed out]";
      }, COMMAND_TIMEOUT_MS);

      proc.stdout.on("data", (data: Buffer) => {
        output += data.toString();
      });

      proc.stderr.on("data", (data: Buffer) => {
        output += data.toString();
      });

      proc.on("close", (code) => {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        resolve({ success: code === 0, output });
      });

      proc.on("error", (err) => {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        resolve({ success: false, output: err.message });
      });
    });
  }

  /**
   * Run local tests and have AI fix failures before pushing
   * Returns success if tests pass (or no tests exist)
   */
  private async runLocalTestsWithFix(
    worktreePath: string,
    branchName: string,
    issueData: { title: string; body: string },
    owner: string,
    repo: string,
    resumeSessionId?: string
  ): Promise<{ success: boolean; fixesApplied: number; lastError?: string }> {
    const testCmd = this.detectTestCommand(worktreePath);

    if (!testCmd) {
      logger.debug("No test command detected, skipping local test check");
      return { success: true, fixesApplied: 0 };
    }

    let fixesApplied = 0;
    let lastError: string | undefined;

    const maxIterations = this.maxLocalTestFixIterations;
    for (let iteration = 0; iteration < maxIterations; iteration++) {
      logger.info(`Running local tests (attempt ${iteration + 1}/${maxIterations}): ${testCmd}`);

      const testResult = await this.runCommand(testCmd, worktreePath);

      if (testResult.success) {
        logger.success("Local tests passed!");
        return { success: true, fixesApplied };
      }

      // Tests failed - try to fix
      lastError = testResult.output.slice(-2000); // Keep last 2000 chars
      logger.warn(`Tests failed on attempt ${iteration + 1}`);

      if (iteration === maxIterations - 1) {
        // Last iteration, don't try to fix
        break;
      }

      // Ask AI to fix the test failures
      logger.info("Asking AI to fix test failures...");

      const fixPrompt = `The tests are failing in this repository. Please analyze the error output and fix the issues.

## Test Command
\`${testCmd}\`

## Error Output
\`\`\`
${testResult.output.slice(-3000)}
\`\`\`

## Context
This is for issue: ${issueData.title}
Branch: ${branchName}
Repository: ${owner}/${repo}

## Instructions
1. Analyze the test failures carefully
2. Fix the code that's causing the tests to fail
3. Make sure your fixes don't break the original functionality
4. If the tests are checking for something the implementation doesn't do correctly, fix the implementation
5. If the tests themselves have issues (like type errors), fix the tests

Focus on making the tests pass while maintaining the intent of the original changes.`;

      try {
        const queryOptions: Parameters<typeof this.aiProvider.query>[1] = {
          cwd: worktreePath,
          model: this.config.ai.model,
          maxTurns: 30,
          maxBudgetUsd: 2,
        };
        if (resumeSessionId) {
          queryOptions.resumeSessionId = resumeSessionId;
        }
        const fixResult = await this.aiProvider.query(fixPrompt, queryOptions);

        if (fixResult.success) {
          fixesApplied++;
          logger.info(`AI applied fix attempt ${fixesApplied}`);

          // Commit the fix before next test run
          const hasChanges = await this.gitOps.hasUncommittedChanges(worktreePath);
          if (hasChanges) {
            await this.gitOps.commit(
              worktreePath,
              `fix: Address test failures (attempt ${fixesApplied})`
            );
          }
        } else {
          logger.warn(`AI fix attempt failed: ${fixResult.error}`);
        }
      } catch (error) {
        logger.error(`AI fix request failed: ${error}`);
      }
    }

    const result: { success: boolean; fixesApplied: number; lastError?: string } = {
      success: false,
      fixesApplied,
    };
    if (lastError !== undefined) {
      result.lastError = lastError;
    }
    return result;
  }

  /**
   * Setup repository with fork support
   * Checks if user has push access, forks if needed
   *
   * Uses a per-repository lock to serialize clone/fetch operations
   * when multiple parallel processes work on the same repository.
   */
  private async setupRepository(owner: string, repo: string): Promise<CloneResult> {
    const repoUrl = `https://github.com/${owner}/${repo}.git`;

    // Get the path where this repo would be stored for locking purposes
    const repoPath = this.gitOps.getRepoPath(owner, repo);

    // Use repo lock to serialize clone/fetch operations
    return withRepoLock(repoPath, async () => {
      // Check if user has push access to the repository
      logger.debug(`Checking permissions for ${owner}/${repo}...`);
      const permissions = await this.repoService.checkPermissions(owner, repo);

      if (permissions.canPush) {
        logger.debug(`User has push access to ${owner}/${repo}`);
        return this.gitOps.clone(repoUrl, owner, repo);
      }

      // No push access - need to use fork workflow
      logger.info(`No push access to ${owner}/${repo}, setting up fork...`);

      // Fork the repository (or get existing fork)
      const { fork } = await this.repoService.forkRepo(owner, repo);
      const forkUrl = `https://github.com/${fork.owner}/${fork.name}.git`;

      // Clone with fork support
      return this.gitOps.cloneWithFork(repoUrl, owner, repo, fork.owner, forkUrl);
    });
  }

  /**
   * Create a pull request
   */
  private async createPullRequest(
    owner: string,
    repo: string,
    branchName: string,
    issueData: { title: string; body: string },
    baseBranch: string,
    forkOwner: string | undefined,
    worktreePath: string,
    diffStats: { files: number; insertions: number; deletions: number },
    issueNumber: number
  ): Promise<string> {
    const prTitle = `fix: ${issueData.title}`;

    // Get list of changed files for the PR body
    let changedFilesList = "";
    try {
      const { execSync } = await import("node:child_process");
      const filesOutput = execSync(`git diff --name-only ${baseBranch}...HEAD`, {
        cwd: worktreePath,
        encoding: "utf-8",
      }).trim();
      if (filesOutput) {
        const files = filesOutput.split("\n").slice(0, 10); // Limit to first 10 files
        changedFilesList = files.map((f) => `- \`${f}\``).join("\n");
        if (diffStats.files > 10) {
          changedFilesList += `\n- ... and ${diffStats.files - 10} more file(s)`;
        }
      }
    } catch {
      // Fall back to just stats if git command fails
      changedFilesList = `${diffStats.files} file(s) changed`;
    }

    const prBody = `## Summary

Fixes #${issueNumber}

## Changes

${changedFilesList}

**Stats:** ${diffStats.files} file(s) changed, +${diffStats.insertions} insertions, -${diffStats.deletions} deletions

---
🤖 Changes prepared with assistance from OSS-Agent`;

    // For fork-based PRs, head needs to be "forkOwner:branchName"
    const headRef = forkOwner ? `${forkOwner}:${branchName}` : branchName;

    return new Promise((resolve, reject) => {
      const proc = spawn("gh", [
        "pr",
        "create",
        "--repo",
        `${owner}/${repo}`,
        "--head",
        headRef,
        "--base",
        baseBranch,
        "--title",
        prTitle,
        "--body",
        prBody,
      ]);

      let stdout = "";
      let stderr = "";
      let timedOut = false;

      // Add timeout for gh command
      const timeoutId = setTimeout(() => {
        timedOut = true;
        proc.kill("SIGTERM");
        setTimeout(() => {
          if (!proc.killed) {
            proc.kill("SIGKILL");
          }
        }, 5000);
      }, GH_COMMAND_TIMEOUT_MS);

      const cleanup = (): void => {
        clearTimeout(timeoutId);
      };

      proc.stdout.on("data", (data: Buffer) => {
        stdout += data.toString();
      });

      proc.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on("close", (code) => {
        cleanup();
        if (timedOut) {
          reject(
            new Error(
              `gh pr create timed out after ${GH_COMMAND_TIMEOUT_MS / 1000}s for ${owner}/${repo}`
            )
          );
          return;
        }
        if (code === 0) {
          // gh pr create outputs the PR URL
          resolve(stdout.trim());
        } else {
          reject(new Error(`gh pr create failed: ${stderr}`));
        }
      });

      proc.on("error", (error) => {
        cleanup();
        reject(new Error(`Failed to spawn gh: ${error.message}`));
      });
    });
  }
}
