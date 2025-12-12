import { logger } from "../../infra/logger.js";
import { withRepoLock } from "../../infra/repo-lock.js";
import { StateManager } from "../state/state-manager.js";
import { GitOperations, CloneResult } from "../git/git-operations.js";
import { AIProvider, QueryResult } from "../ai/types.js";
import { RepoService } from "../github/repo-service.js";
import { RateLimiter } from "./rate-limiter.js";
import { BudgetManager } from "./budget-manager.js";
import { Issue, IssueWorkRecord } from "../../types/issue.js";
import { Session } from "../../types/session.js";
import { Config } from "../../types/config.js";

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
}

export interface ProcessIssueResult {
  success: boolean;
  issue: Issue;
  session: Session;
  prUrl?: string;
  error?: string;
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

  constructor(
    private config: Config,
    private stateManager: StateManager,
    private gitOps: GitOperations,
    private aiProvider: AIProvider
  ) {
    this.repoService = new RepoService();
    // Initialize rate limiter if quality gates are configured
    if (config.oss?.qualityGates) {
      this.rateLimiter = new RateLimiter(stateManager, config.oss.qualityGates);
    }
    // Initialize budget manager
    this.budgetManager = new BudgetManager(stateManager, config.budget);
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
        defaultBranch
      );

      // Create worktree for isolated work
      logger.step(3, 6, "Setting up worktree...");
      const worktreePath = await this.gitOps.createWorktree(repoPath, branchName, issue.id);

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

    // Push branch (to fork remote if using fork workflow)
    logger.step(6, 6, "Pushing branch...");
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
        isFork ? pushOwner : undefined
      );

      this.stateManager.updateSessionMetrics(session.id, { prUrl });
      this.stateManager.transitionIssue(issue.id, "pr_created", `PR created: ${prUrl}`, session.id);
      issue.state = "pr_created";
      issue.hasLinkedPR = true;
      issue.linkedPRUrl = prUrl;
      this.stateManager.saveIssue(issue);
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

      proc.stdout.on("data", (data: Buffer) => {
        stdout += data.toString();
      });

      proc.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on("close", (code) => {
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

    // TODO: Add test execution check (gates.requireTestsPass)
    // TODO: Add lint check (gates.requireLintPass)

    logger.debug(`Quality gates passed for ${worktreePath}`);
    return { passed: true, reason: "All gates passed" };
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
    forkOwner?: string
  ): Promise<string> {
    const { spawn } = await import("node:child_process");

    const prTitle = `fix: ${issueData.title}`;
    const prBody = `## Summary

This PR addresses the issue described below.

## Changes

<!-- A brief description of the changes will be auto-generated -->

## Original Issue

${issueData.body ? issueData.body.slice(0, 1000) : "No description provided."}

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

      proc.stdout.on("data", (data: Buffer) => {
        stdout += data.toString();
      });

      proc.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on("close", (code) => {
        if (code === 0) {
          // gh pr create outputs the PR URL
          resolve(stdout.trim());
        } else {
          reject(new Error(`gh pr create failed: ${stderr}`));
        }
      });
    });
  }
}
