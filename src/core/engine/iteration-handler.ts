/**
 * Iteration Handler - Processes PR feedback and creates new commits
 */

import { Config } from "../../types/config.js";
import type { Issue, IssueWorkRecord } from "../../types/issue.js";
import {
  ActionableFeedback,
  FeedbackParseResult,
  IterationResult,
  PullRequest,
} from "../../types/pr.js";
import { AIProvider, QueryResult } from "../ai/types.js";
import { GitOperations } from "../git/git-operations.js";
import { StateManager } from "../state/state-manager.js";
import { PRService } from "../github/pr-service.js";
import { FeedbackParser } from "../github/feedback-parser.js";
import { logger } from "../../infra/logger.js";

interface ExternalPRSetupResult {
  success: boolean;
  workRecord?: IssueWorkRecord;
  error?: string;
}

export interface IterationOptions {
  /** PR URL to iterate on */
  prUrl: string;
  /** Maximum budget for this iteration */
  maxBudgetUsd?: number;
  /** Only address specific feedback items (by ID) */
  feedbackIds?: string[];
  /** Don't push changes, just make them locally */
  dryRun?: boolean;
}

export class IterationHandler {
  private config: Config;
  private stateManager: StateManager;
  private gitOps: GitOperations;
  private aiProvider: AIProvider;
  private prService: PRService;
  private feedbackParser: FeedbackParser;

  constructor(
    config: Config,
    stateManager: StateManager,
    gitOps: GitOperations,
    aiProvider: AIProvider
  ) {
    this.config = config;
    this.stateManager = stateManager;
    this.gitOps = gitOps;
    this.aiProvider = aiProvider;
    this.prService = new PRService();
    this.feedbackParser = new FeedbackParser();
  }

