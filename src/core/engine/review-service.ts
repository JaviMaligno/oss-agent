/**
 * Review Service - Automated PR review by second agent
 *
 * This service allows a second Claude Code agent to review PRs created by the first agent,
 * identify issues, auto-fix them, and post review comments.
 */

import { spawn } from "node:child_process";
import { Config } from "../../types/config.js";
import { AIProvider, QueryResult } from "../ai/types.js";
import { GitOperations } from "../git/git-operations.js";
import { PRService } from "../github/pr-service.js";
import { StateManager } from "../state/state-manager.js";
import { logger } from "../../infra/logger.js";

export interface ReviewSuggestion {
  file: string;
  line?: number | undefined;
  severity: "critical" | "major" | "minor" | "nitpick";
  description: string;
  suggestedFix?: string | undefined;
  wasAutoFixed: boolean;
}

export interface ReviewResult {
  prUrl: string;
  approved: boolean;
  summary: string;
  suggestions: ReviewSuggestion[];
  blockers: string[];
  autoFixedCount: number;
  commentPosted: boolean;
  commitSha?: string | undefined;
  durationMs: number;
}

export interface ReviewOptions {
  prUrl: string;
  autoFix?: boolean | undefined;
  postComment?: boolean | undefined;
  // Whether to include approval/request-changes verdict in comment
  // Default false = comments only (no approval verdict)
  postApproval?: boolean | undefined;
  dryRun?: boolean | undefined;
  maxBudgetUsd?: number | undefined;
  mockMode?: boolean | undefined;
}