  /**
   * Process feedback on a PR and create a new commit
   */
  async iterate(options: IterationOptions): Promise<IterationResult> {
    const startTime = Date.now();

    logger.info(`Starting iteration for PR: ${options.prUrl}`);

    // Parse PR URL
    const parsed = this.prService.parsePRUrl(options.prUrl);
    if (!parsed) {
      return this.failResult("Invalid PR URL", startTime);
    }

    const { owner, repo, prNumber } = parsed;

    // Fetch PR feedback
    logger.step(1, 5, "Fetching PR feedback...");
    let feedback: FeedbackParseResult;
    try {
      const { pr, reviews, comments, checks } = await this.prService.getPRFeedback(
        owner,
        repo,
        prNumber
      );
      feedback = this.feedbackParser.parse(pr, reviews, comments, checks);
    } catch (error) {
      return this.failResult(`Failed to fetch PR: ${error}`, startTime);
    }

    // Check if PR is still open
    if (feedback.pr.state !== "open") {
      return this.failResult(`PR is ${feedback.pr.state}, cannot iterate`, startTime);
    }

    // Filter feedback items if specific IDs requested
    let itemsToAddress = feedback.actionableItems.filter((item) => !item.addressed);
    if (options.feedbackIds && options.feedbackIds.length > 0) {
      itemsToAddress = itemsToAddress.filter((item) => options.feedbackIds!.includes(item.id));
    }

    if (itemsToAddress.length === 0) {
      logger.info("No actionable feedback to address");
      return {
        success: true,
        addressedItems: [],
        failedItems: [],
        newCommitSha: null,
        filesChanged: 0,
        metrics: {
          turns: 0,
          durationMs: Date.now() - startTime,
          costUsd: 0,
        },
      };
    }

    logger.info(`Found ${itemsToAddress.length} feedback item(s) to address`);

    // Find or create work record for this PR
    let workRecord = this.findWorkRecord(options.prUrl);

    if (!workRecord) {
      // Try to set up external PR
      logger.info("No work record found - setting up external PR...");
      const setupResult = await this.setupExternalPR(owner, repo, prNumber, feedback.pr);
      if (!setupResult.success) {
        return this.failResult(setupResult.error ?? "Failed to setup external PR", startTime);
      }
      workRecord = setupResult.workRecord!;
    }

    // Verify worktree exists
    const worktreeExists = await this.gitOps.worktreeExists(workRecord.worktreePath);
    if (!worktreeExists) {
      return this.failResult(`Worktree not found at ${workRecord.worktreePath}`, startTime);
    }

    // Get issue and session
    const issue = this.stateManager.getIssue(workRecord.issueId);
    if (!issue) {
      return this.failResult(`Issue ${workRecord.issueId} not found`, startTime);
    }

    // Update issue state if needed
    if (issue.state === "pr_created") {
      this.stateManager.transitionIssue(issue.id, "awaiting_feedback", "PR has received feedback");
    }

    // Create new session for this iteration
    logger.step(2, 5, "Creating iteration session...");
    const session = this.stateManager.createSession({
      issueId: issue.id,
      issueUrl: issue.url,
      status: "active",
      provider: this.aiProvider.name,
      model: this.config.ai.model ?? "default",
      startedAt: new Date(),
      lastActivityAt: new Date(),
      completedAt: null,
      turnCount: 0,
      costUsd: 0,
      prUrl: options.prUrl,
      workingDirectory: workRecord.worktreePath,
      canResume: true,
      error: null,
    });

    // Transition issue to iterating (skip if already iterating)
    if (issue.state !== "iterating") {
      this.stateManager.transitionIssue(
        issue.id,
        "iterating",
        `Addressing ${itemsToAddress.length} feedback item(s)`,
        session.id
      );
    }

    // Build prompt for AI
    const prompt = this.buildIterationPrompt(feedback, itemsToAddress, issue);

    // Execute AI query
    logger.step(3, 5, "Invoking AI to address feedback...");
    let queryResult: QueryResult;

    try {
      queryResult = await this.aiProvider.query(prompt, {
        cwd: workRecord.worktreePath,
        ...(this.config.ai.model && { model: this.config.ai.model }),
        maxTurns: this.config.ai.cli.maxTurns,
        maxBudgetUsd: options.maxBudgetUsd ?? this.config.budget.perIssueLimitUsd,
      });
    } catch (error) {
      this.stateManager.transitionSession(session.id, "failed", String(error));
      return this.failResult(`AI query failed: ${error}`, startTime);
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
      this.stateManager.transitionSession(
        session.id,
        "failed",
        queryResult.error ?? "Unknown error"
      );
      const failResult: IterationResult = {
        success: false,
        addressedItems: [],
        failedItems: itemsToAddress.map((item) => item.id),
        newCommitSha: null,
        filesChanged: 0,
        metrics: {
          turns: queryResult.turns,
          durationMs: Date.now() - startTime,
          costUsd: queryResult.costUsd ?? 0,
        },
      };
      if (queryResult.error !== undefined) {
        failResult.error = queryResult.error;
      }
      return failResult;
    }

    // Get diff statistics
    const diffStats = await this.gitOps.getDiffStats(
      workRecord.worktreePath,
      feedback.pr.baseBranch
    );

    if (diffStats.files === 0) {
      logger.warn("No changes made by AI");
      this.stateManager.transitionSession(session.id, "completed", "No changes made");
      return {
        success: true,
        addressedItems: [],
        failedItems: itemsToAddress.map((item) => item.id),
        newCommitSha: null,
        filesChanged: 0,
        metrics: {
          turns: queryResult.turns,
          durationMs: Date.now() - startTime,
          costUsd: queryResult.costUsd ?? 0,
        },
      };
    }

    logger.info(
      `Changes: ${diffStats.files} files, +${diffStats.insertions} -${diffStats.deletions}`
    );

    // Commit changes
    logger.step(4, 5, "Committing changes...");
    const commitMessage = this.buildCommitMessage(itemsToAddress);
    await this.gitOps.commit(workRecord.worktreePath, commitMessage);

    // Get new commit SHA
    const newCommitSha = await this.gitOps.getHeadSha(workRecord.worktreePath);

    // Push if not dry run
    if (!options.dryRun) {
      logger.step(5, 5, "Pushing changes...");
      await this.gitOps.push(workRecord.worktreePath, workRecord.branchName);
    } else {
      logger.info("Dry run - skipping push");
    }

    // Update session and issue state
    this.stateManager.transitionSession(session.id, "completed", "Iteration complete");
    this.stateManager.transitionIssue(
      issue.id,
      "pr_created",
      `Pushed iteration addressing ${itemsToAddress.length} item(s)`,
      session.id
    );

    // Update work record
    this.stateManager.saveWorkRecord({
      ...workRecord,
      attempts: workRecord.attempts + 1,
      lastAttemptAt: new Date(),
      totalCostUsd: workRecord.totalCostUsd + (queryResult.costUsd ?? 0),
    });

    const durationMs = Date.now() - startTime;
    logger.success(`Iteration complete in ${(durationMs / 1000).toFixed(1)}s`);

    return {
      success: true,
      addressedItems: itemsToAddress.map((item) => item.id),
      failedItems: [],
      newCommitSha,
      filesChanged: diffStats.files,
      metrics: {
        turns: queryResult.turns,
        durationMs,
        costUsd: queryResult.costUsd ?? 0,
      },
    };
  }

  /**
   * Build the prompt for addressing feedback
   */
  private buildIterationPrompt(
    feedback: FeedbackParseResult,
    items: ActionableFeedback[],
    issue: Issue
  ): string {
    const formattedFeedback = this.feedbackParser.formatForPrompt(items);

    return `You are addressing feedback on a pull request.

## Original Issue
**Title:** ${issue.title}
**Body:** ${issue.body}

## Pull Request
**Title:** ${feedback.pr.title}
**Branch:** ${feedback.pr.headBranch} -> ${feedback.pr.baseBranch}

## Current Status
${feedback.summary}

${formattedFeedback}

## Instructions

Please address the feedback items listed above. For each item:
1. Understand what change is being requested
2. Make the necessary code changes
3. Ensure the changes don't break existing functionality

After making changes:
- Run any relevant tests if they exist
- Ensure the code compiles/type-checks
- Keep changes focused on addressing the specific feedback

Do NOT:
- Make unrelated changes or "improvements"
- Change code style in unrelated areas
- Add features not requested in the feedback

Focus on addressing the feedback efficiently and correctly.`;
  }

  /**
   * Build commit message for iteration
   */
  private buildCommitMessage(items: ActionableFeedback[]): string {
    const types = new Set(items.map((item) => item.type));
    const typeList = Array.from(types).join(", ");

    const lines = [`Address PR feedback (${typeList})`, ""];

    // Group by type
    const byType = new Map<string, ActionableFeedback[]>();
    for (const item of items) {
      const existing = byType.get(item.type) ?? [];
      existing.push(item);
      byType.set(item.type, existing);
    }

    for (const [type, typeItems] of byType) {
      lines.push(`${type}:`);
      for (const item of typeItems) {
        lines.push(`  - ${item.description}`);
      }
    }

    return lines.join("\n");
  }

  /**
   * Set up an external PR for iteration (one not created by oss-agent)
   * Clones repo, fetches PR branch, creates worktree, and creates necessary records
   */
  private async setupExternalPR(
    owner: string,
    repo: string,
    prNumber: number,
    pr: PullRequest
  ): Promise<ExternalPRSetupResult> {
    try {
      // Get detailed PR info including fork details
      const prDetails = await this.prService.getPRDetails(owner, repo, prNumber);

      const headOwner = prDetails.headOwner;
      const headRepo = prDetails.headRepo;
      const headBranch = pr.headBranch;
      const isFork = headOwner !== owner;

      logger.debug(
        `PR from ${isFork ? "fork" : "same repo"}: ${headOwner}/${headRepo}:${headBranch}`
      );

      // Clone the base repo
      const repoUrl = `https://github.com/${owner}/${repo}.git`;
      const cloneResult = await this.gitOps.clone(repoUrl, owner, repo);

      // If PR is from a fork, add fork remote and fetch
      if (isFork) {
        const forkUrl = `https://github.com/${headOwner}/${headRepo}.git`;
        await this.gitOps.addRemote(cloneResult.path, "pr-source", forkUrl);
        await this.gitOps.fetch(cloneResult.path, "pr-source");
      } else {
        // Fetch origin to get latest branches
        await this.gitOps.fetch(cloneResult.path, "origin");
      }

      // Create worktree for the PR branch
      const worktreePath = await this.gitOps.createWorktreeFromRef(
        cloneResult.path,
        headBranch,
        `pr-${prNumber}`,
        isFork ? `pr-source/${headBranch}` : `origin/${headBranch}`
      );

      // Create a virtual issue for this external PR
      const projectId = `${owner}/${repo}`;
      const issueId = `${owner}/${repo}#${prNumber}`;
      const issueUrl = pr.linkedIssueUrl ?? pr.url;

      const issue: Issue = {
        id: issueId,
        url: issueUrl,
        number: prNumber,
        title: `[External PR] ${pr.title}`,
        body: pr.body,
        labels: [],
        state: "iterating",
        author: pr.author,
        assignee: null,
        createdAt: pr.createdAt,
        updatedAt: pr.updatedAt,
        projectId,
        hasLinkedPR: true,
        linkedPRUrl: pr.url,
      };

      this.stateManager.saveIssue(issue);

      // Create a session for this iteration
      const session = this.stateManager.createSession({
        issueId: issue.id,
        issueUrl: issue.url,
        status: "active",
        provider: this.aiProvider.name,
        model: this.config.ai.model ?? "default",
        startedAt: new Date(),
        lastActivityAt: new Date(),
        completedAt: null,
        turnCount: 0,
        costUsd: 0,
        prUrl: pr.url,
        workingDirectory: worktreePath,
        canResume: true,
        error: null,
      });

      // Create work record
      const workRecord: IssueWorkRecord = {
        issueId: issue.id,
        sessionId: session.id,
        branchName: headBranch,
        worktreePath,
        prNumber,
        prUrl: pr.url,
        attempts: 1,
        lastAttemptAt: new Date(),
        totalCostUsd: 0,
      };

      this.stateManager.saveWorkRecord(workRecord);

      logger.success(`External PR setup complete: ${worktreePath}`);

      return { success: true, workRecord };
    } catch (error) {
      logger.error(`Failed to setup external PR: ${error}`);
      return { success: false, error: String(error) };
    }
  }

  /**
   * Find work record for a PR URL
   */
  private findWorkRecord(prUrl: string): IssueWorkRecord | null {
    // Search all work records for matching PR URL
    const allRecords = this.stateManager.getAllWorkRecords();
    return allRecords.find((record) => record.prUrl === prUrl) ?? null;
  }

  /**
   * Create a failure result
   */
  private failResult(error: string, startTime: number): IterationResult {
    logger.error(error);
    return {
      success: false,
      addressedItems: [],
      failedItems: [],
      newCommitSha: null,
      filesChanged: 0,
      metrics: {
        turns: 0,
        durationMs: Date.now() - startTime,
        costUsd: 0,
      },
      error,
    };
  }
}