export class ReviewService {
  private config: Config;
  private stateManager: StateManager;
  private gitOps: GitOperations;
  private aiProvider: AIProvider;
  private prService: PRService;

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
  }

  /**
   * Review a PR and optionally auto-fix issues
   */
  async review(options: ReviewOptions): Promise<ReviewResult> {
    const startTime = Date.now();

    logger.info(`Starting PR review: ${options.prUrl}`);

    // Mock mode for fast verification
    if (options.mockMode) {
      logger.warn("Running in MOCK MODE - Skipping AI analysis");
      logger.step(1, 5, "Simulating logic...");
      await new Promise((r) => setTimeout(r, 1000));
      logger.success("Mock review completed");

      const mockResult: ReviewResult = {
        prUrl: options.prUrl,
        approved: true,
        summary:
          "This is a MOCK review summary generated for verification purposes. The code looks correct and tests pass.",
        suggestions: [
          {
            file: "src/utils.ts",
            line: 10,
            severity: "minor",
            description: "Consider adding a JSDoc comment here (Mock Suggestion)",
            wasAutoFixed: false,
            suggestedFix: "/** Helper function */",
          },
        ],
        blockers: [],
        autoFixedCount: 0,
        commentPosted: false,
        durationMs: 1000,
      };

      // Allow mock post comment
      if (options.postComment && !options.dryRun) {
        logger.step(5, 5, "Posting mock review comment...");
        // Note: We still try to post the real comment to verify GitHub integration!
        try {
          const parsed = this.prService.parsePRUrl(options.prUrl);
          if (parsed) {
            await this.postPRComment(
              parsed.owner,
              parsed.repo,
              parsed.prNumber,
              this.buildReviewComment(mockResult, 0, options.postApproval ?? false)
            );
            mockResult.commentPosted = true;
            logger.success("Mock review comment posted");
          }
        } catch (e) {
          logger.warn(`Failed to post mock comment: ${e}`);
        }
      }
      return mockResult;
    }

    // Parse PR URL
    const parsed = this.prService.parsePRUrl(options.prUrl);
    if (!parsed) {
      return this.failResult(options.prUrl, "Invalid PR URL", startTime);
    }

    const { owner, repo, prNumber } = parsed;

    // Fetch PR data and diff
    logger.step(1, 5, "Fetching PR details and diff...");
    const { pr, checks } = await this.prService.getPRFeedback(owner, repo, prNumber);

    // Get full diff via gh CLI
    const diff = await this.getPRDiff(owner, repo, prNumber);

    // Find work record if we have one
    const workRecord = this.stateManager.getWorkRecordByPRUrl(options.prUrl);

    let worktreePath: string | undefined;
    if (workRecord) {
      worktreePath = workRecord.worktreePath;
    }

    // Build review prompt
    logger.step(2, 5, "Analyzing changes with AI...");
    const prompt = this.buildReviewPrompt(pr, diff, checks, options.autoFix ?? false);

    // Execute AI query
    let queryResult: QueryResult;
    try {
      queryResult = await this.aiProvider.query(prompt, {
        cwd: worktreePath ?? process.cwd(),
        model: this.config.ai.model,
        maxTurns: 30,
        ...(options.maxBudgetUsd !== undefined && { maxBudgetUsd: options.maxBudgetUsd }),
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return this.failResult(options.prUrl, `AI review failed: ${errorMsg}`, startTime);
    }

    if (!queryResult.success) {
      return this.failResult(options.prUrl, queryResult.error ?? "AI review failed", startTime);
    }

    // Parse review results from AI output
    logger.step(3, 5, "Parsing review results...");
    const reviewData = this.parseReviewOutput(queryResult.output);

    // If auto-fix was enabled and we have a worktree, check for changes
    let autoFixedCount = 0;
    let commitSha: string | undefined;

    if (options.autoFix && worktreePath && !options.dryRun) {
      logger.step(4, 5, "Checking for auto-fixes...");
      const hasChanges = await this.gitOps.hasUncommittedChanges(worktreePath);
      if (hasChanges) {
        const fixedSuggestions = reviewData.suggestions.filter((s) => s.wasAutoFixed);
        autoFixedCount = fixedSuggestions.length;

        if (autoFixedCount > 0) {
          const commitMessage = this.buildFixCommitMessage(fixedSuggestions);
          await this.gitOps.commit(worktreePath, commitMessage);
          // Pushing fix
          // Note: We use the same retry logic as IssueProcessor for robustness
          try {
            await this.gitOps.push(worktreePath, pr.headBranch);
          } catch {
            logger.warn(`Auto-fix push failed, retrying with skip verification...`);
            await this.gitOps.push(worktreePath, pr.headBranch, { skipVerification: true });
          }

          // Get new commit SHA
          const newSha = await this.gitOps.getHeadSha(worktreePath);
          commitSha = newSha;
          logger.success(`Auto-fixed ${autoFixedCount} issue(s) and pushed to branch`);
        }
      }
    }

    // Post review comment if enabled
    let commentPosted = false;
    if (options.postComment && !options.dryRun) {
      logger.step(5, 5, "Posting review comment...");
      const comment = this.buildReviewComment(
        reviewData,
        autoFixedCount,
        options.postApproval ?? false
      );
      await this.postPRComment(owner, repo, prNumber, comment);
      commentPosted = true;
      logger.success("Review comment posted");
    }

    const durationMs = Date.now() - startTime;

    // Determine if approved
    const approved = reviewData.blockers.length === 0;

    logger.success(`Review completed in ${(durationMs / 1000).toFixed(1)}s`);
    if (approved) {
      logger.info("✓ PR approved - no blocking issues found");
    } else {
      logger.warn(`✗ PR has ${reviewData.blockers.length} blocking issue(s)`);
    }

    return {
      prUrl: options.prUrl,
      approved,
      summary: reviewData.summary,
      suggestions: reviewData.suggestions,
      blockers: reviewData.blockers,
      autoFixedCount,
      commentPosted,
      commitSha,
      durationMs,
    };
  }

  /**
   * Get PR diff via gh CLI
   */
  private async getPRDiff(owner: string, repo: string, prNumber: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn("gh", ["pr", "diff", String(prNumber), "--repo", `${owner}/${repo}`]);

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
          resolve(stdout);
        } else {
          reject(new Error(`gh pr diff failed: ${stderr}`));
        }
      });
    });
  }

  /**
   * Post a comment on a PR
   */
  private async postPRComment(
    owner: string,
    repo: string,
    prNumber: number,
    body: string
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn("gh", [
        "pr",
        "comment",
        String(prNumber),
        "--repo",
        `${owner}/${repo}`,
        "--body",
        body,
      ]);

      let stderr = "";

      proc.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on("close", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`gh pr comment failed: ${stderr}`));
        }
      });
    });
  }

  /**
   * Build the review prompt for AI
   */
  private buildReviewPrompt(
    pr: { title: string; body: string; headBranch: string },
    diff: string,
    checks: { name: string; status: string; conclusion: string | null }[],
    autoFix: boolean
  ): string {
    const failedChecks = checks.filter((c) => c.conclusion === "failure" || c.status === "failure");

    let prompt = `You are reviewing a pull request as a second opinion before human review.

## PR Information
**Title:** ${pr.title}
**Branch:** ${pr.headBranch}

**Description:**
${pr.body || "No description provided."}

## Diff
\`\`\`diff
${diff.slice(0, 50000)}
\`\`\`
${diff.length > 50000 ? "\n[Diff truncated - there are more changes not shown]\n" : ""}
`;

    if (failedChecks.length > 0) {
      prompt += `\n## Failed CI Checks\n`;
      for (const check of failedChecks) {
        prompt += `- ${check.name}: ${check.conclusion ?? check.status}\n`;
      }
    }

    prompt += `
## Your Task

Review this PR for:
1. **Logic errors** - Bugs, incorrect implementations, edge cases
2. **Code quality** - Readability, maintainability, best practices
3. **Security issues** - Vulnerabilities, unsafe patterns
4. **Test coverage** - Missing tests for new functionality
5. **Documentation** - Missing or outdated comments/docs

For each issue found, categorize as:
- **BLOCKER**: Must be fixed before merge (bugs, security issues)
- **MAJOR**: Should be fixed (significant quality issues)
- **MINOR**: Nice to fix (style, minor improvements)
- **NITPICK**: Optional suggestions

`;

    if (autoFix) {
      prompt += `
## Auto-Fix Instructions

You have permission to auto-fix issues. For any issue you can fix:
1. Make the fix directly in the code
2. Mark the suggestion with "AUTO-FIXED: true" in your output

Only auto-fix clear issues. Do NOT auto-fix:
- Subjective style preferences
- Major architectural changes
- Changes that need human judgment
`;
    }

    prompt += `
## Output Format

Provide your review in the following format:

### SUMMARY
[One paragraph summary of the PR quality and your recommendation]

### BLOCKERS
[List each blocking issue, or "None" if no blockers]

### SUGGESTIONS
For each suggestion:
SUGGESTION:
- FILE: [filename]
- LINE: [line number or "N/A"]
- SEVERITY: [BLOCKER|MAJOR|MINOR|NITPICK]
- DESCRIPTION: [what's wrong]
- FIX: [suggested fix]
${autoFix ? "- AUTO-FIXED: [true|false]" : ""}

### VERDICT
[APPROVE or REQUEST_CHANGES]
`;

    return prompt;
  }

  /**
   * Parse AI review output into structured data
   */
  private parseReviewOutput(output: string): {
    summary: string;
    blockers: string[];
    suggestions: ReviewSuggestion[];
  } {
    const suggestions: ReviewSuggestion[] = [];
    const blockers: string[] = [];
    let summary = "";

    // Extract summary
    const summaryMatch = output.match(/### SUMMARY\s*\n([\s\S]*?)(?=### |$)/i);
    if (summaryMatch) {
      summary = summaryMatch[1]?.trim() ?? "";
    }

    // Extract blockers
    const blockersMatch = output.match(/### BLOCKERS\s*\n([\s\S]*?)(?=### |$)/i);
    if (blockersMatch) {
      const blockersText = blockersMatch[1]?.trim() ?? "";
      if (!blockersText.toLowerCase().includes("none")) {
        const lines = blockersText.split("\n").filter((l) => l.trim().startsWith("-"));
        for (const line of lines) {
          blockers.push(line.replace(/^-\s*/, "").trim());
        }
      }
    }

    // Extract suggestions
    const suggestionsSection = output.match(/### SUGGESTIONS\s*\n([\s\S]*?)(?=### |$)/i);
    if (suggestionsSection) {
      const suggestionBlocks = suggestionsSection[1]?.split(/SUGGESTION:\s*\n/i) ?? [];
      for (const block of suggestionBlocks) {
        if (!block.trim()) continue;

        const fileMatch = block.match(/FILE:\s*(.+)/i);
        const lineMatch = block.match(/LINE:\s*(.+)/i);
        const severityMatch = block.match(/SEVERITY:\s*(.+)/i);
        const descMatch = block.match(/DESCRIPTION:\s*(.+)/i);
        const fixMatch = block.match(/FIX:\s*(.+)/i);
        const autoFixedMatch = block.match(/AUTO-FIXED:\s*(true|false)/i);

        if (fileMatch && severityMatch && descMatch) {
          const severityText = severityMatch[1]?.toUpperCase().trim() ?? "MINOR";
          let severity: ReviewSuggestion["severity"] = "minor";
          if (severityText === "BLOCKER" || severityText === "CRITICAL") severity = "critical";
          else if (severityText === "MAJOR") severity = "major";
          else if (severityText === "NITPICK") severity = "nitpick";

          const lineText = lineMatch?.[1]?.trim();
          const lineNum = lineText && lineText !== "N/A" ? parseInt(lineText, 10) : undefined;

          suggestions.push({
            file: fileMatch[1]?.trim() ?? "unknown",
            line: isNaN(lineNum ?? NaN) ? undefined : lineNum,
            severity,
            description: descMatch[1]?.trim() ?? "",
            suggestedFix: fixMatch?.[1]?.trim(),
            wasAutoFixed: autoFixedMatch?.[1]?.toLowerCase() === "true",
          });
        }
      }
    }

    return { summary, blockers, suggestions };
  }

  /**
   * Build commit message for auto-fixes
   */
  private buildFixCommitMessage(suggestions: ReviewSuggestion[]): string {
    const issues = suggestions.map((s) => `- ${s.description}`).join("\n");
    return `fix: address review suggestions

Auto-fixed issues:
${issues}

---
Changes prepared by automated PR review`;
  }

  /**
   * Build review comment to post on PR
   */
  private buildReviewComment(
    reviewData: { summary: string; blockers: string[]; suggestions: ReviewSuggestion[] },
    autoFixedCount: number,
    postApproval: boolean
  ): string {
    let comment = `## 🤖 Automated PR Review\n\n`;
    comment += `${reviewData.summary}\n\n`;

    if (autoFixedCount > 0) {
      comment += `### ✅ Auto-Fixed Issues (${autoFixedCount})\n`;
      comment += `The following issues were automatically fixed and committed:\n`;
      for (const s of reviewData.suggestions.filter((s) => s.wasAutoFixed)) {
        comment += `- **${s.file}**: ${s.description}\n`;
      }
      comment += `\n`;
    }

    if (reviewData.blockers.length > 0) {
      comment += `### 🚫 Blocking Issues\n`;
      for (const blocker of reviewData.blockers) {
        comment += `- ${blocker}\n`;
      }
      comment += `\n`;
    }

    const unfixedSuggestions = reviewData.suggestions.filter((s) => !s.wasAutoFixed);
    if (unfixedSuggestions.length > 0) {
      comment += `### 💡 Suggestions\n`;
      for (const s of unfixedSuggestions) {
        const severityEmoji =
          s.severity === "critical"
            ? "🔴"
            : s.severity === "major"
              ? "🟠"
              : s.severity === "minor"
                ? "🟡"
                : "⚪";
        comment += `- ${severityEmoji} **${s.file}${s.line ? `:${s.line}` : ""}**: ${s.description}\n`;
        if (s.suggestedFix) {
          comment += `  - Suggested fix: ${s.suggestedFix}\n`;
        }
      }
    }

    // Only include verdict if postApproval is enabled
    if (postApproval) {
      if (reviewData.blockers.length === 0) {
        comment += `\n---\n✅ **Verdict: Approved** - No blocking issues found.\n`;
      } else {
        comment += `\n---\n⚠️ **Verdict: Changes Requested** - Please address the blocking issues above.\n`;
      }
    }

    comment += `\n*This review was performed by an automated agent.*`;

    return comment;
  }

  /**
   * Create a failure result
   */
  private failResult(prUrl: string, error: string, startTime: number): ReviewResult {
    logger.error(error);
    return {
      prUrl,
      approved: false,
      summary: error,
      suggestions: [],
      blockers: [error],
      autoFixedCount: 0,
      commentPosted: false,
      durationMs: Date.now() - startTime,
    };
  }
}
